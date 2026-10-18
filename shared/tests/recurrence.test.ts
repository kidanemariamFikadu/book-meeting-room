/**
 * Recurrence expansion.
 *
 * Case IDs refer to docs/12-recurrence.md section 10. The DST tests are the
 * reason this module exists: a weekly 09:00 meeting must stay at 09:00 local.
 */

import { describe, expect, it } from 'vitest'

import {
  InvalidRecurrenceError,
  describeRule,
  expand,
  parseRruleText,
  toRruleText,
  type RecurrenceRule,
} from '../src/recurrence.js'
import { formatInZone, timeInZone } from '../src/timezone.js'

const LONDON = 'Europe/London'
const ADDIS = 'Africa/Addis_Ababa'

const run = (
  rule: RecurrenceRule,
  dtstartLocal: string,
  opts: { timeZone?: string; horizonDays?: number; max?: number; durationMinutes?: number } = {},
) =>
  expand(rule, {
    dtstartLocal,
    durationMinutes: opts.durationMinutes ?? 30,
    timeZone: opts.timeZone ?? ADDIS,
    horizonUntil: new Date(
      new Date(`${dtstartLocal.slice(0, 10)}T00:00:00Z`).getTime() +
        (opts.horizonDays ?? 400) * 86_400_000,
    ),
    maxOccurrences: opts.max ?? 500,
  })

const localsOf = (e: ReturnType<typeof expand>) => e.occurrences.map(o => o.occurrenceStartLocal)

// ---------------------------------------------------------------------------

describe('daily', () => {
  it('repeats every day', () => {
    const e = run({ freq: 'DAILY', interval: 1, count: 4 }, '2026-11-04T09:00')
    expect(localsOf(e)).toEqual([
      '2026-11-04T09:00',
      '2026-11-05T09:00',
      '2026-11-06T09:00',
      '2026-11-07T09:00',
    ])
  })

  it('honours an interval', () => {
    const e = run({ freq: 'DAILY', interval: 3, count: 3 }, '2026-11-04T09:00')
    expect(localsOf(e)).toEqual(['2026-11-04T09:00', '2026-11-07T09:00', '2026-11-10T09:00'])
  })

  it('crosses a month boundary', () => {
    const e = run({ freq: 'DAILY', interval: 1, count: 3 }, '2026-01-30T09:00')
    expect(localsOf(e)).toEqual([
      '2026-01-30T09:00',
      '2026-01-31T09:00',
      '2026-02-01T09:00',
    ])
  })
})

describe('weekly', () => {
  it('repeats on the chosen weekdays', () => {
    // 4 November 2026 is a Wednesday.
    const e = run({ freq: 'WEEKLY', interval: 1, byDay: ['TU', 'TH'], count: 4 }, '2026-11-04T09:00')
    expect(localsOf(e)).toEqual([
      '2026-11-05T09:00', // Thu
      '2026-11-10T09:00', // Tue
      '2026-11-12T09:00', // Thu
      '2026-11-17T09:00', // Tue
    ])
  })

  it('includes the start day when it matches', () => {
    const e = run({ freq: 'WEEKLY', interval: 1, byDay: ['WE'], count: 2 }, '2026-11-04T09:00')
    expect(localsOf(e)).toEqual(['2026-11-04T09:00', '2026-11-11T09:00'])
  })

  /** Never before the series begins, even for an earlier weekday that week. */
  it('does not emit a day earlier in the starting week', () => {
    // Starts Wednesday; Monday of that week must not appear.
    const e = run({ freq: 'WEEKLY', interval: 1, byDay: ['MO'], count: 2 }, '2026-11-04T09:00')
    expect(localsOf(e)[0]).toBe('2026-11-09T09:00')
  })

  it('handles every weekday', () => {
    const e = run(
      { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], count: 6 },
      '2026-11-02T09:00',
    )
    expect(localsOf(e)).toEqual([
      '2026-11-02T09:00',
      '2026-11-03T09:00',
      '2026-11-04T09:00',
      '2026-11-05T09:00',
      '2026-11-06T09:00',
      '2026-11-09T09:00', // skips the weekend
    ])
  })

  it('honours a fortnightly interval', () => {
    const e = run({ freq: 'WEEKLY', interval: 2, byDay: ['WE'], count: 3 }, '2026-11-04T09:00')
    expect(localsOf(e)).toEqual(['2026-11-04T09:00', '2026-11-18T09:00', '2026-12-02T09:00'])
  })

  it('stops at an until date', () => {
    const e = run(
      { freq: 'WEEKLY', interval: 1, byDay: ['WE'], until: '2026-11-18' },
      '2026-11-04T09:00',
    )
    expect(localsOf(e)).toEqual(['2026-11-04T09:00', '2026-11-11T09:00', '2026-11-18T09:00'])
  })
})

