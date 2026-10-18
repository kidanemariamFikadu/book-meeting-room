/**
 * Timezone conversion.
 *
 * The single most common source of bugs in a booking system, so this is a
 * small, explicit module with heavy test coverage rather than offset
 * arithmetic scattered through the services.
 *
 * Built on `Intl` alone, so it runs unchanged in Node and the browser and
 * carries no dependency. It uses the IANA database the platform already ships,
 * which means DST rules stay correct without us shipping updates.
 *
 * Specification: docs/02-architecture.md section 11, docs/04-business-rules.md section 1.
 */

/** A local wall-clock time, with no offset: what a person means by "14:00". */
export interface LocalDateTime {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
}

export class NonExistentLocalTimeError extends Error {
  constructor(local: string, timeZone: string) {
    super(`${local} does not exist in ${timeZone} - the clocks move forward over that time`)
    this.name = 'NonExistentLocalTimeError'
  }
}

export class InvalidTimeZoneError extends Error {
  constructor(timeZone: string) {
    super(`${timeZone} is not a recognised IANA timezone`)
    this.name = 'InvalidTimeZoneError'
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    } catch {
      throw new InvalidTimeZoneError(timeZone)
    }
    formatterCache.set(timeZone, f)
  }
  return f
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone)
    return true
  } catch {
    return false
  }
}

/** The wall-clock time in `timeZone` at the given instant. */
export function toLocalParts(instant: Date, timeZone: string): LocalDateTime & { second: number } {
  const parts = formatterFor(timeZone).formatToParts(instant)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // h23 renders midnight as 24 in some engines; normalise it.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  }
}

/**
 * The zone offset in minutes at a given instant (positive east of UTC).
 *
 * Derived by formatting the instant into the zone and reading the difference,
 * which is the only approach that is correct for every zone and every historic
 * rule change.
 */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const p = toLocalParts(instant, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // Round to the minute: Intl gives whole seconds, and historic zones can have
  // sub-minute offsets that would otherwise produce fractional results.
  return Math.round((asIfUtc - instant.getTime()) / 60_000)
}

function partsEqual(a: LocalDateTime, b: LocalDateTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  )
}

export interface ZonedConversion {
  instant: Date
  /** True when the clocks went back and this wall-clock time happened twice. */
  ambiguous: boolean
}

/**
 * Converts a wall-clock time in a zone to the UTC instant it refers to.
 *
 * Three cases, and all three matter:
 *
 *  - Normal: one instant maps to this local time.
 *  - **Ambiguous** (clocks go back): two do. The EARLIER is chosen, per BR-T8.
 *  - **Non-existent** (clocks go forward): none do, and this throws rather
 *    than silently snapping to a nearby time. A booking at a time that did not
 *    happen is a booking nobody can attend.
 */
export function zonedTimeToUtc(local: LocalDateTime, timeZone: string): ZonedConversion {
  const asIfUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)

  // Two candidate offsets: the one in force shortly before and shortly after.
  // Any DST transition is bracketed by these, so testing both finds every
  // valid instant without searching.
  const before = offsetMinutesAt(new Date(asIfUtc - 86_400_000), timeZone)
  const after = offsetMinutesAt(new Date(asIfUtc + 86_400_000), timeZone)

  const candidates: number[] = []
  for (const offset of new Set([before, after])) {
    const candidate = asIfUtc - offset * 60_000
    // A candidate is real only if formatting it back yields the requested
    // wall clock. This is what detects the spring-forward gap.
    if (partsEqual(toLocalParts(new Date(candidate), timeZone), local)) {
      candidates.push(candidate)
    }
  }

  if (candidates.length === 0) throw new NonExistentLocalTimeError(formatLocal(local), timeZone)

  candidates.sort((a, b) => a - b)
  return { instant: new Date(candidates[0]!), ambiguous: candidates.length > 1 }
}

/** Parses `YYYY-MM-DDTHH:mm` (or with seconds) into local parts. */
export function parseLocalDateTime(value: string): LocalDateTime {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value)
  if (!m) throw new Error(`Expected YYYY-MM-DDTHH:mm, received "${value}"`)
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  }
}

export function formatLocal(local: LocalDateTime): string {
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${local.year}-${p2(local.month)}-${p2(local.day)}T${p2(local.hour)}:${p2(local.minute)}`
}

/** The wall-clock time at an instant, as `YYYY-MM-DDTHH:mm`. */
export function formatInZone(instant: Date, timeZone: string): string {
  return formatLocal(toLocalParts(instant, timeZone))
}

/** The calendar date at an instant, as `YYYY-MM-DD`. */
export function dateInZone(instant: Date, timeZone: string): string {
  return formatInZone(instant, timeZone).slice(0, 10)
}

/** `HH:mm` at an instant. */
export function timeInZone(instant: Date, timeZone: string): string {
  return formatInZone(instant, timeZone).slice(11, 16)
}

/** ISO weekday (Monday = 1) of the local date at an instant. */
export function isoWeekdayInZone(instant: Date, timeZone: string): number {
  const p = toLocalParts(instant, timeZone)
  // Date.UTC with the local parts gives a date whose UTC weekday is the local
  // one, avoiding any dependence on the host zone.
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  return day === 0 ? 7 : day
}

/**
 * The UTC instant at which a local calendar day begins in a zone.
 *
 * On a day when the clocks move forward at midnight, 00:00 does not exist, so
 * this walks forward to the first minute that does.
 */
export function startOfLocalDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  for (let hour = 0; hour < 4; hour++) {
    try {
      return zonedTimeToUtc({ year: y!, month: m!, day: d!, hour, minute: 0 }, timeZone).instant
    } catch {
      // Midnight did not exist here; try the next hour.
    }
  }
  throw new Error(`Could not resolve the start of ${date} in ${timeZone}`)
}

/** The UTC instant at which the local day ends (exclusive). */
export function endOfLocalDay(date: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1))
  return startOfLocalDay(dateInZone(next, 'UTC'), timeZone)
}

/** Adds whole days to a `YYYY-MM-DD` string, staying in the calendar. */
export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(Date.UTC(y!, m! - 1, d! + days))
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${next.getUTCFullYear()}-${p2(next.getUTCMonth() + 1)}-${p2(next.getUTCDate())}`
}

/** Every local date touched by a UTC range, inclusive of both ends. */
export function localDatesInRange(start: Date, end: Date, timeZone: string): string[] {
  const dates: string[] = []
  let cursor = dateInZone(start, timeZone)
  // `end` is exclusive, so a range ending exactly at local midnight does not
  // reach into the following day.
  const last = dateInZone(new Date(end.getTime() - 1), timeZone)
  // A hard stop guards against a malformed range producing an endless loop.
  for (let i = 0; i < 400 && cursor <= last; i++) {
    dates.push(cursor)
    cursor = addLocalDays(cursor, 1)
  }
  return dates
}

/** `HH:mm` as minutes from local midnight. */
export function localTimeToMinutes(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) throw new Error(`Expected HH:mm, received "${hhmm}"`)
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * Formats an instant for display, in the viewer's zone, with the zone named.
 *
 * The abbreviation is never omitted: a time shown without its zone is how
 * people dial into a cross-timezone meeting an hour late.
 */
export function formatForDisplay(
  instant: Date,
  timeZone: string,
  opts: { withDate?: boolean } = {},
): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(instant)

  if (!opts.withDate) return time

  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(instant)

  return `${date}, ${time}`
}
