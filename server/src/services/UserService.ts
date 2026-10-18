/**
 * Users: invite, update, role changes, location grants, deactivate.
 *
 * Only an OWNER may manage users or grant location access (BR-U6, BR-L4).
 *
 * Specification: docs/05-api-spec.md section 6, docs/14-multi-location.md section 7.
 */

import type { Prisma } from '@prisma/client'
import type { Actor, Role } from '@roombook/shared'
import { can } from '@roombook/shared'

import { prisma } from '../db.js'
import {
  AuthorizationError,
  NotFoundError,
  StateConflictError,
  ValidationError,
} from '../domain/errors.js'
import { destroyUserSessions } from '../middleware/session.js'
import * as audit from './AuditService.js'
import { sendInvitation } from './AuthService.js'

export interface LocationAccess {
  locationIds?: string[]
  allLocations?: boolean
}

export interface InviteInput {
  email: string
  fullName: string
  role?: Role
  homeLocationId?: string
  locationAccess?: LocationAccess
}

const userSelect = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  timezone: true,
  homeLocationId: true,
  lastLoginAt: true,
  lockedUntil: true,
  createdAt: true,
  homeLocation: { select: { id: true, name: true, timezone: true } },
  locationAccess: { select: { locationId: true, location: { select: { name: true } } } },
} satisfies Prisma.UserSelect

/** The directory. Employees see names and emails only — enough to pick attendees. */
export async function list(actor: Actor, opts: { includeDisabled?: boolean } = {}) {
  const isPrivileged = can(actor, 'user:invite', { organizationId: actor.organizationId })

  return prisma.user.findMany({
    where: {
      organizationId: actor.organizationId,
      ...(opts.includeDisabled && isPrivileged ? {} : { status: { in: ['ACTIVE', 'INVITED'] } }),
    },
    select: isPrivileged
      ? userSelect
      : { id: true, fullName: true, email: true, homeLocationId: true },
    orderBy: { fullName: 'asc' },
  })
}

export async function get(actor: Actor, id: string) {
  const privileged =
    can(actor, 'user:invite', { organizationId: actor.organizationId }) || actor.id === id
  if (!privileged) throw new AuthorizationError()

  const user = await prisma.user.findFirst({
    where: { id, organizationId: actor.organizationId },
    select: userSelect,
  })
  if (!user) throw new NotFoundError('That user')
  return user
}

/** Grants must name locations in this organization, or they mean nothing. */
async function resolveLocationIds(organizationId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const found = await prisma.location.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true },
  })
  if (found.length !== new Set(ids).size) {
    throw new ValidationError('One or more of those locations do not exist', {
      locationAccess: 'Unknown location',
    })
  }
  return found.map(l => l.id)
}

export async function invite(actor: Actor, input: InviteInput, ip?: string) {
  if (!can(actor, 'user:invite', { organizationId: actor.organizationId })) {
    throw new AuthorizationError('Only an owner can invite users')
  }

  const email = input.email.trim().toLowerCase()

  const existing = await prisma.user.findFirst({
    where: { organizationId: actor.organizationId, email },
    select: { id: true, status: true },
  })
  if (existing) {
    throw new ValidationError(
      existing.status === 'DISABLED'
        ? 'That person already has a deactivated account - reactivate it instead'
        : 'Someone with that email address already has an account',
      { email: 'Already in use' },
    )
  }

  if (input.homeLocationId) {
    await resolveLocationIds(actor.organizationId, [input.homeLocationId])
  }

  // Location grants only mean anything for an admin. Silently accepting them
  // for an employee would show a UI state that grants nothing.
  const role = input.role ?? 'EMPLOYEE'
  const grantIds =
    role === 'ADMIN' && input.locationAccess?.locationIds?.length
      ? await resolveLocationIds(actor.organizationId, input.locationAccess.locationIds)
      : []

  const user = await prisma.$transaction(async tx => {
    const created = await tx.user.create({
      data: {
        organizationId: actor.organizationId,
        email,
        fullName: input.fullName.trim(),
        role,
        status: 'INVITED',
        homeLocationId: input.homeLocationId ?? null,
        ...(grantIds.length
          ? { locationAccess: { create: grantIds.map(locationId => ({ locationId })) } }
          : {}),
      },
      select: userSelect,
    })

    await audit.record(
      {
        actor,
        eventType: 'USER_INVITED',
        entityType: 'user',
        entityId: created.id,
        after: { email, role, locationGrants: grantIds.length },
        ip,
      },
      tx,
    )

    return created
  })

  // Sent after the transaction commits: an invitation email for a user whose
  // creation then rolled back is a link to nowhere.
  await sendInvitation(user.id)

  return user
}

