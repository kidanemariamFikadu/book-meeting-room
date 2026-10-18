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
import { holidaysFor, supportsCountry } from '../domain/holidays.js'
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

// ---------------------------------------------------------------------------
// Effective settings, and holiday seeding
// ---------------------------------------------------------------------------

/**
 * One resolved setting, with its PROVENANCE.
 *
 * The source matters as much as the value. An admin looking at "90 days"
 * needs to know whether this location chose it or is merely inheriting it,
 * because changing the organization default will move the second but not the
 * first. Not showing the source is the commonest cause of confusion in a
 * three-level model (docs/14-multi-location.md section 4).
 */
export interface ResolvedSetting<T> {
  value: T
  source: 'room' | 'location' | 'organization' | 'default'
  /** What it would fall back to if this level were cleared. */
  inheritedValue: T | null
}

function resolve<T>(
  levels: Array<{ source: ResolvedSetting<T>['source']; value: T | null | undefined }>,
  fallback: T,
): ResolvedSetting<T> {
  // `null` means inherit; an explicit `0` is a real value and must not fall
  // through, which is why this checks for null/undefined rather than falsiness.
  let chosen: ResolvedSetting<T> | null = null
  let inherited: T | null = null

  for (const level of levels) {
    if (level.value !== null && level.value !== undefined) {
      if (!chosen) chosen = { value: level.value, source: level.source, inheritedValue: null }
      else if (inherited === null) inherited = level.value
    }
  }

  if (!chosen) return { value: fallback, source: 'default', inheritedValue: null }
  return { ...chosen, inheritedValue: inherited ?? fallback }
}

export async function effectiveSettings(actor: Actor, locationId: string) {
  const location = await prisma.location.findFirst({
    where: { id: locationId, organizationId: actor.organizationId },
  })
  if (!location) throw new NotFoundError('That location')

  const org = await prisma.orgSettings.findUnique({
    where: { organizationId: actor.organizationId },
  })

  const levels = <T>(locationValue: T | null | undefined, orgValue: T | null | undefined) => [
    { source: 'location' as const, value: locationValue },
    { source: 'organization' as const, value: orgValue },
  ]

  return {
    locationId: location.id,
    locationName: location.name,
    timezone: location.timezone,
    country: location.country,
    businessHoursStart: resolve(
      levels(location.businessHoursStart, org?.businessHoursStart),
      '08:00',
    ),
    businessHoursEnd: resolve(levels(location.businessHoursEnd, org?.businessHoursEnd), '18:00'),
    businessDays: resolve(
      levels(
        location.businessDays.length > 0 ? location.businessDays : null,
        org?.businessDays,
      ),
      [1, 2, 3, 4, 5],
    ),
    minBookingMinutes: resolve(levels(location.minBookingMinutes, org?.minBookingMinutes), 15),
    maxBookingMinutes: resolve(levels(location.maxBookingMinutes, org?.maxBookingMinutes), 480),
    maxAdvanceDays: resolve(levels(location.maxAdvanceDays, org?.maxAdvanceDays), 90),
    minNoticeMinutes: resolve(levels(location.minNoticeMinutes, org?.minNoticeMinutes), 0),
    reminderLeadMinutes: resolve(
      levels(location.reminderLeadMinutes, org?.reminderLeadMinutes),
      15,
    ),
  }
}

/**
 * Suggests public holidays from the location country.
 *
 * Read-only: it returns candidates and the caller decides. Seeding directly
 * would overwrite an owner edits, and the dataset is a convenience rather
 * than an authority (D18).
 */
export async function suggestHolidays(actor: Actor, locationId: string, years = 2) {
  const location = await prisma.location.findFirst({
    where: { id: locationId, organizationId: actor.organizationId },
    select: { country: true, holidays: { select: { date: true } } },
  })
  if (!location) throw new NotFoundError('That location')
  if (!location.country) return { supported: false, country: null, holidays: [] }

  const existing = new Set(location.holidays.map(h => h.date))
  const suggestions = holidaysFor(location.country, new Date().getUTCFullYear(), years)

  return {
    supported: supportsCountry(location.country),
    country: location.country,
    // Dates already present are excluded, so accepting the suggestions is
    // additive and never duplicates what the owner already entered.
    holidays: suggestions.filter(h => !existing.has(h.date)),
  }
}

/** Adds holidays without disturbing those already present. */
export async function addHolidays(
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
    await tx.locationHoliday.createMany({
      data: holidays.map(h => ({ locationId, date: h.date, name: h.name.trim() })),
      skipDuplicates: true,
    })
    await audit.record(
      {
        actor,
        eventType: 'LOCATION_UPDATED',
        entityType: 'location',
        entityId: locationId,
        locationId,
        after: { holidaysAdded: holidays.length },
        ip,
      },
      tx,
    )
  })

  return prisma.locationHoliday.findMany({ where: { locationId }, orderBy: { date: 'asc' } })
}

export async function removeHoliday(actor: Actor, locationId: string, date: string, ip?: string) {
  if (!can(actor, 'location:update', { organizationId: actor.organizationId, locationId })) {
    throw new AuthorizationError('Only an owner can change holidays')
  }
  const deleted = await prisma.locationHoliday.deleteMany({ where: { locationId, date } })
  if (deleted.count === 0) throw new NotFoundError('That holiday')

  await audit.record({
    actor,
    eventType: 'LOCATION_UPDATED',
    entityType: 'location',
    entityId: locationId,
    locationId,
    before: { holiday: date },
    after: { holiday: null },
    ip,
  })

  return { deleted: true }
}
