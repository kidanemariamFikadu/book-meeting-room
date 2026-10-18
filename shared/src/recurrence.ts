/**
 * Recurrence rule expansion.
 *
 * Hand-written rather than delegated to a library, for one reason: the rule
 * must be expanded in LOCAL CALENDAR terms and only then converted to UTC.
 *
 * A weekly 09:00 standup means 09:00 local every week — not "the same UTC
 * instant plus seven days", which drifts by an hour for half the year once the
 * clocks change. Most libraries expand to instants and leave that conversion
 * ambiguous; doing the calendar arithmetic ourselves keeps it explicit.
 *
 * Pure and dependency-free, so the browser can render a preview using exactly
 * the same expansion the server will store.
 *
 * Specification: docs/12-recurrence.md section 3.
 */

import { NonExistentLocalTimeError, formatLocal, parseLocalDateTime, zonedTimeToUtc } from './timezone.js'
import type { LocalDateTime } from './timezone.js'

export const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const
export type Frequency = (typeof FREQUENCIES)[number]

/** RFC 5545 weekday codes, in ISO order so index 0 is Monday. */
export const RRULE_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type RruleWeekday = (typeof RRULE_WEEKDAYS)[number]

export interface RecurrenceRule {
  freq: Frequency
  interval: number
  /** Required for WEEKLY; with `bySetPos` it selects "first Monday"-style rules. */
  byDay?: RruleWeekday[]
  byMonthDay?: number
  /** Which occurrence of the weekday in the month: 1 = first, -1 = last. */
  bySetPos?: number
  count?: number
  /** Inclusive end date, `YYYY-MM-DD`, in the series timezone. */
  until?: string
}

export interface ExpandOptions {
  /** First occurrence as local wall clock, `YYYY-MM-DDTHH:mm`. */
  dtstartLocal: string
  durationMinutes: number
  timeZone: string
  /** Stop once an occurrence would begin after this instant. */
  horizonUntil: Date
  /** Hard ceiling, so a runaway rule cannot be written. */
  maxOccurrences: number
}

export interface Occurrence {
  /** The scheduled local start. This is the `.ics` RECURRENCE-ID and it never changes. */
  occurrenceStartLocal: string
  start: Date
  end: Date
}

/** An occurrence the rule produced but which cannot exist. */
export interface SkippedOccurrence {
  occurrenceStartLocal: string
  reason: 'NON_EXISTENT_LOCAL_TIME'
}

export interface Expansion {
  occurrences: Occurrence[]
  skipped: SkippedOccurrence[]
  /** True when the horizon or the ceiling cut the expansion short. */
  truncated: boolean
}

export class InvalidRecurrenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRecurrenceError'
  }
}

// ---------------------------------------------------------------------------
// Local calendar arithmetic
// ---------------------------------------------------------------------------

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeap(year) ? 29 : DAYS_IN_MONTH[month - 1]!
}

/**
 * ISO weekday (Monday = 1) of a local date.
 *
 * Computed from UTC midnight purely as calendar arithmetic, so the host
 * timezone cannot influence it.
 */
function isoWeekdayOf(year: number, month: number, day: number): number {
  const d = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return d === 0 ? 7 : d
}

function addDays(local: LocalDateTime, days: number): LocalDateTime {
  const d = new Date(Date.UTC(local.year, local.month - 1, local.day + days))
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: local.hour,
    minute: local.minute,
  }
}

function addMonths(local: LocalDateTime, months: number): LocalDateTime {
  const total = local.year * 12 + (local.month - 1) + months
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  // Clamp rather than overflow: adding a month to 31 January gives 28 or 29
  // February, not 2 or 3 March. Rolling into the next month would move a
  // monthly meeting onto a different day each time.
  return { ...local, year, month, day: Math.min(local.day, daysInMonth(year, month)) }
}

