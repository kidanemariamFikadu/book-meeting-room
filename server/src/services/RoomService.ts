/**
 * Rooms: runtime create, update, delete, activate, and feature management.
 *
 * Admins may act only within the locations they administer; an admin with no
 * grants is organization-wide (BR-L1, BR-L2). Every check goes through the
 * shared `can()`, so the server enforces exactly what the client renders.
 *
 * Specification: docs/05-api-spec.md section 3, docs/14-multi-location.md.
 */

import type { Prisma } from '@prisma/client'
import type { Actor } from '@roombook/shared'
import { can } from '@roombook/shared'

import { prisma } from '../db.js'
import {
  AuthorizationError,
  LocationForbiddenError,
  NotFoundError,
  StateConflictError,
  ValidationError,
} from '../domain/errors.js'
import * as audit from './AuditService.js'

export interface RoomLimits {
  minBookingMinutes?: number | null
  maxBookingMinutes?: number | null
  maxAdvanceDays?: number | null
  minNoticeMinutes?: number | null
}

export interface RoomHoursInput {
  weekday: number
  startLocal: string
  endLocal: string
}

export interface RoomInput {
  locationId: string
  name: string
  capacity: number
  floor?: string
  description?: string
  colour?: string
  featureIds?: string[]
  requiresApproval?: boolean
  approverUserId?: string | null
  approvalWindowHours?: number | null
  providerResourceEmail?: string | null
  limits?: RoomLimits
  hours?: RoomHoursInput[]
}