describe('monthly', () => {
  it('repeats on a fixed day of the month', () => {
    const e = run({ freq: 'MONTHLY', interval: 1, byMonthDay: 15, count: 3 }, '2026-01-15T09:00')
    expect(localsOf(e)).toEqual(['2026-01-15T09:00', '2026-02-15T09:00', '2026-03-15T09:00'])
  })

  /**
   * A rule for the 31st simply does not occur in a 30-day month. Sliding to
   * the 1st of the next month would move the meeting to a different day.
   */
  it('skips months that have no such day rather than sliding', () => {
    const e = run({ freq: 'MONTHLY', interval: 1, byMonthDay: 31, count: 4 }, '2026-01-31T09:00')
    expect(localsOf(e)).toEqual([
      '2026-01-31T09:00',
      '2026-03-31T09:00', // no 31 February
      '2026-05-31T09:00', // no 31 April
      '2026-07-31T09:00', // no 31 June
    ])
  })

  it('repeats on the nth weekday of the month', () => {
    // First Monday of each month.
    const e = run(
      { freq: 'MONTHLY', interval: 1, byDay: ['MO'], bySetPos: 1, count: 3 },
      '2026-11-02T09:00',
    )
    expect(localsOf(e)).toEqual(['2026-11-02T09:00', '2026-12-07T09:00', '2027-01-04T09:00'])
  })

  it('repeats on the last weekday of the month', () => {
    const e = run(
      { freq: 'MONTHLY', interval: 1, byDay: ['FR'], bySetPos: -1, count: 3 },
      '2026-11-27T09:00',
    )
    expect(localsOf(e)).toEqual(['2026-11-27T09:00', '2026-12-25T09:00', '2027-01-29T09:00'])
  })
})

describe('yearly', () => {
  it('repeats annually', () => {
    const e = run({ freq: 'YEARLY', interval: 1, count: 3 }, '2026-07-04T09:00', {
      horizonDays: 1200,
    })
    expect(localsOf(e)).toEqual(['2026-07-04T09:00', '2027-07-04T09:00', '2028-07-04T09:00'])
  })

  /** 29 February exists in one year of four, and a yearly rule respects that. */
  it('skips non-leap years for a 29 February rule', () => {
    const e = run({ freq: 'YEARLY', interval: 1, count: 2 }, '2028-02-29T09:00', {
      horizonDays: 3000,
    })
    expect(localsOf(e)).toEqual(['2028-02-29T09:00', '2032-02-29T09:00'])
  })
})

// ---------------------------------------------------------------------------

