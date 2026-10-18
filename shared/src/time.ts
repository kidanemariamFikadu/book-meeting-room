/**
 * Time and interval helpers.
 *
 * These are pure functions with no dependency on the database, Express or
 * React, and they run identically on the server and in the browser. They are
 * the single most heavily tested part of the system, because almost every
 * subtle bug in a booking product lives in this file's subject matter.
 *
 * Specification: docs/04-business-rules.md section 1, docs/02-architecture.md section 11.
 */

/** A half-open instant range: includes `start`, excludes `end`. */
export interface Interval {
  start: Date
  end: Date
}

/**
 * Do two ranges overlap?
 *
 * Ranges are HALF-OPEN — `[start, end)` — so a booking 09:00-10:00 and one
 * 10:00-11:00 do NOT overlap. The strict inequalities are what make
 * back-to-back bookings legal (BR-T2); using `<=` here would be the single
 * most user-visible bug the system could ship.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime()
}

/** Is `inner` entirely within `outer`? Used for bookable-hours checks (BR-V8). */
export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start.getTime() <= inner.start.getTime() && inner.end.getTime() <= outer.end.getTime()
}

/** Duration in whole minutes. Negative if the range is inverted. */
export function durationMinutes({ start, end }: Interval): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000)
}

/** A range is valid only if it moves forward in time (BR-T3). */
export function isValidInterval({ start, end }: Interval): boolean {
  return (
    Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime()) &&
    start.getTime() < end.getTime()
  )
}

/**
 * Does the instant fall on a slot boundary, measured from local midnight (BR-T7)?
 * `offsetMinutes` is the zone offset at that instant, which the caller resolves —
 * this function deliberately performs no timezone lookup of its own.
 */
export function isOnSlotBoundary(d: Date, granularityMinutes: number, offsetMinutes = 0): boolean {
  if (granularityMinutes <= 0) return true
  const localMinutes = Math.floor(d.getTime() / 60_000) + offsetMinutes
  return localMinutes % granularityMinutes === 0
}

/** Merge overlapping or touching ranges into the smallest equivalent set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((x, y) => x.start.getTime() - y.start.getTime())
  const merged: Interval[] = []
  // `sorted` is non-empty, so index 0 exists; the loop then always has a tail.
  let current: Interval = { start: sorted[0]!.start, end: sorted[0]!.end }
  for (const next of sorted.slice(1)) {
    if (next.start.getTime() <= current.end.getTime()) {
      if (next.end.getTime() > current.end.getTime()) current = { ...current, end: next.end }
    } else {
      merged.push(current)
      current = { start: next.start, end: next.end }
    }
  }
  merged.push(current)
  return merged
}

/**
 * Subtract `busy` ranges from `window`, returning what remains free.
 * This is how the calendar grid turns bookings into bookable gaps.
 */
export function subtractIntervals(window: Interval, busy: Interval[]): Interval[] {
  const free: Interval[] = []
  let cursor = window.start
  for (const b of mergeIntervals(busy)) {
    if (b.end.getTime() <= cursor.getTime()) continue
    if (b.start.getTime() >= window.end.getTime()) break
    if (b.start.getTime() > cursor.getTime()) {
      free.push({ start: cursor, end: new Date(Math.min(b.start.getTime(), window.end.getTime())) })
    }
    if (b.end.getTime() > cursor.getTime()) cursor = b.end
  }
  if (cursor.getTime() < window.end.getTime()) free.push({ start: cursor, end: window.end })
  return free.filter(isValidInterval)
}

/** ISO weekday, Monday = 1 through Sunday = 7, as `business_days` stores it. */
export function isoWeekday(d: Date): number {
  const js = d.getUTCDay() // 0 = Sunday
  return js === 0 ? 7 : js
}

/** Parse `"HH:mm"` into minutes from midnight. Returns null if malformed. */
export function parseLocalTime(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** Format minutes from midnight as `"HH:mm"`. */
export function formatLocalTime(minutesFromMidnight: number): string {
  const total = ((minutesFromMidnight % 1440) + 1440) % 1440
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000)
}

/**
 * Resolve the effective value of a setting through the inheritance chain
 * room -> location -> organization -> built-in default.
 *
 * `null` and `undefined` mean "inherit". An explicit `0` is a REAL value and
 * must not fall through — that distinction is the most common source of
 * configuration bugs in this system, hence a single shared implementation
 * (docs/14-multi-location.md section 4, test T-166).
 */
export function resolveSetting<T>(...levels: Array<T | null | undefined>): T | undefined {
  for (const level of levels) {
    if (level !== null && level !== undefined) return level
  }
  return undefined
}