export async function resendInvitation(actor: Actor, id: string) {
  if (!can(actor, 'user:invite', { organizationId: actor.organizationId })) {
    throw new AuthorizationError()
  }
  const user = await prisma.user.findFirst({
    where: { id, organizationId: actor.organizationId },
    select: { id: true, status: true },
  })
  if (!user) throw new NotFoundError('That user')
  if (user.status !== 'INVITED') {
    throw new StateConflictError('That user has already accepted their invitation')
  }
  await sendInvitation(id)
  return { sent: true }
}

export interface UpdateUserInput {
  fullName?: string
  role?: Role
  timezone?: string | null
  homeLocationId?: string | null
  locationAccess?: LocationAccess
  emailOptOutReminders?: boolean
}

export async function update(actor: Actor, id: string, input: UpdateUserInput, ip?: string) {
  const before = await prisma.user.findFirst({
    where: { id, organizationId: actor.organizationId },
    select: { ...userSelect, organizationId: true },
  })
  if (!before) throw new NotFoundError('That user')

  const isSelf = actor.id === id
  const isOwnerAction = can(actor, 'user:changeRole', { organizationId: actor.organizationId })

  // A user may edit their own name and preferences; everything else is the
  // owner's to change.
  const wantsPrivilegedChange =
    input.role !== undefined || input.locationAccess !== undefined
  if (wantsPrivilegedChange && !isOwnerAction) {
    throw new AuthorizationError('Only an owner can change roles or location access')
  }
  if (!isSelf && !isOwnerAction) throw new AuthorizationError()

  // Nobody escalates their own privileges, whatever their role (BR-U7).
  if (isSelf && input.role !== undefined && input.role !== before.role) {
    throw new AuthorizationError('You cannot change your own role')
  }

  if (input.role !== undefined && before.role === 'OWNER' && input.role !== 'OWNER') {
    await assertNotLastOwner(before.organizationId, id)
  }

  if (input.homeLocationId) {
    await resolveLocationIds(actor.organizationId, [input.homeLocationId])
  }

  const data: Prisma.UserUpdateInput = {}
  if (input.fullName !== undefined) data.fullName = input.fullName.trim()
  if (input.role !== undefined) data.role = input.role
  if (input.timezone !== undefined) data.timezone = input.timezone
  if (input.homeLocationId !== undefined) {
    data.homeLocation = input.homeLocationId
      ? { connect: { id: input.homeLocationId } }
      : { disconnect: true }
  }
  if (input.emailOptOutReminders !== undefined) {
    data.emailOptOutReminders = input.emailOptOutReminders
  }

  const effectiveRole = input.role ?? (before.role as Role)
  const grantIds =
    input.locationAccess !== undefined
      ? effectiveRole === 'ADMIN'
        ? await resolveLocationIds(actor.organizationId, input.locationAccess.locationIds ?? [])
        : []
      : undefined

  const updated = await prisma.$transaction(async tx => {
    if (grantIds !== undefined) {
      // Grants are kept but inactive when the role changes away from ADMIN, so
      // restoring the role does not lose the configuration (docs/14 section 7).
      await tx.userLocationAccess.deleteMany({ where: { userId: id } })
      if (grantIds.length > 0) {
        await tx.userLocationAccess.createMany({
          data: grantIds.map(locationId => ({ userId: id, locationId })),
          skipDuplicates: true,
        })
      }
    }

    const row = await tx.user.update({ where: { id }, data, select: userSelect })

    const changes = audit.diff(
      before as unknown as Record<string, unknown>,
      data as Record<string, unknown>,
    )
    if (input.role !== undefined && input.role !== before.role) {
      await audit.record(
        {
          actor,
          eventType: 'USER_ROLE_CHANGED',
          entityType: 'user',
          entityId: id,
          before: { role: before.role },
          after: { role: input.role },
          ip,
        },
        tx,
      )
    } else if (changes) {
      await audit.record(
        {
          actor,
          eventType: 'USER_ROLE_CHANGED',
          entityType: 'user',
          entityId: id,
          before: changes.before,
          after: changes.after,
          ip,
        },
        tx,
      )
    }
    if (grantIds !== undefined) {
      await audit.record(
        {
          actor,
          eventType: 'USER_LOCATION_ACCESS_CHANGED',
          entityType: 'user',
          entityId: id,
          before: { locations: before.locationAccess.map(a => a.locationId) },
          after: { locations: grantIds },
          ip,
        },
        tx,
      )
    }

    return row
  })

  // A role or scope change alters what this person may do, so their existing
  // sessions must not continue under the old authority.
  if (input.role !== undefined && input.role !== before.role) {
    await destroyUserSessions(id)
  }

  return updated
}