describe('daylight saving', () => {
  /**
   * T-120/T-121. The reason this module expands in local calendar terms.
   *
   * The UK clocks go back on 25 October 2026. A weekly 09:00 standup must
   * remain at 09:00 local on both sides of that.
   */
  it('T-121: keeps a weekly meeting at the same local time across the autumn change', () => {
    const e = run(
      { freq: 'WEEKLY', interval: 1, byDay: ['TU'], count: 3 },
      '2026-10-20T09:00',
      { timeZone: LONDON },
    )

    for (const occurrence of e.occurrences) {
      expect(timeInZone(occurrence.start, LONDON)).toBe('09:00')
    }

    // The UTC gap across the transition is 169 hours, not 168. That is
    // correct: the clocks moved, the meeting did not.
    const [first, second] = e.occurrences
    expect((second!.start.getTime() - first!.start.getTime()) / 3_600_000).toBe(169)
  })

  it('T-120: keeps a weekly meeting steady across the spring change', () => {
    const e = run(
      { freq: 'WEEKLY', interval: 1, byDay: ['SU'], count: 3 },
      '2026-03-22T09:00',
      { timeZone: LONDON },
    )

    for (const occurrence of e.occurrences) {
      expect(timeInZone(occurrence.start, LONDON)).toBe('09:00')
    }
    const [first, second] = e.occurrences
    expect((second!.start.getTime() - first!.start.getTime()) / 3_600_000).toBe(167)
  })

  it('is unaffected in a zone that never changes its clocks', () => {
    const e = run({ freq: 'WEEKLY', interval: 1, byDay: ['TU'], count: 3 }, '2026-10-20T09:00')
    const [first, second] = e.occurrences
    expect((second!.start.getTime() - first!.start.getTime()) / 3_600_000).toBe(168)
  })

  /**
   * T-122. An occurrence at a local time that does not exist is REPORTED, not
   * nudged. A meeting at a time that never happened is one nobody can attend.
   */
  it('T-122: reports an occurrence landing in the spring-forward gap', () => {
    // The UK clocks jump from 01:00 to 02:00 on 29 March 2026, so 01:30 does
    // not exist that day.
    const e = run(
      { freq: 'WEEKLY', interval: 1, byDay: ['SU'], count: 3 },
      '2026-03-22T01:30',
      { timeZone: LONDON },
    )

    expect(e.skipped).toHaveLength(1)
    expect(e.skipped[0]).toEqual({
      occurrenceStartLocal: '2026-03-29T01:30',
      reason: 'NON_EXISTENT_LOCAL_TIME',
    })
    // The rest still happen.
    expect(localsOf(e)).toEqual(['2026-03-22T01:30', '2026-04-05T01:30'])
  })

  it('keeps the duration constant across a transition', () => {
    const e = run(
      { freq: 'WEEKLY', interval: 1, byDay: ['SU'], count: 2 },
      '2026-10-25T01:30',
      { timeZone: LONDON, durationMinutes: 60 },
    )
    for (const occurrence of e.occurrences) {
      expect((occurrence.end.getTime() - occurrence.start.getTime()) / 60_000).toBe(60)
    }
  })

  it('renders each occurrence back to the expected local time', () => {
    const e = run({ freq: 'DAILY', interval: 1, count: 5 }, '2026-03-27T09:00', {
      timeZone: LONDON,
    })
    for (const occurrence of e.occurrences) {
      expect(formatInZone(occurrence.start, LONDON)).toBe(occurrence.occurrenceStartLocal)
    }
  })
})

// ---------------------------------------------------------------------------

describe('limits', () => {
  /** T-132. A hard ceiling, so a runaway rule cannot be written. */
  it('T-132: truncates at the occurrence ceiling', () => {
    const e = run({ freq: 'DAILY', interval: 1 }, '2026-01-01T09:00', { max: 10 })
    expect(e.occurrences).toHaveLength(10)
    expect(e.truncated).toBe(true)
  })

  it('truncates at the horizon', () => {
    const e = run({ freq: 'DAILY', interval: 1 }, '2026-01-01T09:00', { horizonDays: 5, max: 500 })
    expect(e.occurrences.length).toBeLessThanOrEqual(6)
    expect(e.truncated).toBe(true)
  })

  it('is not truncated when the rule ends on its own', () => {
    const e = run({ freq: 'DAILY', interval: 1, count: 3 }, '2026-01-01T09:00')
    expect(e.occurrences).toHaveLength(3)
    expect(e.truncated).toBe(false)
  })
})

describe('validation', () => {
  it('rejects a weekly rule with no weekday', () => {
    expect(() => run({ freq: 'WEEKLY', interval: 1 }, '2026-11-04T09:00')).toThrow(
      InvalidRecurrenceError,
    )
  })

  it('rejects both a count and an end date', () => {
    expect(() =>
      run({ freq: 'DAILY', interval: 1, count: 5, until: '2026-12-31' }, '2026-11-04T09:00'),
    ).toThrow(/either an occurrence count or an end date/)
  })

  it('rejects an absurd interval', () => {
    expect(() => run({ freq: 'DAILY', interval: 0 }, '2026-11-04T09:00')).toThrow(
      InvalidRecurrenceError,
    )
  })

  it('rejects a count beyond the ceiling', () => {
    expect(() => run({ freq: 'DAILY', interval: 1, count: 9999 }, '2026-11-04T09:00')).toThrow(
      InvalidRecurrenceError,
    )
  })
})

