/**
 * Locations: runtime create, update, delete, activate.
 *
 * Only an OWNER may manage locations (BR-L3). Admins operate within the
 * locations they are granted, which is enforced through the shared `can()`.
 *
 * Specification: docs/14-multi-location.md, docs/05-api-spec.md section 5d.
 */

import type { Prisma } from '@prisma/client'
import type { Actor } from '@roombook/shared'
import { can } from '@roombook/shared'

import { prisma } from '../db.js'
import {
  AuthorizationError,
  NotFoundError,
  StateConflictError,
  ValidationError,
} from '../domain/errors.js'
import * as audit from './AuditService.js'

export interface LocationInput {
  name: string
  code?: string
  address?: string
  timezone: string
  country?: string
  businessHoursStart?: string | null
  businessHoursEnd?: string | null
  businessDays?: number[]
  minBookingMinutes?: number | null
  maxBookingMinutes?: number | null
  maxAdvanceDays?: number | null
  minNoticeMinutes?: number | null
  reminderLeadMinutes?: number | null
  sortOrder?: number
}

/**
 * Rejects an unknown IANA zone at write time.
 *
 * A bad timezone is not a cosmetic problem: every booking in the location would
 * be interpreted against it, so this must fail on the admin screen rather than
 * silently later (BR-T4).
 */
function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone })
  } catch {
    throw new ValidationError('That is not a recognised timezone', {
      timezone: 'Use an IANA name such as Africa/Addis_Ababa or Europe/London',
    })
  }
}

