/**
 * Availability: what is free, when, and what to offer when it is not.
 *
 * Specification: docs/05-api-spec.md section 4.
 */

import { OCCUPYING_BOOKING_STATUSES, can, subtractIntervals, type Actor } from '@roombook/shared'
import {
  addLocalDays,
  dateInZone,
  endOfLocalDay,
  startOfLocalDay,
  type Interval,
} from '@roombook/shared'

import { prisma } from '../db.js'
import { bookableWindowsOn, effectiveLimits, type RoomHoursRow, type SettingsSource } from '../domain/rules.js'

/**
 * Everything the rules need about one room, loaded once.
 *
 * Gathering this in a single place keeps the booking service free of
 * three-level settings plumbing, and means one query shape serves validation,
 * availability and conflict messages alike.
 */
export interface RoomContext {
  room: {
    id: string
    name: string
    capacity: number
    colour: string
    floor: string | null
    isActive: boolean
    requiresApproval: boolean
    locationId: string
    location: { id: string; name: string; timezone: string; address: string | null }
  }
  timeZone: string
  roomHours: RoomHoursRow[]
  locationHours: { start: string | null; end: string | null; days: number[] }
  orgHours: { start: string; end: string; days: number[] }
  holidays: Set<string>
  settings: SettingsSource
  notifyAttendees: boolean
  allowExternalAttendees: boolean
  approvalWindowHours: number
}

const ORG_FALLBACK = {
  minBookingMinutes: 15,
  maxBookingMinutes: 480,
  maxAdvanceDays: 90,
  minNoticeMinutes: 0,
  slotGranularityMinutes: 15,
  businessHoursStart: '08:00',
  businessHoursEnd: '18:00',
  businessDays: [1, 2, 3, 4, 5],
}

export async function loadRoomContext(
  organizationId: string,
  roomId: string,
): Promise<RoomContext | null> {
  const room = await prisma.room.findFirst({
    where: { id: roomId, organizationId },
    include: {
      hours: { orderBy: [{ weekday: 'asc' }, { startLocal: 'asc' }] },
      location: { include: { holidays: { select: { date: true } } } },
    },
  })
  if (!room) return null

  const settings = await prisma.orgSettings.findUnique({ where: { organizationId } })
  const org = settings ?? ORG_FALLBACK

  return {
    room: {
      id: room.id,
      name: room.name,
      capacity: room.capacity,
      colour: room.colour,
      floor: room.floor,
      isActive: room.isActive,
      requiresApproval: room.requiresApproval,
      locationId: room.locationId,
      location: {
        id: room.location.id,
        name: room.location.name,
        timezone: room.location.timezone,
        address: room.location.address,
      },
    },
    timeZone: room.location.timezone,
    roomHours: room.hours.map(h => ({
      weekday: h.weekday,
      startLocal: h.startLocal,
      endLocal: h.endLocal,
    })),
    locationHours: {
      start: room.location.businessHoursStart,
      end: room.location.businessHoursEnd,
      days: room.location.businessDays,
    },
    orgHours: {
      start: org.businessHoursStart,
      end: org.businessHoursEnd,
      days: org.businessDays,
    },
    holidays: new Set(room.location.holidays.map(h => h.date)),
    settings: {
      room: {
        minBookingMinutes: room.minBookingMinutes,
        maxBookingMinutes: room.maxBookingMinutes,
        maxAdvanceDays: room.maxAdvanceDays,
        minNoticeMinutes: room.minNoticeMinutes,
      },
      location: {
        minBookingMinutes: room.location.minBookingMinutes,
        maxBookingMinutes: room.location.maxBookingMinutes,
        maxAdvanceDays: room.location.maxAdvanceDays,
        minNoticeMinutes: room.location.minNoticeMinutes,
        businessHoursStart: room.location.businessHoursStart,
        businessHoursEnd: room.location.businessHoursEnd,
        businessDays: room.location.businessDays,
        timezone: room.location.timezone,
      },
      org: {
        minBookingMinutes: org.minBookingMinutes,
        maxBookingMinutes: org.maxBookingMinutes,
        maxAdvanceDays: org.maxAdvanceDays,
        minNoticeMinutes: org.minNoticeMinutes,
        slotGranularityMinutes: org.slotGranularityMinutes,
        businessHoursStart: org.businessHoursStart,
        businessHoursEnd: org.businessHoursEnd,
        businessDays: org.businessDays,
      },
    },
    notifyAttendees: settings?.notifyAttendees ?? false,
    allowExternalAttendees: settings?.allowExternalAttendees ?? true,
    approvalWindowHours: room.approvalWindowHours ?? settings?.approvalWindowHours ?? 24,
  }
}