// ---------------------------------------------------------------------------

describe('RRULE text', () => {
  it('round-trips through text', () => {
    const rules: RecurrenceRule[] = [
      { freq: 'DAILY', interval: 1 },
      { freq: 'WEEKLY', interval: 2, byDay: ['TU', 'TH'] },
      { freq: 'WEEKLY', interval: 1, byDay: ['MO'], until: '2027-12-31' },
      { freq: 'MONTHLY', interval: 1, byMonthDay: 15 },
      { freq: 'MONTHLY', interval: 1, byDay: ['MO'], bySetPos: 1 },
      { freq: 'DAILY', interval: 1, count: 10 },
    ]

    for (const rule of rules) {
      const text = toRruleText(rule)
      const parsed = parseRruleText(text)
      expect(toRruleText(parsed), text).toBe(text)
    }
  })

  it('writes standard RRULE text', () => {
    expect(toRruleText({ freq: 'WEEKLY', interval: 1, byDay: ['TU'] })).toBe('FREQ=WEEKLY;BYDAY=TU')
    expect(toRruleText({ freq: 'WEEKLY', interval: 2, byDay: ['MO', 'WE'] })).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE',
    )
    expect(toRruleText({ freq: 'MONTHLY', interval: 1, byDay: ['FR'], bySetPos: -1 })).toBe(
      'FREQ=MONTHLY;BYDAY=-1FR',
    )
  })

  it('parses an nth-weekday BYDAY', () => {
    const rule = parseRruleText('FREQ=MONTHLY;BYDAY=1MO')
    expect(rule.bySetPos).toBe(1)
    expect(rule.byDay).toEqual(['MO'])
  })

  it('rejects text with no FREQ', () => {
    expect(() => parseRruleText('INTERVAL=2')).toThrow(InvalidRecurrenceError)
  })
})

// ---------------------------------------------------------------------------

describe('plain English', () => {
  /** Restating the rule in words is what stops someone booking 300 times. */
  it('describes the common rules readably', () => {
    const cases: Array<[RecurrenceRule, string, string]> = [
      [{ freq: 'DAILY', interval: 1 }, '2026-11-04T09:00', 'Every day at 09:00'],
      [{ freq: 'DAILY', interval: 3 }, '2026-11-04T09:00', 'Every 3 days at 09:00'],
      [
        { freq: 'WEEKLY', interval: 1, byDay: ['TU'] },
        '2026-11-04T09:00',
        'Every Tuesday at 09:00',
      ],
      [
        { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] },
        '2026-11-04T09:00',
        'Every weekday at 09:00',
      ],
      [
        { freq: 'WEEKLY', interval: 1, byDay: ['TU', 'TH'] },
        '2026-11-04T09:00',
        'Every Tuesday and Thursday at 09:00',
      ],
      [
        { freq: 'MONTHLY', interval: 1, byDay: ['MO'], bySetPos: 1 },
        '2026-11-02T09:00',
        'The first Monday of every month at 09:00',
      ],
      [
        { freq: 'MONTHLY', interval: 1, byDay: ['FR'], bySetPos: -1 },
        '2026-11-27T09:00',
        'The last Friday of every month at 09:00',
      ],
      [{ freq: 'MONTHLY', interval: 1, byMonthDay: 15 }, '2026-11-15T09:00', 'Day 15 of every month at 09:00'],
    ]

    for (const [rule, dtstart, expected] of cases) {
      expect(describeRule(rule, dtstart)).toBe(expected)
    }
  })

  it('states how the series ends', () => {
    expect(describeRule({ freq: 'WEEKLY', interval: 1, byDay: ['TU'], count: 52 }, '2026-11-04T09:00')).toBe(
      'Every Tuesday at 09:00, 52 times',
    )
    expect(
      describeRule({ freq: 'WEEKLY', interval: 1, byDay: ['TU'], until: '2027-12-31' }, '2026-11-04T09:00'),
    ).toBe('Every Tuesday at 09:00, until 2027-12-31')
  })
})