const compareLocal = (a: string, b: string) => a.localeCompare(b)

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateRule(rule: RecurrenceRule): void {
  if (!FREQUENCIES.includes(rule.freq)) {
    throw new InvalidRecurrenceError(`Unsupported frequency: ${rule.freq}`)
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 52) {
    throw new InvalidRecurrenceError('Interval must be between 1 and 52')
  }
  if (rule.count !== undefined && rule.until !== undefined) {
    throw new InvalidRecurrenceError('Give either an occurrence count or an end date, not both')
  }
  if (rule.count !== undefined && (rule.count < 2 || rule.count > 500)) {
    throw new InvalidRecurrenceError('Occurrence count must be between 2 and 500')
  }
  if (rule.freq === 'WEEKLY' && (rule.byDay?.length ?? 0) === 0) {
    throw new InvalidRecurrenceError('A weekly rule needs at least one weekday')
  }
  if (rule.byDay?.some(d => !RRULE_WEEKDAYS.includes(d))) {
    throw new InvalidRecurrenceError('Unrecognised weekday')
  }
  if (rule.byMonthDay !== undefined && (rule.byMonthDay < 1 || rule.byMonthDay > 31)) {
    throw new InvalidRecurrenceError('Day of month must be between 1 and 31')
  }
  if (rule.bySetPos !== undefined && (rule.bySetPos < -1 || rule.bySetPos > 5 || rule.bySetPos === 0)) {
    throw new InvalidRecurrenceError('Position must be between 1 and 5, or -1 for the last')
  }
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Local start times the rule produces, as wall clock strings.
 *
 * Deliberately returns LOCAL times and performs no timezone conversion: that
 * happens once, afterwards, so the calendar logic and the instant logic cannot
 * become entangled.
 */
function expandLocal(rule: RecurrenceRule, dtstartLocal: string, limit: number): string[] {
  const start = parseLocalDateTime(dtstartLocal)
  const untilLocal = rule.until ? `${rule.until}T23:59` : null
  const results: string[] = []

  const emit = (local: LocalDateTime): boolean => {
    const formatted = formatLocal(local)
    if (untilLocal && compareLocal(formatted, untilLocal) > 0) return false
    results.push(formatted)
    return !(rule.count !== undefined && results.length >= rule.count) && results.length < limit
  }

  switch (rule.freq) {
    case 'DAILY': {
      let cursor = start
      for (let i = 0; i < limit * rule.interval + 1; i++) {
        if (!emit(cursor)) return results
        cursor = addDays(cursor, rule.interval)
      }
      return results
    }

    case 'WEEKLY': {
      const wanted = new Set((rule.byDay ?? []).map(d => RRULE_WEEKDAYS.indexOf(d) + 1))

      // Walk back to the Monday of the start week, so every selected weekday
      // in that first week is considered — including ones before dtstart,
      // which are then filtered out.
      const startWeekday = isoWeekdayOf(start.year, start.month, start.day)
      let weekStart = addDays(start, -(startWeekday - 1))

      for (let week = 0; week < limit + 2; week++) {
        for (let offset = 0; offset < 7; offset++) {
          const day = addDays(weekStart, offset)
          if (!wanted.has(isoWeekdayOf(day.year, day.month, day.day))) continue
          // Never before the series begins.
          if (compareLocal(formatLocal(day), dtstartLocal) < 0) continue
          if (!emit(day)) return results
        }
        weekStart = addDays(weekStart, 7 * rule.interval)
      }
      return results
    }

    case 'MONTHLY': {
      // Two shapes: a fixed day of the month, or the nth weekday of it.
      const nthWeekday = rule.bySetPos !== undefined && (rule.byDay?.length ?? 0) > 0
      let month = { ...start }

      for (let i = 0; i < limit + 2; i++) {
        if (nthWeekday) {
          const weekday = RRULE_WEEKDAYS.indexOf(rule.byDay![0]!) + 1
          const day = nthWeekdayOfMonth(month.year, month.month, weekday, rule.bySetPos!)
          if (day !== null) {
            const candidate = { ...month, day }
            if (compareLocal(formatLocal(candidate), dtstartLocal) >= 0) {
              if (!emit(candidate)) return results
            }
          }
        } else {
          const wantedDay = rule.byMonthDay ?? start.day
          // A rule for the 31st simply does not occur in a 30-day month,
          // rather than sliding to the 1st of the next one.
          if (wantedDay <= daysInMonth(month.year, month.month)) {
            const candidate = { ...month, day: wantedDay }
            if (compareLocal(formatLocal(candidate), dtstartLocal) >= 0) {
              if (!emit(candidate)) return results
            }
          }
        }
        month = addMonths({ ...month, day: 1 }, rule.interval)
      }
      return results
    }

    case 'YEARLY': {
      let cursor = start
      for (let i = 0; i < limit + 1; i++) {
        // 29 February only exists in a leap year, so a yearly rule on it
        // genuinely skips three years in four.
        if (cursor.day <= daysInMonth(cursor.year, cursor.month)) {
          if (!emit(cursor)) return results
        }
        cursor = { ...cursor, year: cursor.year + rule.interval }
      }
      return results
    }

    default:
      return results
  }
}

/** The nth given weekday of a month, or null when there is no such day. */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  isoWeekday: number,
  position: number,
): number | null {
  if (position === -1) {
    const last = daysInMonth(year, month)
    for (let day = last; day > last - 7; day--) {
      if (isoWeekdayOf(year, month, day) === isoWeekday) return day
    }
    return null
  }

  const firstMatch = (() => {
    for (let day = 1; day <= 7; day++) {
      if (isoWeekdayOf(year, month, day) === isoWeekday) return day
    }
    return null
  })()
  if (firstMatch === null) return null

  const day = firstMatch + (position - 1) * 7
  return day <= daysInMonth(year, month) ? day : null
}

