/**
 * Booking validity rules.
 *
 * Pure functions over already-loaded data: no database access, no HTTP. That
 * keeps every rule testable in isolation and lets the booking service apply
 * them inside a transaction without widening it.
 *
 * Rules are checked in the order given in docs/04-business-rules.md section 2,
 * and the FIRST failure is returned — one clear message beats a wall of them.
 */

import {
  addLocalDays,
  contains,
  isoWeekdayInZone,
  localDatesInRange,
  localTimeToMinutes,
  mergeIntervals,
  resolveSetting,
  timeInZone,
  zonedTimeToUtc,
  type Interval,
} from '@roombook/shared'

/** The three levels a limit can come from, most specific first. */
export interface EffectiveLimits {
  minBookingMinutes: number
  maxBookingMinutes: number
  maxAdvanceDays: number
  minNoticeMinutes: number
  slotGranularityMinutes: number
}

export interface SettingsSource {
  room: {
    minBookingMinutes: number | null
    maxBookingMinutes: number | null
    maxAdvanceDays: number | null
    minNoticeMinutes: number | null
  }
  location: {
    minBookingMinutes: number | null
    maxBookingMinutes: number | null
    maxAdvanceDays: number | null
    minNoticeMinutes: number | null
    businessHoursStart: string | null
    businessHoursEnd: string | null
    businessDays: number[]
    timezone: string
  }
  org: {
    minBookingMinutes: number
    maxBookingMinutes: number
    maxAdvanceDays: number
    minNoticeMinutes: number
    slotGranularityMinutes: number
    businessHoursStart: string
    businessHoursEnd: string
    businessDays: number[]
  }
}

/**
 * Resolves room -> location -> organization.
 *
 * `null` means inherit; an explicit `0` is a real value and must not fall
 * through. That distinction is the commonest configuration bug in this system
 * (T-166), which is why it goes through one shared helper.
 */
export function effectiveLimits(src: SettingsSource): EffectiveLimits {
  return {
    minBookingMinutes:
      resolveSetting(src.room.minBookingMinutes, src.location.minBookingMinutes, src.org.minBookingMinutes) ?? 15,
    maxBookingMinutes:
      resolveSetting(src.room.maxBookingMinutes, src.location.maxBookingMinutes, src.org.maxBookingMinutes) ?? 480,
    maxAdvanceDays:
      resolveSetting(src.room.maxAdvanceDays, src.location.maxAdvanceDays, src.org.maxAdvanceDays) ?? 90,
    minNoticeMinutes:
      resolveSetting(src.room.minNoticeMinutes, src.location.minNoticeMinutes, src.org.minNoticeMinutes) ?? 0,
    slotGranularityMinutes: src.org.slotGranularityMinutes,
  }
}

/** A bookable window on one local date, as a UTC interval. */
export interface BookableWindow {
  date: string
  start: Date
  end: Date
}

export interface RoomHoursRow {
  weekday: number
  startLocal: string
  endLocal: string
}

/**
 * The windows a room is bookable in on a given local date.
 *
 * Hours are stored as LOCAL WALL CLOCK and resolved per date against the zone,
 * which is what keeps 08:00-18:00 meaning 08:00-18:00 across a clock change
 * (BR-T6). Returns an empty array when the room is not bookable that day.
 */
