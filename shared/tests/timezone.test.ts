/**
 * Timezone conversion, including the DST cases that break booking systems.
 *
 * Case IDs refer to docs/10-testing.md.
 */

import { describe, expect, it } from 'vitest'

import {
  NonExistentLocalTimeError,
  addLocalDays,
  dateInZone,
  endOfLocalDay,
  formatInZone,
  isoWeekdayInZone,
  isValidTimeZone,
  localDatesInRange,
  offsetMinutesAt,
  parseLocalDateTime,
  startOfLocalDay,
  zonedTimeToUtc,
} from '../src/timezone.js'

const LONDON = 'Europe/London'
const ADDIS = 'Africa/Addis_Ababa'
const NY = 'America/New_York'

const local = (s: string) => parseLocalDateTime(s)
const utc = (s: string, tz: string) => zonedTimeToUtc(local(s), tz).instant.toISOString()

describe('offset', () => {
  it('reads a fixed-offset zone', () => {
    // Addis Ababa is UTC+3 all year; it has never observed DST.
    expect(offsetMinutesAt(new Date('2026-01-15T00:00:00Z'), ADDIS)).toBe(180)
    expect(offsetMinutesAt(new Date('2026-07-15T00:00:00Z'), ADDIS)).toBe(180)
  })

  it('reads a zone that observes DST', () => {
    expect(offsetMinutesAt(new Date('2026-01-15T12:00:00Z'), LONDON)).toBe(0) // GMT
    expect(offsetMinutesAt(new Date('2026-07-15T12:00:00Z'), LONDON)).toBe(60) // BST
  })

  it('rejects an unknown zone', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(isValidTimeZone(LONDON)).toBe(true)
  })
})