export async function list(actor: Actor, includeInactive = false) {
  return prisma.location.findMany({
    where: {
      organizationId: actor.organizationId,
      ...(includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: {
      _count: { select: { rooms: true } },
    },
  })
}

export async function get(actor: Actor, id: string) {
  const location = await prisma.location.findFirst({
    // Scoped by organization, so an ID from another organization reads as
    // missing rather than forbidden: existence itself is not disclosed.
    where: { id, organizationId: actor.organizationId },
    include: {
      rooms: { select: { id: true, name: true, isActive: true }, orderBy: { name: 'asc' } },
      holidays: { orderBy: { date: 'asc' } },
      adminAccess: {
        include: { user: { select: { id: true, fullName: true, email: true } } },
      },
    },
  })
  if (!location) throw new NotFoundError('That location')
  return location
}

export async function create(actor: Actor, input: LocationInput, ip?: string) {
  if (!can(actor, 'location:create', { organizationId: actor.organizationId })) {
    throw new AuthorizationError('Only an owner can create a location')
  }

  assertValidTimezone(input.timezone)

  const existing = await prisma.location.findFirst({
    where: {
      organizationId: actor.organizationId,
      name: { equals: input.name.trim(), mode: 'insensitive' },
    },
    select: { id: true },
  })
  if (existing) {
    throw new ValidationError('A location with that name already exists', {
      name: 'That name is already used',
    })
  }

  const location = await prisma.$transaction(async tx => {
    const created = await tx.location.create({
      data: {
        organizationId: actor.organizationId,
        name: input.name.trim(),
        code: input.code?.trim() ?? null,
        address: input.address?.trim() ?? null,
        timezone: input.timezone,
        country: input.country?.toUpperCase() ?? null,
        businessHoursStart: input.businessHoursStart ?? null,
        businessHoursEnd: input.businessHoursEnd ?? null,
        businessDays: input.businessDays ?? [],
        minBookingMinutes: input.minBookingMinutes ?? null,
        maxBookingMinutes: input.maxBookingMinutes ?? null,
        maxAdvanceDays: input.maxAdvanceDays ?? null,
        minNoticeMinutes: input.minNoticeMinutes ?? null,
        reminderLeadMinutes: input.reminderLeadMinutes ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    })

    // In the same transaction: a location without its audit row, or vice versa,
    // is a history nobody can trust.
    await audit.record(
      {
        actor,
        eventType: 'LOCATION_CREATED',
        entityType: 'location',
        entityId: created.id,
        locationId: created.id,
        after: { name: created.name, timezone: created.timezone },
        ip,
      },
      tx,
    )

    return created
  })

  return location
}

export async function update(actor: Actor, id: string, input: Partial<LocationInput>, ip?: string) {
  const before = await prisma.location.findFirst({
    where: { id, organizationId: actor.organizationId },
  })
  if (!before) throw new NotFoundError('That location')

  if (!can(actor, 'location:update', { organizationId: actor.organizationId, locationId: id })) {
    throw new AuthorizationError('Only an owner can change a location')
  }

  if (input.timezone) assertValidTimezone(input.timezone)

  if (input.name && input.name.trim().toLowerCase() !== before.name.toLowerCase()) {
    const clash = await prisma.location.findFirst({
      where: {
        organizationId: actor.organizationId,
        name: { equals: input.name.trim(), mode: 'insensitive' },
        id: { not: id },
      },
      select: { id: true },
    })
    if (clash) {
      throw new ValidationError('A location with that name already exists', {
        name: 'That name is already used',
      })
    }
  }

  const data: Prisma.LocationUpdateInput = {}
  if (input.name !== undefined) data.name = input.name.trim()
  if (input.code !== undefined) data.code = input.code?.trim() ?? null
  if (input.address !== undefined) data.address = input.address?.trim() ?? null
  if (input.timezone !== undefined) data.timezone = input.timezone
  if (input.country !== undefined) data.country = input.country?.toUpperCase() ?? null
  if (input.businessHoursStart !== undefined) data.businessHoursStart = input.businessHoursStart
  if (input.businessHoursEnd !== undefined) data.businessHoursEnd = input.businessHoursEnd
  if (input.businessDays !== undefined) data.businessDays = input.businessDays
  if (input.minBookingMinutes !== undefined) data.minBookingMinutes = input.minBookingMinutes
  if (input.maxBookingMinutes !== undefined) data.maxBookingMinutes = input.maxBookingMinutes
  if (input.maxAdvanceDays !== undefined) data.maxAdvanceDays = input.maxAdvanceDays
  if (input.minNoticeMinutes !== undefined) data.minNoticeMinutes = input.minNoticeMinutes
  if (input.reminderLeadMinutes !== undefined) data.reminderLeadMinutes = input.reminderLeadMinutes
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder

  const changes = audit.diff(before as unknown as Record<string, unknown>, data as Record<string, unknown>)

  const updated = await prisma.$transaction(async tx => {
    const row = await tx.location.update({ where: { id }, data })
    if (changes) {
      await audit.record(
        {
          actor,
          eventType: 'LOCATION_UPDATED',
          entityType: 'location',
          entityId: id,
          locationId: id,
          before: changes.before,
          after: changes.after,
          ip,
        },
        tx,
      )
    }
    return row
  })

  return updated
}

export async function setActive(actor: Actor, id: string, isActive: boolean, ip?: string) {
  const location = await prisma.location.findFirst({
    where: { id, organizationId: actor.organizationId },
    select: { id: true, name: true, isActive: true },
  })
  if (!location) throw new NotFoundError('That location')

  if (!can(actor, 'location:deactivate', { organizationId: actor.organizationId, locationId: id })) {
    throw new AuthorizationError('Only an owner can deactivate a location')
  }

  // Deactivating hides the location and its rooms from new bookings but leaves
  // existing ones alone. The caller is expected to have resolved future
  // bookings first; `futureBookingCount` is what the UI uses to warn (BR-L6).
  const futureBookings = isActive
    ? 0
    : await prisma.booking.count({
        where: {
          room: { locationId: id },
          status: { in: ['PENDING_APPROVAL', 'CONFIRMED'] },
          startsAt: { gt: new Date() },
        },
      })

  const updated = await prisma.$transaction(async tx => {
    const row = await tx.location.update({ where: { id }, data: { isActive } })
    await audit.record(
      {
        actor,
        eventType: isActive ? 'LOCATION_UPDATED' : 'LOCATION_DEACTIVATED',
        entityType: 'location',
        entityId: id,
        locationId: id,
        before: { isActive: location.isActive },
        after: { isActive },
        ip,
      },
      tx,
    )
    return row
  })

  return { location: updated, futureBookings }
}

/**
 * Deletes a location outright.
 *
 * Permitted only when nothing references it. A location that has ever hosted a
 * booking is part of the organization history, and removing it would orphan
 * that record — so the caller is told to deactivate instead. This is the
 * "delete at runtime" capability, with the one guard that keeps the audit trail
 * meaningful (BR-R3, extended to locations).
 */
export async function remove(actor: Actor, id: string, ip?: string) {
  const location = await prisma.location.findFirst({
    where: { id, organizationId: actor.organizationId },
    select: {
      id: true,
      name: true,
      timezone: true,
      _count: { select: { rooms: true, holidays: true, adminAccess: true, homeUsers: true } },
    },
  })
  if (!location) throw new NotFoundError('That location')

  if (!can(actor, 'location:deactivate', { organizationId: actor.organizationId, locationId: id })) {
    throw new AuthorizationError('Only an owner can delete a location')
  }

  if (location._count.rooms > 0) {
    throw new StateConflictError(
      `That location still has ${location._count.rooms} room(s). Delete or move the rooms first, or deactivate the location instead.`,
    )
  }

  if (location._count.homeUsers > 0) {
    throw new StateConflictError(
      `${location._count.homeUsers} user(s) have this as their home location. Change those first.`,
    )
  }

  await prisma.$transaction(async tx => {
    // Holidays and admin grants cascade; they carry no history worth keeping
    // once the location itself is gone.
    await tx.location.delete({ where: { id } })
    await audit.record(
      {
        actor,
        eventType: 'LOCATION_DEACTIVATED',
        entityType: 'location',
        entityId: id,
        before: { name: location.name, timezone: location.timezone, deleted: false },
        after: { deleted: true },
        reason: 'Location deleted',
        ip,
      },
      tx,
    )
  })

  return { deleted: true, name: location.name }
}

export async function setHolidays(
  actor: Actor,
  locationId: string,
  holidays: Array<{ date: string; name: string }>,
  ip?: string,
) {
  const location = await prisma.location.findFirst({
    where: { id: locationId, organizationId: actor.organizationId },
    select: { id: true },
  })
  if (!location) throw new NotFoundError('That location')

  if (!can(actor, 'location:update', { organizationId: actor.organizationId, locationId })) {
    throw new AuthorizationError('Only an owner can change holidays')
  }

  await prisma.$transaction(async tx => {
    await tx.locationHoliday.deleteMany({ where: { locationId } })
    if (holidays.length > 0) {
      await tx.locationHoliday.createMany({
        data: holidays.map(h => ({ locationId, date: h.date, name: h.name.trim() })),
        skipDuplicates: true,
      })
    }
    await audit.record(
      {
        actor,
        eventType: 'LOCATION_UPDATED',
        entityType: 'location',
        entityId: locationId,
        locationId,
        after: { holidayCount: holidays.length },
        ip,
      },
      tx,
    )
  })

  return prisma.locationHoliday.findMany({ where: { locationId }, orderBy: { date: 'asc' } })
}