export function bookableWindowsOn(
  date: string,
  timeZone: string,
  roomHours: RoomHoursRow[],
  locationHours: { start: string | null; end: string | null; days: number[] },
  orgHours: { start: string; end: string; days: number[] },
  holidays: Set<string>,
): BookableWindow[] {
  // A holiday closes every room at that location for the whole day, which is
  // what stops a recurring meeting being booked into a shut building.
  if (holidays.has(date)) return []

  const [y, m, d] = date.split('-').map(Number)
  const weekday = isoWeekdayInZone(new Date(Date.UTC(y!, m! - 1, d!, 12)), 'UTC')

  const toWindow = (startLocal: string, endLocal: string): BookableWindow | null => {
    try {
      const start = zonedTimeToUtc(
        { year: y!, month: m!, day: d!, hour: Math.floor(localTimeToMinutes(startLocal) / 60), minute: localTimeToMinutes(startLocal) % 60 },
        timeZone,
      ).instant
      const endMinutes = localTimeToMinutes(endLocal)
      // 24:00 is written as a window ending at the start of the next day.
      const end =
        endMinutes === 0
          ? zonedTimeToUtc({ year: y!, month: m!, day: d! + 1, hour: 0, minute: 0 }, timeZone).instant
          : zonedTimeToUtc(
              { year: y!, month: m!, day: d!, hour: Math.floor(endMinutes / 60), minute: endMinutes % 60 },
              timeZone,
            ).instant
      return end.getTime() > start.getTime() ? { date, start, end } : null
    } catch {
      // The window edge fell in a spring-forward gap. Skipping it is correct:
      // that minute genuinely did not exist on this date.
      return null
    }
  }

  // A room with its own hours overrides the location entirely for that day.
  const ownHours = roomHours.filter(h => h.weekday === weekday)
  if (roomHours.length > 0) {
    return ownHours.map(h => toWindow(h.startLocal, h.endLocal)).filter((w): w is BookableWindow => w !== null)
  }

  const days = locationHours.days.length > 0 ? locationHours.days : orgHours.days
  if (!days.includes(weekday)) return []

  const start = locationHours.start ?? orgHours.start
  const end = locationHours.end ?? orgHours.end
  const window = toWindow(start, end)
  return window ? [window] : []
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RuleFailure {
  rule: string
  message: string
}

export interface ValidationContext {
  interval: Interval
  limits: EffectiveLimits
  timeZone: string
  roomHours: RoomHoursRow[]
  locationHours: { start: string | null; end: string | null; days: number[] }
  orgHours: { start: string; end: string; days: number[] }
  holidays: Set<string>
  now: Date
  /** An admin may be permitted to ignore the advance-window rules (US-M9). */
  overrideWindows?: boolean
}

/** A booking may start up to this long before "now" (BR-V5). */
const PAST_TOLERANCE_MINUTES = 5

/**
 * Applies BR-V2 through BR-V8. Returns the first failure, or null.
 *
 * Conflicts with other bookings and with closures are NOT checked here: those
 * need the database and must happen inside the write transaction, or two
 * requests can both pass before either writes.
 */
export function validateBookingRules(ctx: ValidationContext): RuleFailure | null {
  const { interval, limits, now } = ctx
  const startMs = interval.start.getTime()
  const endMs = interval.end.getTime()
  const durationMinutes = Math.round((endMs - startMs) / 60_000)

  // BR-V2
  if (!(startMs < endMs)) {
    return { rule: 'BR-V2', message: 'The end time must be after the start time' }
  }

  // BR-T7: both edges must sit on a slot boundary in the ROOM's zone.
  const granularity = limits.slotGranularityMinutes
  if (granularity > 0) {
    for (const [label, instant] of [
      ['start', interval.start],
      ['end', interval.end],
    ] as const) {
      const minutes = localTimeToMinutes(timeInZone(instant, ctx.timeZone))
      if (minutes % granularity !== 0) {
        return {
          rule: 'BR-T7',
          message: `Please choose a ${label} time on a ${granularity}-minute boundary`,
        }
      }
    }
  }

  // BR-V3 / BR-V4
  if (durationMinutes < limits.minBookingMinutes) {
    return {
      rule: 'BR-V3',
      message: `This room has a minimum booking of ${formatMinutes(limits.minBookingMinutes)}`,
    }
  }
  if (durationMinutes > limits.maxBookingMinutes) {
    return {
      rule: 'BR-V4',
      message: `This room can be booked for at most ${formatMinutes(limits.maxBookingMinutes)} at a time`,
    }
  }

  // BR-V5: a small tolerance so a booking being created right now is allowed.
  if (startMs < now.getTime() - PAST_TOLERANCE_MINUTES * 60_000) {
    return { rule: 'BR-V5', message: 'That start time is in the past' }
  }

  if (!ctx.overrideWindows) {
    // BR-V7
    if (startMs < now.getTime() + limits.minNoticeMinutes * 60_000) {
      return {
        rule: 'BR-V7',
        message: `This room needs at least ${formatMinutes(limits.minNoticeMinutes)} notice`,
      }
    }

    // BR-V6
    const latest = now.getTime() + limits.maxAdvanceDays * 86_400_000
    if (startMs > latest) {
      return {
        rule: 'BR-V6',
        message: `This room can only be booked up to ${limits.maxAdvanceDays} days ahead`,
      }
    }
  }

  /*
   * BR-V8: the booking must sit entirely inside the bookable hours.
   *
   * Windows from every local date the booking touches are merged first, so an
   * overnight booking in a 24-hour room is allowed (its windows join up) while
   * one that crosses a closing time is not (a gap remains). Checking each date
   * separately could not distinguish those two cases.
   */
  const dates = localDatesInRange(interval.start, interval.end, ctx.timeZone)
  const windows: BookableWindow[] = []

  for (const date of dates) {
    const forDate = bookableWindowsOn(
      date,
      ctx.timeZone,
      ctx.roomHours,
      ctx.locationHours,
      ctx.orgHours,
      ctx.holidays,
    )
    if (forDate.length === 0) {
      return {
        rule: 'BR-V8',
        message: ctx.holidays.has(date)
          ? `The building is closed on ${date}`
          : `This room is not bookable on ${describeDate(date)}`,
      }
    }
    windows.push(...forDate)
  }

  // The day before may hold a window that runs past midnight into this one.
  const previous = bookableWindowsOn(
    addLocalDays(dates[0]!, -1),
    ctx.timeZone,
    ctx.roomHours,
    ctx.locationHours,
    ctx.orgHours,
    ctx.holidays,
  )
  windows.push(...previous)

  const merged = mergeIntervals(windows.map(w => ({ start: w.start, end: w.end })))
  const fits = merged.some(w => contains(w, interval))

  if (!fits) {
    const hours = windows
      .filter(w => w.date === dates[0])
      .map(w => `${timeInZone(w.start, ctx.timeZone)}-${timeInZone(w.end, ctx.timeZone)}`)
      .join(', ')
    return {
      rule: 'BR-V8',
      message: hours
        ? `This room is bookable ${hours} on ${describeDate(dates[0]!)}`
        : 'That time is outside this room bookable hours',
    }
  }

  return null
}

function describeDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y!, m! - 1, d!)))
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  const hours = minutes / 60
  if (Number.isInteger(hours)) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  return `${Math.floor(hours)}h ${minutes % 60}m`
}