/** The last owner cannot be demoted or deactivated, or nobody can administer. */
async function assertNotLastOwner(organizationId: string, userId: string): Promise<void> {
  const otherOwners = await prisma.user.count({
    where: { organizationId, role: 'OWNER', status: 'ACTIVE', id: { not: userId } },
  })
  if (otherOwners === 0) {
    throw new StateConflictError(
      'This is the only owner. Promote someone else to owner first.',
    )
  }
}

export async function setStatus(
  actor: Actor,
  id: string,
  status: 'ACTIVE' | 'DISABLED',
  force = false,
  ip?: string,
) {
  if (!can(actor, 'user:deactivate', { organizationId: actor.organizationId })) {
    throw new AuthorizationError('Only an owner can deactivate users')
  }

  const user = await prisma.user.findFirst({
    where: { id, organizationId: actor.organizationId },
    select: { id: true, email: true, role: true, status: true, organizationId: true },
  })
  if (!user) throw new NotFoundError('That user')

  if (status === 'DISABLED') {
    if (actor.id === id) {
      throw new StateConflictError('You cannot deactivate your own account')
    }
    if (user.role === 'OWNER') await assertNotLastOwner(user.organizationId, id)

    const futureBookings = await prisma.booking.count({
      where: {
        organizerId: id,
        status: { in: ['PENDING_APPROVAL', 'CONFIRMED'] },
        startsAt: { gt: new Date() },
      },
    })
    // The owner is shown what would be left behind and must confirm (BR-U5).
    if (futureBookings > 0 && !force) {
      throw new StateConflictError(
        `That user has ${futureBookings} future booking(s). Reassign or cancel them first, or deactivate with force.`,
      )
    }
  }

  const updated = await prisma.$transaction(async tx => {
    const row = await tx.user.update({
      where: { id },
      data: {
        status,
        ...(status === 'ACTIVE' ? { failedLoginCount: 0, lockedUntil: null } : {}),
      },
      select: userSelect,
    })
    await audit.record(
      {
        actor,
        eventType: 'USER_DEACTIVATED',
        entityType: 'user',
        entityId: id,
        before: { status: user.status },
        after: { status },
        ip,
      },
      tx,
    )
    return row
  })

  // Deactivation takes effect on the next request, not whenever the session
  // happens to expire (BR-U4, T-96).
  if (status === 'DISABLED') await destroyUserSessions(id)

  return updated
}