/**
 * Expands a rule into concrete occurrences.
 *
 * Each local start is converted to UTC separately, which is what keeps a 09:00
 * meeting at 09:00 across a clock change. An occurrence whose local time does
 * not exist that day — the spring-forward gap — is REPORTED rather than nudged
 * to a nearby time, because a meeting at a time that never happened is a
 * meeting nobody can attend.
 */
export function expand(rule: RecurrenceRule, options: ExpandOptions): Expansion {
  validateRule(rule)

  const locals = expandLocal(rule, options.dtstartLocal, options.maxOccurrences + 1)

  const occurrences: Occurrence[] = []
  const skipped: SkippedOccurrence[] = []
  let truncated = false

  for (const local of locals) {
    if (occurrences.length >= options.maxOccurrences) {
      truncated = true
      break
    }

    let start: Date
    try {
      start = zonedTimeToUtc(parseLocalDateTime(local), options.timeZone).instant
    } catch (err) {
      if (err instanceof NonExistentLocalTimeError) {
        skipped.push({ occurrenceStartLocal: local, reason: 'NON_EXISTENT_LOCAL_TIME' })
        continue
      }
      throw err
    }

    if (start.getTime() > options.horizonUntil.getTime()) {
      truncated = true
      break
    }

    occurrences.push({
      occurrenceStartLocal: local,
      start,
      // Duration, not an end wall clock. Across a transition the local end
      // time may appear to jump, but the meeting is still the length it was
      // booked for, which is what the attendees agreed.
      end: new Date(start.getTime() + options.durationMinutes * 60_000),
    })
  }

  return { occurrences, skipped, truncated }
}

// ---------------------------------------------------------------------------
// RFC 5545 text
// ---------------------------------------------------------------------------