describe('zonedTimeToUtc', () => {
  it('converts an ordinary time', () => {
    expect(utc('2026-11-04T09:00', ADDIS)).toBe('2026-11-04T06:00:00.000Z')
    expect(utc('2026-01-15T09:00', LONDON)).toBe('2026-01-15T09:00:00.000Z')
    expect(utc('2026-07-15T09:00', LONDON)).toBe('2026-07-15T08:00:00.000Z')
  })

  it('round-trips through formatInZone', () => {
    for (const [value, tz] of [
      ['2026-03-10T14:30', NY],
      ['2026-11-04T09:00', ADDIS],
      ['2026-06-21T23:45', LONDON],
    ] as const) {
      const instant = zonedTimeToUtc(local(value), tz).instant
      expect(formatInZone(instant, tz)).toBe(value)
    }
  })

  /**
   * T-32. The clocks go forward at 01:00 on 29 March 2026 in London, so
   * 01:30 never happens. Snapping silently to 02:30 would put a meeting at a
   * time nobody agreed to.
   */
  it('T-32: throws for a non-existent local time (spring forward)', () => {
    expect(() => zonedTimeToUtc(local('2026-03-29T01:30'), LONDON)).toThrow(
      NonExistentLocalTimeError,
    )
    // New York springs forward at 02:00 on 8 March 2026.
    expect(() => zonedTimeToUtc(local('2026-03-08T02:30'), NY)).toThrow(NonExistentLocalTimeError)
  })

  it('accepts the times either side of the gap', () => {
    expect(() => zonedTimeToUtc(local('2026-03-29T00:59'), LONDON)).not.toThrow()
    expect(() => zonedTimeToUtc(local('2026-03-29T02:00'), LONDON)).not.toThrow()
  })

  /**
   * T-31 / BR-T8. The clocks go back at 02:00 on 25 October 2026 in London, so
   * 01:30 happens twice. The EARLIER instant is chosen.
   */
  it('T-31: resolves an ambiguous local time to the earlier instant', () => {
    const result = zonedTimeToUtc(local('2026-10-25T01:30'), LONDON)
    expect(result.ambiguous).toBe(true)
    // 01:30 BST is 00:30Z; 01:30 GMT is 01:30Z. The earlier wins.
    expect(result.instant.toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })

  it('marks unambiguous times as such', () => {
    expect(zonedTimeToUtc(local('2026-06-01T12:00'), LONDON).ambiguous).toBe(false)
  })
})

describe('DST and duration', () => {
  /**
   * T-120 in spirit: a recurring 09:00 meeting must stay at 09:00 LOCAL across
   * a transition. Storing a UTC start and adding 7 days would drift it by an
   * hour for half the year.
   */
  it('keeps a weekly 09:00 meeting at 09:00 local across the autumn change', () => {
    const before = zonedTimeToUtc(local('2026-10-20T09:00'), LONDON).instant
    const after = zonedTimeToUtc(local('2026-10-27T09:00'), LONDON).instant

    expect(formatInZone(before, LONDON)).toBe('2026-10-20T09:00')
    expect(formatInZone(after, LONDON)).toBe('2026-10-27T09:00')

    // The UTC gap is 169 hours, not 168: the clocks went back in between, and
    // that is correct rather than a bug.
    const hours = (after.getTime() - before.getTime()) / 3_600_000
    expect(hours).toBe(169)
  })

  it('keeps the same meeting steady in a zone without DST', () => {
    const before = zonedTimeToUtc(local('2026-10-20T09:00'), ADDIS).instant
    const after = zonedTimeToUtc(local('2026-10-27T09:00'), ADDIS).instant
    expect((after.getTime() - before.getTime()) / 3_600_000).toBe(168)
  })

  it('a 30-minute meeting stays 30 minutes even across a transition', () => {
    // 01:30 BST + 30 minutes lands at 01:00 GMT: the wall clock appears to go
    // backwards, but the duration is unchanged, which is what matters.
    const start = zonedTimeToUtc(local('2026-10-25T01:30'), LONDON).instant
    const end = new Date(start.getTime() + 30 * 60_000)
    expect((end.getTime() - start.getTime()) / 60_000).toBe(30)
  })
})

describe('local day boundaries', () => {
  it('finds the start and end of a day', () => {
    expect(startOfLocalDay('2026-11-04', ADDIS).toISOString()).toBe('2026-11-03T21:00:00.000Z')
    expect(endOfLocalDay('2026-11-04', ADDIS).toISOString()).toBe('2026-11-04T21:00:00.000Z')
  })

  it('handles a day that is 23 hours long', () => {
    const start = startOfLocalDay('2026-03-29', LONDON)
    const end = endOfLocalDay('2026-03-29', LONDON)
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23)
  })

  it('handles a day that is 25 hours long', () => {
    const start = startOfLocalDay('2026-10-25', LONDON)
    const end = endOfLocalDay('2026-10-25', LONDON)
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25)
  })
})

describe('calendar helpers', () => {
  it('reports the local date, which can differ from the UTC date', () => {
    // 22:30 UTC is already the next day in Addis (UTC+3).
    const instant = new Date('2026-11-04T22:30:00Z')
    expect(dateInZone(instant, 'UTC')).toBe('2026-11-04')
    expect(dateInZone(instant, ADDIS)).toBe('2026-11-05')
  })

  it('reports ISO weekdays with Monday as 1', () => {
    expect(isoWeekdayInZone(new Date('2026-11-02T12:00:00Z'), ADDIS)).toBe(1) // Monday
    expect(isoWeekdayInZone(new Date('2026-11-08T12:00:00Z'), ADDIS)).toBe(7) // Sunday
  })

  it('adds days across a month boundary', () => {
    expect(addLocalDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addLocalDays('2024-02-28', 1)).toBe('2024-02-29') // leap year
  })

  it('lists the local dates a range touches', () => {
    const start = zonedTimeToUtc(local('2026-11-04T23:00'), ADDIS).instant
    const end = zonedTimeToUtc(local('2026-11-05T01:00'), ADDIS).instant
    expect(localDatesInRange(start, end, ADDIS)).toEqual(['2026-11-04', '2026-11-05'])
  })

  it('does not include the following day for a range ending at midnight', () => {
    const start = zonedTimeToUtc(local('2026-11-04T22:00'), ADDIS).instant
    const end = startOfLocalDay('2026-11-05', ADDIS)
    expect(localDatesInRange(start, end, ADDIS)).toEqual(['2026-11-04'])
  })
})