// ---------------------------------------------------------------------------
// Day view
// ---------------------------------------------------------------------------

export interface BusySlot {
  bookingId: string
  startsAt: string
  endsAt: string
  title: string
  organizer: { id: string; fullName: string } | null
  status: string
  isPrivate: boolean
  isMine: boolean
  canAdminister: boolean
}

export interface RoomAvailability {
  roomId: string
  name: string
  capacity: number
  floor: string | null
  colour: string
  features: Array<{ id: string; name: string }>
  bookableWindows: Array<{ startsAt: string; endsAt: string }>
  busy: BusySlot[]
  closures: Array<{ id: string; startsAt: string; endsAt: string; reason: string }>
  freeSlots: Array<{ startsAt: string; endsAt: string }>
}

export interface DayAvailability {
  date: string
  timezone: string
  locationId: string
  locationName: string
  rooms: RoomAvailability[]
}

export interface AvailabilityFilters {
  locationId?: string
  roomIds?: string[]
  minCapacity?: number
  features?: string[]
}

/**
 * Everything needed to draw the calendar grid for one local date.
 *
 * Redaction happens HERE, on the server: a private booking the viewer may not
 * see never reaches the browser with its title attached, rather than being
 * sent and hidden by a component (BR-P3, T-111).
 */
export async function dayAvailability(
  actor: Actor,
  date: string,
  filters: AvailabilityFilters,
): Promise<DayAvailability> {
  const location = filters.locationId
    ? await prisma.location.findFirst({
        where: { id: filters.locationId, organizationId: actor.organizationId },
      })
    : await prisma.location.findFirst({
        where: { organizationId: actor.organizationId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      })

  if (!location) {
    return { date, timezone: 'UTC', locationId: '', locationName: '', rooms: [] }
  }

  const timezone = location.timezone
  const dayStart = startOfLocalDay(date, timezone)
  const dayEnd = endOfLocalDay(date, timezone)

  const rooms = await prisma.room.findMany({
    where: {
      organizationId: actor.organizationId,
      locationId: location.id,
      isActive: true,
      ...(filters.roomIds?.length ? { id: { in: filters.roomIds } } : {}),
      ...(filters.minCapacity ? { capacity: { gte: filters.minCapacity } } : {}),
      ...(filters.features?.length
        ? { AND: filters.features.map(id => ({ features: { some: { featureId: id } } })) }
        : {}),
    },
    include: {
      hours: true,
      features: { include: { feature: { select: { id: true, name: true } } } },
    },
    orderBy: [{ capacity: 'asc' }, { name: 'asc' }],
  })

  if (rooms.length === 0) {
    return { date, timezone, locationId: location.id, locationName: location.name, rooms: [] }
  }

  const roomIds = rooms.map(r => r.id)

  // One query for every room's bookings, rather than one per room: at fifty
  // rooms the per-room version is fifty round trips to draw one screen.
  const [bookings, closures, holidays, orgSettings] = await Promise.all([
    prisma.booking.findMany({
      where: {
        roomId: { in: roomIds },
        status: { in: [...OCCUPYING_BOOKING_STATUSES] },
        startsAt: { lt: dayEnd },
        endsAt: { gt: dayStart },
      },
      select: {
        id: true,
        roomId: true,
        title: true,
        startsAt: true,
        endsAt: true,
        status: true,
        isPrivate: true,
        organizerId: true,
        organizer: { select: { id: true, fullName: true } },
        attendees: { select: { userId: true } },
      },
      orderBy: { startsAt: 'asc' },
    }),
    prisma.roomClosure.findMany({
      where: { roomId: { in: roomIds }, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
      select: { id: true, roomId: true, startsAt: true, endsAt: true, reason: true },
    }),
    prisma.locationHoliday.findMany({
      where: { locationId: location.id, date },
      select: { date: true },
    }),
    prisma.orgSettings.findUnique({ where: { organizationId: actor.organizationId } }),
  ])

  const org = orgSettings ?? ORG_FALLBACK
  const holidaySet = new Set(holidays.map(h => h.date))

  const result: RoomAvailability[] = rooms.map(room => {
    const administers = can(actor, 'room:update', {
      organizationId: actor.organizationId,
      locationId: room.locationId,
    })

    const windows = bookableWindowsOn(
      date,
      timezone,
      room.hours.map(h => ({ weekday: h.weekday, startLocal: h.startLocal, endLocal: h.endLocal })),
      {
        start: location.businessHoursStart,
        end: location.businessHoursEnd,
        days: location.businessDays,
      },
      { start: org.businessHoursStart, end: org.businessHoursEnd, days: org.businessDays },
      holidaySet,
    )

    const roomBookings = bookings.filter(b => b.roomId === room.id)
    const roomClosures = closures.filter(c => c.roomId === room.id)

    const busy: BusySlot[] = roomBookings.map(b => {
      const isMine = b.organizerId === actor.id
      const isAttendee = b.attendees.some(a => a.userId === actor.id)
      const maySeeDetails = !b.isPrivate || isMine || isAttendee || administers

      return {
        bookingId: b.id,
        startsAt: b.startsAt.toISOString(),
        endsAt: b.endsAt.toISOString(),
        // The title is replaced, not hidden client-side.
        title: maySeeDetails ? b.title : 'Busy',
        organizer: maySeeDetails ? { id: b.organizer.id, fullName: b.organizer.fullName } : null,
        status: b.status,
        isPrivate: b.isPrivate,
        isMine,
        canAdminister: administers,
      }
    })

    // Free time is what remains of the bookable windows once bookings and
    // closures are removed.
    const occupied: Interval[] = [
      ...roomBookings.map(b => ({ start: b.startsAt, end: b.endsAt })),
      ...roomClosures.map(c => ({ start: c.startsAt, end: c.endsAt })),
    ]

    const freeSlots = windows.flatMap(w =>
      subtractIntervals({ start: w.start, end: w.end }, occupied),
    )

    return {
      roomId: room.id,
      name: room.name,
      capacity: room.capacity,
      floor: room.floor,
      colour: room.colour,
      features: room.features.map(f => ({ id: f.feature.id, name: f.feature.name })),
      bookableWindows: windows.map(w => ({
        startsAt: w.start.toISOString(),
        endsAt: w.end.toISOString(),
      })),
      busy,
      closures: roomClosures.map(c => ({
        id: c.id,
        startsAt: c.startsAt.toISOString(),
        endsAt: c.endsAt.toISOString(),
        reason: c.reason,
      })),
      freeSlots: freeSlots.map(f => ({
        startsAt: f.start.toISOString(),
        endsAt: f.end.toISOString(),
      })),
    }
  })

  return {
    date,
    timezone,
    locationId: location.id,
    locationName: location.name,
    rooms: result,
  }
}

// ---------------------------------------------------------------------------
// Room finder
// ---------------------------------------------------------------------------

export interface FreeRoom {
  roomId: string
  name: string
  capacity: number
  floor: string | null
  colour: string
  locationId: string
  locationName: string
  timezone: string
  features: Array<{ id: string; name: string }>
  requiresApproval: boolean
}

/**
 * Rooms completely free for a range (US-B2).
 *
 * Ordered smallest-room-first among those that fit, so a two-person meeting
 * does not consume the boardroom.
 */
export async function findFreeRooms(
  actor: Actor,
  start: Date,
  end: Date,
  filters: AvailabilityFilters & { allLocations?: boolean },
): Promise<FreeRoom[]> {
  const rooms = await prisma.room.findMany({
    where: {
      organizationId: actor.organizationId,
      isActive: true,
      location: { isActive: true },
      ...(filters.allLocations ? {} : filters.locationId ? { locationId: filters.locationId } : {}),
      ...(filters.minCapacity ? { capacity: { gte: filters.minCapacity } } : {}),
      ...(filters.features?.length
        ? { AND: filters.features.map(id => ({ features: { some: { featureId: id } } })) }
        : {}),
      // Rooms with anything occupying the range are excluded in the query
      // itself rather than filtered afterwards.
      bookings: {
        none: {
          status: { in: [...OCCUPYING_BOOKING_STATUSES] },
          startsAt: { lt: end },
          endsAt: { gt: start },
        },
      },
      closures: { none: { startsAt: { lt: end }, endsAt: { gt: start } } },
    },
    include: {
      location: { select: { id: true, name: true, timezone: true } },
      features: { include: { feature: { select: { id: true, name: true } } } },
      hours: true,
    },
    orderBy: [{ capacity: 'asc' }, { name: 'asc' }],
    take: 100,
  })

  const orgSettings = await prisma.orgSettings.findUnique({
    where: { organizationId: actor.organizationId },
  })
  const org = orgSettings ?? ORG_FALLBACK

  const locations = await prisma.location.findMany({
    where: { organizationId: actor.organizationId },
    include: { holidays: { select: { date: true } } },
  })

  // A room free of bookings may still be outside its bookable hours, so the
  // same rule the booking endpoint applies is applied here too — otherwise the
  // finder offers rooms that cannot actually be booked.
  return rooms
    .filter(room => {
      const location = locations.find(l => l.id === room.locationId)
      if (!location) return false
      const tz = location.timezone
      const holidays = new Set(location.holidays.map(h => h.date))
      const date = dateInZone(start, tz)

      const windows = [
        ...bookableWindowsOn(
          date,
          tz,
          room.hours.map(h => ({ weekday: h.weekday, startLocal: h.startLocal, endLocal: h.endLocal })),
          {
            start: location.businessHoursStart,
            end: location.businessHoursEnd,
            days: location.businessDays,
          },
          { start: org.businessHoursStart, end: org.businessHoursEnd, days: org.businessDays },
          holidays,
        ),
        ...bookableWindowsOn(
          addLocalDays(date, 1),
          tz,
          room.hours.map(h => ({ weekday: h.weekday, startLocal: h.startLocal, endLocal: h.endLocal })),
          {
            start: location.businessHoursStart,
            end: location.businessHoursEnd,
            days: location.businessDays,
          },
          { start: org.businessHoursStart, end: org.businessHoursEnd, days: org.businessDays },
          holidays,
        ),
      ]

      return windows.some(w => w.start.getTime() <= start.getTime() && w.end.getTime() >= end.getTime())
    })
    .map(room => ({
      roomId: room.id,
      name: room.name,
      capacity: room.capacity,
      floor: room.floor,
      colour: room.colour,
      locationId: room.location.id,
      locationName: room.location.name,
      timezone: room.location.timezone,
      features: room.features.map(f => ({ id: f.feature.id, name: f.feature.name })),
      requiresApproval: room.requiresApproval,
    }))
}

// ---------------------------------------------------------------------------
// Conflict recovery
// ---------------------------------------------------------------------------

export interface Suggestions {
  sameRoom: Array<{ startsAt: string; endsAt: string }>
  otherRooms: FreeRoom[]
}

/**
 * What to offer when the chosen slot is taken (BR-C4).
 *
 * A conflict is never a dead end: the nearest free times in the same room, and
 * other rooms free at the requested time. Every suggestion is directly
 * bookable, so the user never retypes anything.
 */
export async function suggestions(
  actor: Actor,
  roomId: string,
  start: Date,
  end: Date,
): Promise<Suggestions> {
  const ctx = await loadRoomContext(actor.organizationId, roomId)
  if (!ctx) return { sameRoom: [], otherRooms: [] }

  const durationMs = end.getTime() - start.getTime()
  const date = dateInZone(start, ctx.timeZone)

  const windows = bookableWindowsOn(
    date,
    ctx.timeZone,
    ctx.roomHours,
    ctx.locationHours,
    ctx.orgHours,
    ctx.holidays,
  )

  const occupied = await prisma.booking.findMany({
    where: {
      roomId,
      status: { in: [...OCCUPYING_BOOKING_STATUSES] },
      startsAt: { lt: windows.at(-1)?.end ?? end },
      endsAt: { gt: windows[0]?.start ?? start },
    },
    select: { startsAt: true, endsAt: true },
  })

  const free = windows.flatMap(w =>
    subtractIntervals(
      { start: w.start, end: w.end },
      occupied.map(o => ({ start: o.startsAt, end: o.endsAt })),
    ),
  )

  // Gaps long enough for this meeting, nearest to the requested time first.
  const sameRoom = free
    .filter(f => f.end.getTime() - f.start.getTime() >= durationMs)
    .map(f => ({ start: f.start, end: new Date(f.start.getTime() + durationMs) }))
    .filter(f => f.start.getTime() >= Date.now())
    .sort(
      (a, b) =>
        Math.abs(a.start.getTime() - start.getTime()) - Math.abs(b.start.getTime() - start.getTime()),
    )
    .slice(0, 4)
    .map(f => ({ startsAt: f.start.toISOString(), endsAt: f.end.toISOString() }))

  const otherRooms = (
    await findFreeRooms(actor, start, end, {
      locationId: ctx.room.locationId,
      minCapacity: undefined,
    })
  )
    .filter(r => r.roomId !== roomId)
    .slice(0, 5)

  return { sameRoom, otherRooms }
}