/** The rule as RRULE text, for storage and for `.ics`. */
export function toRruleText(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byDay?.length) {
    const prefix = rule.bySetPos !== undefined ? String(rule.bySetPos) : ''
    parts.push(`BYDAY=${rule.byDay.map(d => `${prefix}${d}`).join(',')}`)
  }
  if (rule.byMonthDay !== undefined) parts.push(`BYMONTHDAY=${rule.byMonthDay}`)
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`)
  if (rule.until) parts.push(`UNTIL=${rule.until.replace(/-/g, '')}T235959Z`)
  return parts.join(';')
}

export function parseRruleText(text: string): RecurrenceRule {
  const parts = new Map(
    text
      .split(';')
      .map(p => p.split('='))
      .filter((p): p is [string, string] => p.length === 2)
      .map(([k, v]) => [k.toUpperCase(), v]),
  )

  const freq = parts.get('FREQ') as Frequency | undefined
  if (!freq) throw new InvalidRecurrenceError('RRULE has no FREQ')

  const byDayRaw = parts.get('BYDAY')
  let bySetPos: number | undefined
  let byDay: RruleWeekday[] | undefined

  if (byDayRaw) {
    byDay = byDayRaw.split(',').map(token => {
      const match = /^(-?\d)?([A-Z]{2})$/.exec(token.trim())
      if (!match) throw new InvalidRecurrenceError(`Unrecognised BYDAY value: ${token}`)
      if (match[1]) bySetPos = Number(match[1])
      return match[2] as RruleWeekday
    })
  }

  const until = parts.get('UNTIL')

  const rule: RecurrenceRule = {
    freq,
    interval: parts.has('INTERVAL') ? Number(parts.get('INTERVAL')) : 1,
    ...(byDay ? { byDay } : {}),
    ...(bySetPos !== undefined ? { bySetPos } : {}),
    ...(parts.has('BYMONTHDAY') ? { byMonthDay: Number(parts.get('BYMONTHDAY')) } : {}),
    ...(parts.has('COUNT') ? { count: Number(parts.get('COUNT')) } : {}),
    ...(until ? { until: `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` } : {}),
  }

  validateRule(rule)
  return rule
}

const DAY_NAMES: Record<RruleWeekday, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
}

const ORDINALS: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth' }

/**
 * The rule in plain English.
 *
 * Shown live under the recurrence editor: restating the rule in words is the
 * cheapest way to stop someone accidentally booking a room three hundred
 * times.
 */
export function describeRule(rule: RecurrenceRule, dtstartLocal?: string): string {
  const every = rule.interval === 1 ? '' : `${rule.interval} `

  let base: string
  switch (rule.freq) {
    case 'DAILY':
      base = rule.interval === 1 ? 'Every day' : `Every ${every}days`
      break
    case 'WEEKLY': {
      const days = (rule.byDay ?? []).map(d => DAY_NAMES[d])
      const list =
        days.length <= 1
          ? (days[0] ?? '')
          : `${days.slice(0, -1).join(', ')} and ${days.at(-1)}`
      const weekdaysOnly =
        days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every(d => rule.byDay?.includes(d as RruleWeekday))
      if (weekdaysOnly && rule.interval === 1) base = 'Every weekday'
      else base = rule.interval === 1 ? `Every ${list}` : `Every ${every}weeks on ${list}`
      break
    }
    case 'MONTHLY':
      if (rule.bySetPos !== undefined && rule.byDay?.length) {
        const which = rule.bySetPos === -1 ? 'last' : (ORDINALS[rule.bySetPos] ?? `${rule.bySetPos}th`)
        base = `The ${which} ${DAY_NAMES[rule.byDay[0]!]} of every ${every}month`
      } else {
        const day = rule.byMonthDay ?? (dtstartLocal ? Number(dtstartLocal.slice(8, 10)) : 1)
        base = `Day ${day} of every ${every}month`
      }
      break
    case 'YEARLY':
      base = rule.interval === 1 ? 'Every year' : `Every ${every}years`
      break
    default:
      base = 'Repeats'
  }

  const time = dtstartLocal ? ` at ${dtstartLocal.slice(11, 16)}` : ''

  let ending = ''
  if (rule.count !== undefined) ending = `, ${rule.count} times`
  else if (rule.until) ending = `, until ${rule.until}`

  return `${base}${time}${ending}`
}