const roomInclude = {
  location: { select: { id: true, name: true, timezone: true, isActive: true } },
  features: { include: { feature: true } },
  hours: { orderBy: [{ weekday: 'asc' }, { startLocal: 'asc' }] },
  approver: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.RoomInclude

export interface ListRoomFilters {
  locationId?: string
  minCapacity?: number
  features?: string[]
  includeInactive?: boolean
  q?: string
}

export async function list(actor: Actor, filters: ListRoomFilters = {}) {
  return prisma.room.findMany({
    where: {
      organizationId: actor.organizationId,
      ...(filters.includeInactive ? {} : { isActive: true }),
      ...(filters.locationId ? { locationId: filters.locationId } : {}),
      ...(filters.minCapacity ? { capacity: { gte: filters.minCapacity } } : {}),
      ...(filters.q ? { name: { contains: filters.q, mode: 'insensitive' } } : {}),
      // Every requested feature must be present, not merely one of them: a
      // search for "projector and video" means a room with both.
      ...(filters.features?.length
        ? { AND: filters.features.map(id => ({ features: { some: { featureId: id } } })) }
        : {}),
    },
    include: roomInclude,
    orderBy: [{ location: { sortOrder: 'asc' } }, { capacity: 'asc' }, { name: 'asc' }],
  })
}

export async function get(actor: Actor, id: string) {
  const room = await prisma.room.findFirst({
    where: { id, organizationId: actor.organizationId },
    include: {
      ...roomInclude,
      closures: { where: { endsAt: { gte: new Date() } }, orderBy: { startsAt: 'asc' } },
    },
  })
  if (!room) throw new NotFoundError('That room')
  return room
}

/** Loads the location and confirms the actor administers it. */
async function assertLocationInScope(actor: Actor, locationId: string, action: 'room:create' | 'room:update') {
  const location = await prisma.location.findFirst({
    where: { id: locationId, organizationId: actor.organizationId },
    select: { id: true, name: true, isActive: true },
  })
  if (!location) {
    throw new ValidationError('That location does not exist', {
      locationId: 'Choose a location',
    })
  }
  if (!can(actor, action, { organizationId: actor.organizationId, locationId })) {
    throw new LocationForbiddenError(`You do not administer ${location.name}`)
  }
  return location
}

async function assertNameFree(
  organizationId: string,
  locationId: string,
  name: string,
  exceptId?: string,
) {
  // Unique per LOCATION, not per organization: two sites may both have a room
  // called "Boardroom" (BR-R1). Compared case-insensitively after trimming.
  const clash = await prisma.room.findFirst({
    where: {
      organizationId,
      locationId,
      name: { equals: name.trim(), mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  })
  if (clash) {
    throw new ValidationError('A room with that name already exists at this location', {
      name: 'That name is already used here',
    })
  }
}

/** Features must belong to the same organization, or they cannot be attached. */
async function assertFeaturesValid(organizationId: string, featureIds: string[]) {
  if (featureIds.length === 0) return
  const found = await prisma.roomFeature.count({
    where: { organizationId, id: { in: featureIds } },
  })
  if (found !== new Set(featureIds).size) {
    throw new ValidationError('One or more of those features do not exist', {
      featureIds: 'Unknown feature',
    })
  }
}

async function assertApproverValid(
  organizationId: string,
  approverUserId: string | null | undefined,
) {
  if (!approverUserId) return
  const approver = await prisma.user.findFirst({
    where: { id: approverUserId, organizationId, status: 'ACTIVE' },
    select: { role: true },
  })
  if (!approver) {
    throw new ValidationError('That approver does not exist', {
      approverUserId: 'Choose an active user',
    })
  }
  // An employee cannot approve: approval is an admin power, and naming one
  // would create a request nobody is able to action (docs/15 section 3).
  if (approver.role === 'EMPLOYEE') {
    throw new ValidationError('An approver must be an admin or owner', {
      approverUserId: 'Choose an admin or owner',
    })
  }
}

export async function create(actor: Actor, input: RoomInput, ip?: string) {
  await assertLocationInScope(actor, input.locationId, 'room:create')
  await assertNameFree(actor.organizationId, input.locationId, input.name)
  await assertFeaturesValid(actor.organizationId, input.featureIds ?? [])
  await assertApproverValid(actor.organizationId, input.approverUserId)

  const room = await prisma.$transaction(async tx => {
    const created = await tx.room.create({
      data: {
        organizationId: actor.organizationId,
        locationId: input.locationId,
        name: input.name.trim(),
        capacity: input.capacity,
        floor: input.floor?.trim() ?? null,
        description: input.description?.trim() ?? null,
        colour: input.colour ?? '#2f5fd0',
        requiresApproval: input.requiresApproval ?? false,
        approverUserId: input.approverUserId ?? null,
        approvalWindowHours: input.approvalWindowHours ?? null,
        providerResourceEmail: input.providerResourceEmail ?? null,
        minBookingMinutes: input.limits?.minBookingMinutes ?? null,
        maxBookingMinutes: input.limits?.maxBookingMinutes ?? null,
        maxAdvanceDays: input.limits?.maxAdvanceDays ?? null,
        minNoticeMinutes: input.limits?.minNoticeMinutes ?? null,
        ...(input.featureIds?.length
          ? { features: { create: input.featureIds.map(featureId => ({ featureId })) } }
          : {}),
        ...(input.hours?.length ? { hours: { create: input.hours } } : {}),
      },
      include: roomInclude,
    })

    await audit.record(
      {
        actor,
        eventType: 'ROOM_CREATED',
        entityType: 'room',
        entityId: created.id,
        locationId: created.locationId,
        after: {
          name: created.name,
          capacity: created.capacity,
          requiresApproval: created.requiresApproval,
        },
        ip,
      },
      tx,
    )

    return created
  })

  return room
}

export async function update(actor: Actor, id: string, input: Partial<RoomInput>, ip?: string) {
  const before = await prisma.room.findFirst({
    where: { id, organizationId: actor.organizationId },
    include: { features: { select: { featureId: true } } },
  })
  if (!before) throw new NotFoundError('That room')

  // The room's CURRENT location must be in scope, and so must the target if the
  // room is being moved between locations (BR-L2).
  await assertLocationInScope(actor, before.locationId, 'room:update')
  const targetLocationId = input.locationId ?? before.locationId
  if (input.locationId && input.locationId !== before.locationId) {
    await assertLocationInScope(actor, input.locationId, 'room:update')
  }

  if (input.name && input.name.trim().toLowerCase() !== before.name.toLowerCase()) {
    await assertNameFree(actor.organizationId, targetLocationId, input.name, id)
  } else if (input.locationId && input.locationId !== before.locationId) {
    await assertNameFree(actor.organizationId, targetLocationId, before.name, id)
  }

  if (input.featureIds) await assertFeaturesValid(actor.organizationId, input.featureIds)
  if (input.approverUserId !== undefined) {
    await assertApproverValid(actor.organizationId, input.approverUserId)
  }

  const data: Prisma.RoomUpdateInput = {}
  if (input.name !== undefined) data.name = input.name.trim()
  if (input.capacity !== undefined) data.capacity = input.capacity
  if (input.floor !== undefined) data.floor = input.floor?.trim() ?? null
  if (input.description !== undefined) data.description = input.description?.trim() ?? null
  if (input.colour !== undefined) data.colour = input.colour
  if (input.requiresApproval !== undefined) data.requiresApproval = input.requiresApproval
  if (input.approverUserId !== undefined) {
    data.approver = input.approverUserId
      ? { connect: { id: input.approverUserId } }
      : { disconnect: true }
  }
  if (input.approvalWindowHours !== undefined) data.approvalWindowHours = input.approvalWindowHours
  if (input.providerResourceEmail !== undefined) {
    data.providerResourceEmail = input.providerResourceEmail
  }
  if (input.locationId !== undefined) data.location = { connect: { id: input.locationId } }
  if (input.limits) {
    if (input.limits.minBookingMinutes !== undefined) {
      data.minBookingMinutes = input.limits.minBookingMinutes
    }
    if (input.limits.maxBookingMinutes !== undefined) {
      data.maxBookingMinutes = input.limits.maxBookingMinutes
    }
    if (input.limits.maxAdvanceDays !== undefined) data.maxAdvanceDays = input.limits.maxAdvanceDays
    if (input.limits.minNoticeMinutes !== undefined) {
      data.minNoticeMinutes = input.limits.minNoticeMinutes
    }
  }

  const room = await prisma.$transaction(async tx => {
    // Features and hours are replaced wholesale rather than diffed: the admin
    // screen submits the complete intended set, and a partial merge would make
    // "remove the projector" impossible to express.
    if (input.featureIds) {
      await tx.roomFeatureAssignment.deleteMany({ where: { roomId: id } })
      if (input.featureIds.length > 0) {
        await tx.roomFeatureAssignment.createMany({
          data: input.featureIds.map(featureId => ({ roomId: id, featureId })),
          skipDuplicates: true,
        })
      }
    }

    if (input.hours) {
      await tx.roomHours.deleteMany({ where: { roomId: id } })
      if (input.hours.length > 0) {
        await tx.roomHours.createMany({ data: input.hours.map(h => ({ ...h, roomId: id })) })
      }
    }

    const updated = await tx.room.update({ where: { id }, data, include: roomInclude })

    const changes = audit.diff(
      before as unknown as Record<string, unknown>,
      data as Record<string, unknown>,
    )
    if (changes || input.featureIds || input.hours) {
      await audit.record(
        {
          actor,
          eventType: 'ROOM_UPDATED',
          entityType: 'room',
          entityId: id,
          locationId: updated.locationId,
          before: changes?.before,
          after: changes?.after,
          ip,
        },
        tx,
      )
    }

    return updated
  })

  /*
   * Changing bookable hours or capacity does NOT retroactively invalidate
   * existing bookings (BR-R5, BR-R6). The count of future bookings now outside
   * the new hours is returned so the admin screen can offer to resolve them,
   * rather than silently leaving bookings that break the current rules.
   */
  return room
}

export async function setActive(actor: Actor, id: string, isActive: boolean, force = false, ip?: string) {
  const room = await prisma.room.findFirst({
    where: { id, organizationId: actor.organizationId },
    select: { id: true, name: true, isActive: true, locationId: true },
  })
  if (!room) throw new NotFoundError('That room')

  await assertLocationInScope(actor, room.locationId, 'room:update')
  if (!can(actor, 'room:deactivate', { organizationId: actor.organizationId, locationId: room.locationId })) {
    throw new AuthorizationError()
  }

  if (!isActive) {
    const futureBookings = await prisma.booking.findMany({
      where: {
        roomId: id,
        status: { in: ['PENDING_APPROVAL', 'CONFIRMED'] },
        startsAt: { gt: new Date() },
      },
      select: {
        id: true,
        title: true,
        startsAt: true,
        endsAt: true,
        seriesId: true,
        organizer: { select: { fullName: true } },
      },
      orderBy: { startsAt: 'asc' },
      take: 100,
    })

    // The admin is shown what they are about to orphan and must either resolve
    // those bookings or confirm explicitly (BR-R4, US-M8).
    if (futureBookings.length > 0 && !force) {
      throw new StateConflictError(
        `That room has ${futureBookings.length} future booking(s). Move or cancel them first, or deactivate with force.`,
      )
    }
  }

  const updated = await prisma.$transaction(async tx => {
    const row = await tx.room.update({ where: { id }, data: { isActive }, include: roomInclude })
    await audit.record(
      {
        actor,
        eventType: isActive ? 'ROOM_UPDATED' : 'ROOM_DEACTIVATED',
        entityType: 'room',
        entityId: id,
        locationId: room.locationId,
        before: { isActive: room.isActive },
        after: { isActive },
        ip,
      },
      tx,
    )
    return row
  })

  return updated
}

/**
 * Deletes a room outright.
 *
 * Permitted only when no booking has EVER referenced it — including cancelled
 * ones, because a cancelled booking is part of the record of what happened.
 * A room that has been used is organization history; deleting it would leave
 * audit rows pointing at nothing. In that case the caller is told to deactivate
 * instead, which removes it from every booking screen while keeping the history
 * intact (BR-R3).
 */
export async function remove(actor: Actor, id: string, ip?: string) {
  const room = await prisma.room.findFirst({
    where: { id, organizationId: actor.organizationId },
    select: {
      id: true,
      name: true,
      capacity: true,
      locationId: true,
      _count: { select: { bookings: true, series: true, closures: true, displays: true } },
    },
  })
  if (!room) throw new NotFoundError('That room')

  await assertLocationInScope(actor, room.locationId, 'room:update')
  if (!can(actor, 'room:deactivate', { organizationId: actor.organizationId, locationId: room.locationId })) {
    throw new AuthorizationError()
  }

  if (room._count.bookings > 0 || room._count.series > 0) {
    throw new StateConflictError(
      `That room has ${room._count.bookings} booking(s) in its history, so deleting it would orphan those records. Deactivate it instead - it will disappear from booking screens and keep its history.`,
    )
  }

  await prisma.$transaction(async tx => {
    // Feature links, hours, closures and display tokens all cascade; none of
    // them carries history that outlives the room.
    await tx.room.delete({ where: { id } })
    await audit.record(
      {
        actor,
        eventType: 'ROOM_DEACTIVATED',
        entityType: 'room',
        entityId: id,
        locationId: room.locationId,
        before: { name: room.name, capacity: room.capacity, deleted: false },
        after: { deleted: true },
        reason: 'Room deleted',
        ip,
      },
      tx,
    )
  })

  return { deleted: true, name: room.name }
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export async function listFeatures(actor: Actor) {
  return prisma.roomFeature.findMany({
    where: { organizationId: actor.organizationId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { rooms: true } } },
  })
}

export async function createFeature(
  actor: Actor,
  input: { name: string; icon?: string; sortOrder?: number },
) {
  if (!can(actor, 'room:create', { organizationId: actor.organizationId })) {
    throw new AuthorizationError()
  }

  const clash = await prisma.roomFeature.findFirst({
    where: {
      organizationId: actor.organizationId,
      name: { equals: input.name.trim(), mode: 'insensitive' },
    },
    select: { id: true },
  })
  if (clash) {
    throw new ValidationError('That feature already exists', { name: 'That name is already used' })
  }

  return prisma.roomFeature.create({
    data: {
      organizationId: actor.organizationId,
      name: input.name.trim(),
      icon: input.icon?.trim() ?? null,
      sortOrder: input.sortOrder ?? 0,
    },
  })
}

export async function removeFeature(actor: Actor, id: string) {
  if (!can(actor, 'room:update', { organizationId: actor.organizationId })) {
    throw new AuthorizationError()
  }
  const feature = await prisma.roomFeature.findFirst({
    where: { id, organizationId: actor.organizationId },
    select: { id: true, name: true },
  })
  if (!feature) throw new NotFoundError('That feature')

  // Assignments cascade: removing a feature simply untags the rooms that had
  // it, which is what an admin tidying the list expects.
  await prisma.roomFeature.delete({ where: { id } })
  return { deleted: true, name: feature.name }
}
