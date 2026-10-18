/**
 * Multi-site behaviour: scoped authority, three-level settings inheritance,
 * per-location working days, timezones and holidays.
 *
 * Case IDs refer to docs/14-multi-location.md section 9.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { timeInZone, zonedTimeToUtc } from '@roombook/shared'

import { prisma } from '../src/db.js'
import { holidaysFor, supportsCountry } from '../src/domain/holidays.js'
import { resetDatabase, seedFixture, signIn, type Client, type Fixture } from './helpers.js'

let fx: Fixture
let owner: Client
let employee: Client

const at = (local: string, tz: string) =>
  zonedTimeToUtc(
    {
      year: Number(local.slice(0, 4)),
      month: Number(local.slice(5, 7)),
      day: Number(local.slice(8, 10)),
      hour: Number(local.slice(11, 13)),
      minute: Number(local.slice(14, 16)),
    },
    tz,
  ).instant.toISOString()

/** The next occurrence of a given ISO weekday, at least a week out. */
function nextWeekday(isoWeekday: number): string {
  const d = new Date()
  const target = isoWeekday === 7 ? 0 : isoWeekday
  d.setUTCDate(d.getUTCDate() + (((target - d.getUTCDay() + 7) % 7) || 7) + 7)
  return d.toISOString().slice(0, 10)
}

beforeEach(async () => {
  await resetDatabase()
  fx = await seedFixture()
  ;[owner, employee] = await Promise.all([signIn('owner@test.local'), signIn('emp@test.local')])
})

afterAll(async () => {
  await resetDatabase()
  await prisma.$disconnect()
})

// ---------------------------------------------------------------------------

describe('working days per location', () => {
  /**
   * T-165. A Dubai office works Sunday to Thursday. The same organization
   * default must produce different answers at different sites.
   */
  it('T-165: Friday is bookable in London but not in a Sun-Thu location', async () => {
    const dubai = await owner.post('/api/v1/locations', {
      name: 'Dubai',
      timezone: 'Asia/Dubai',
      country: 'AE',
      businessDays: [7, 1, 2, 3, 4], // Sunday to Thursday
      businessHoursStart: '08:00',
      businessHoursEnd: '17:00',
    })
    expect(dubai.status).toBe(201)

    const room = await owner.post('/api/v1/rooms', {
      locationId: dubai.body.data.id,
      name: 'Marina',
      capacity: 6,
    })

    const friday = nextWeekday(5)
    const onFriday = await employee.post('/api/v1/bookings', {
      roomId: room.body.data.id,
      title: 'Friday in Dubai',
      startsAt: at(`${friday}T09:00`, 'Asia/Dubai'),
      endsAt: at(`${friday}T10:00`, 'Asia/Dubai'),
    })
    expect(onFriday.status).toBe(422)
    expect(onFriday.body.error.details.rule).toBe('BR-V8')

    const sunday = nextWeekday(7)
    const onSunday = await employee.post('/api/v1/bookings', {
      roomId: room.body.data.id,
      title: 'Sunday in Dubai',
      startsAt: at(`${sunday}T09:00`, 'Asia/Dubai'),
      endsAt: at(`${sunday}T10:00`, 'Asia/Dubai'),
    })
    expect(onSunday.status).toBe(201)

    // The London room, inheriting Mon-Fri, must accept the same Friday.
    const londonFriday = await employee.post('/api/v1/bookings', {
      roomId: fx.londonRoomId,
      title: 'Friday in London',
      startsAt: at(`${friday}T10:00`, 'Europe/London'),
      endsAt: at(`${friday}T11:00`, 'Europe/London'),
    })
    expect(londonFriday.status).toBe(201)
  })

  it('a Sunday booking is refused where the location inherits Mon-Fri', async () => {
    const sunday = nextWeekday(7)
    const res = await employee.post('/api/v1/bookings', {
      roomId: fx.londonRoomId,
      title: 'Weekend work',
      startsAt: at(`${sunday}T10:00`, 'Europe/London'),
      endsAt: at(`${sunday}T11:00`, 'Europe/London'),
    })
    expect(res.status).toBe(422)
  })
})

// ---------------------------------------------------------------------------

describe('three-level settings inheritance', () => {
  /**
   * T-166. The rule that `null` inherits while an explicit `0` is a real
   * value — the commonest configuration bug in this model.
   */
  it('T-166: room beats location beats organization, and reports the source', async () => {
    await prisma.orgSettings.update({
      where: { organizationId: fx.orgId },
      data: { maxAdvanceDays: 90, minNoticeMinutes: 60 },
    })

    // The location overrides one value and inherits the other.
    await owner.patch(`/api/v1/locations/${fx.londonId}`, { maxAdvanceDays: 30 })

    const res = await owner.get(`/api/v1/locations/${fx.londonId}/settings/effective`)
    expect(res.status).toBe(200)

    expect(res.body.data.maxAdvanceDays).toMatchObject({ value: 30, source: 'location' })
    // What it would revert to if cleared, which is what the UI shows as a hint.
    expect(res.body.data.maxAdvanceDays.inheritedValue).toBe(90)

    expect(res.body.data.minNoticeMinutes).toMatchObject({ value: 60, source: 'organization' })
  })

  it('T-166: an explicit zero overrides rather than inheriting', async () => {
    await prisma.orgSettings.update({
      where: { organizationId: fx.orgId },
      data: { minNoticeMinutes: 120 },
    })

    // Zero is a decision: "no notice required here".
    await owner.patch(`/api/v1/locations/${fx.londonId}`, { minNoticeMinutes: 0 })

    const res = await owner.get(`/api/v1/locations/${fx.londonId}/settings/effective`)
    expect(res.body.data.minNoticeMinutes).toMatchObject({ value: 0, source: 'location' })
  })

  it('clearing a location override falls back to the organization', async () => {
    await owner.patch(`/api/v1/locations/${fx.londonId}`, { maxAdvanceDays: 30 })
    await owner.patch(`/api/v1/locations/${fx.londonId}`, { maxAdvanceDays: null })

    const res = await owner.get(`/api/v1/locations/${fx.londonId}/settings/effective`)
    expect(res.body.data.maxAdvanceDays.source).toBe('organization')
  })

  /** A room-level limit must beat the location, and actually be enforced. */
  it('a room limit overrides its location and is enforced on booking', async () => {
    await owner.patch(`/api/v1/locations/${fx.hqId}`, { maxBookingMinutes: 480 })
    await owner.patch(`/api/v1/rooms/${fx.hqRoomId}`, { limits: { maxBookingMinutes: 60 } })

    const day = nextWeekday(2)
    const tooLong = await employee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Two hours',
      startsAt: at(`${day}T09:00`, 'Africa/Addis_Ababa'),
      endsAt: at(`${day}T11:00`, 'Africa/Addis_Ababa'),
    })
    expect(tooLong.status).toBe(422)
    expect(tooLong.body.error.details.rule).toBe('BR-V4')

    const withinLimit = await employee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'One hour',
      startsAt: at(`${day}T09:00`, 'Africa/Addis_Ababa'),
      endsAt: at(`${day}T10:00`, 'Africa/Addis_Ababa'),
    })
    expect(withinLimit.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------

describe('timezones across locations', () => {
  /**
   * T-167. A booking is interpreted in the ROOM's zone, whoever makes it.
   * The stored instant must not depend on who was booking.
   */
  it('T-167: a booking is stored in the room zone regardless of the booker', async () => {
    const day = nextWeekday(2)

    const created = await employee.post('/api/v1/bookings', {
      roomId: fx.londonRoomId,
      title: 'Cross-zone',
      startsAt: at(`${day}T10:00`, 'Europe/London'),
      endsAt: at(`${day}T11:00`, 'Europe/London'),
    })
    expect(created.status).toBe(201)

    const row = await prisma.booking.findUniqueOrThrow({
      where: { id: created.body.data.id },
    })

    // 10:00 London, whatever that is in UTC on that date.
    expect(timeInZone(row.startsAt, 'Europe/London')).toBe('10:00')
    // The same instant is a different wall clock in Addis, and that is correct.
    expect(timeInZone(row.startsAt, 'Africa/Addis_Ababa')).not.toBe('10:00')
  })

  it('T-172: the switcher reports each location current local time', async () => {
    const res = await employee.get('/api/v1/locations')
    expect(res.status).toBe(200)

    const addis = res.body.data.find((l: { name: string }) => l.name === 'Head Office')
    const london = res.body.data.find((l: { name: string }) => l.name === 'London')

    for (const l of [addis, london]) {
      expect(l.currentLocalTime).toMatch(/^\d{2}:\d{2}$/)
    }
    // Addis is permanently UTC+3; London is UTC+0 or +1. They must differ.
    expect(addis.currentLocalTime).not.toBe(london.currentLocalTime)
  })

  /**
   * T-168. A clock change in one location must not move the hours of another.
   * Addis has never observed DST; London does.
   */
  it('T-168: a DST change affects only the location that observes it', async () => {
    // 09:00 local on either side of the UK autumn transition.
    const beforeLondon = new Date(at('2026-10-20T09:00', 'Europe/London'))
    const afterLondon = new Date(at('2026-10-27T09:00', 'Europe/London'))
    expect((afterLondon.getTime() - beforeLondon.getTime()) / 3_600_000).toBe(169)

    const beforeAddis = new Date(at('2026-10-20T09:00', 'Africa/Addis_Ababa'))
    const afterAddis = new Date(at('2026-10-27T09:00', 'Africa/Addis_Ababa'))
    expect((afterAddis.getTime() - beforeAddis.getTime()) / 3_600_000).toBe(168)
  })

  it('availability reports the selected location timezone, not the server one', async () => {
    const day = nextWeekday(2)

    const addis = await employee.get(`/api/v1/availability?date=${day}&locationId=${fx.hqId}`)
    expect(addis.body.timezone).toBe('Africa/Addis_Ababa')

    const london = await employee.get(`/api/v1/availability?date=${day}&locationId=${fx.londonId}`)
    expect(london.body.timezone).toBe('Europe/London')
  })
})

// ---------------------------------------------------------------------------

describe('holidays', () => {
  it('blocks a booking on a location holiday, but not at another site', async () => {
    const day = nextWeekday(2)

    await owner.post(`/api/v1/locations/${fx.hqId}/holidays`, {
      holidays: [{ date: day, name: 'Local public holiday' }],
    })

    const blocked = await employee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'On the holiday',
      startsAt: at(`${day}T09:00`, 'Africa/Addis_Ababa'),
      endsAt: at(`${day}T10:00`, 'Africa/Addis_Ababa'),
    })
    expect(blocked.status).toBe(422)
    expect(blocked.body.error.message).toMatch(/closed/i)

    // London is unaffected: a holiday belongs to one location.
    const elsewhere = await employee.post('/api/v1/bookings', {
      roomId: fx.londonRoomId,
      title: 'Business as usual',
      startsAt: at(`${day}T10:00`, 'Europe/London'),
      endsAt: at(`${day}T11:00`, 'Europe/London'),
    })
    expect(elsewhere.status).toBe(201)
  })

  it('a holiday removes the day from availability entirely', async () => {
    const day = nextWeekday(2)
    await owner.post(`/api/v1/locations/${fx.hqId}/holidays`, {
      holidays: [{ date: day, name: 'Shutdown' }],
    })

    const res = await employee.get(`/api/v1/availability?date=${day}&locationId=${fx.hqId}`)
    const room = res.body.rooms.find((r: { roomId: string }) => r.roomId === fx.hqRoomId)
    expect(room.bookableWindows).toHaveLength(0)
    expect(room.freeSlots).toHaveLength(0)
  })

  it('suggests holidays from the location country, excluding those already set', async () => {
    await owner.patch(`/api/v1/locations/${fx.londonId}`, { country: 'GB' })

    const first = await owner.get(`/api/v1/locations/${fx.londonId}/holidays/suggestions`)
    expect(first.status).toBe(200)
    expect(first.body.supported).toBe(true)
    expect(first.body.holidays.length).toBeGreaterThan(5)

    const christmas = first.body.holidays.find((h: { name: string }) =>
      h.name.startsWith('Christmas'),
    )
    expect(christmas).toBeDefined()

    await owner.post(`/api/v1/locations/${fx.londonId}/holidays`, {
      holidays: [christmas],
    })

    // Accepting a suggestion removes it from the next set, so applying them
    // again is additive rather than duplicating.
    const second = await owner.get(`/api/v1/locations/${fx.londonId}/holidays/suggestions`)
    expect(second.body.holidays.some((h: { date: string }) => h.date === christmas.date)).toBe(false)
  })

  it('reports an unsupported country honestly rather than guessing', async () => {
    await owner.patch(`/api/v1/locations/${fx.londonId}`, { country: 'ZZ' })
    const res = await owner.get(`/api/v1/locations/${fx.londonId}/holidays/suggestions`)
    expect(res.body.supported).toBe(false)
    expect(res.body.holidays).toHaveLength(0)
  })

  it('adding holidays twice does not duplicate them', async () => {
    const day = nextWeekday(2)
    const payload = { holidays: [{ date: day, name: 'Once' }] }

    await owner.post(`/api/v1/locations/${fx.hqId}/holidays`, payload)
    await owner.post(`/api/v1/locations/${fx.hqId}/holidays`, payload)

    const rows = await prisma.locationHoliday.findMany({ where: { locationId: fx.hqId } })
    expect(rows.filter(r => r.date === day)).toHaveLength(1)
  })

  it('only an owner can change holidays', async () => {
    const admin = await signIn('admin@test.local')
    const res = await admin.post(`/api/v1/locations/${fx.hqId}/holidays`, {
      holidays: [{ date: nextWeekday(2), name: 'Attempt' }],
    })
    expect(res.status).toBe(403)
  })

  it('a holiday can be removed again', async () => {
    const day = nextWeekday(2)
    await owner.post(`/api/v1/locations/${fx.hqId}/holidays`, {
      holidays: [{ date: day, name: 'Temporary' }],
    })

    const removed = await owner.del(`/api/v1/locations/${fx.hqId}/holidays/${day}`)
    expect(removed.status).toBe(200)

    const rows = await prisma.locationHoliday.findMany({ where: { locationId: fx.hqId } })
    expect(rows).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('holiday dataset', () => {
  it('computes Easter-derived holidays correctly', () => {
    // Easter Sunday 2026 is 5 April; Good Friday is therefore 3 April.
    const gb = holidaysFor('GB', 2026, 1)
    expect(gb.find(h => h.name === 'Good Friday')?.date).toBe('2026-04-03')
    expect(gb.find(h => h.name === 'Easter Monday')?.date).toBe('2026-04-06')
  })

  it('computes nth-weekday holidays correctly', () => {
    // US Thanksgiving is the fourth Thursday in November: 26 November 2026.
    const us = holidaysFor('US', 2026, 1)
    expect(us.find(h => h.name === 'Thanksgiving')?.date).toBe('2026-11-26')
    // Memorial Day is the last Monday in May: 25 May 2026.
    expect(us.find(h => h.name === 'Memorial Day')?.date).toBe('2026-05-25')
  })

  it('shifts a weekend holiday to the following Monday where that applies', () => {
    // Boxing Day 2026 falls on a Saturday, so the UK observes it on 28 Dec.
    const gb = holidaysFor('GB', 2026, 1)
    const boxing = gb.find(h => h.name.startsWith('Boxing Day'))
    expect(boxing?.name).toContain('observed')
    expect(boxing?.date).toBe('2026-12-28')
  })

  it('never returns two holidays on the same date', () => {
    for (const country of ['GB', 'US', 'ET', 'KE', 'DE', 'FR', 'AE']) {
      for (let year = 2026; year <= 2030; year++) {
        const holidays = holidaysFor(country, year, 1)
        const dates = holidays.map(h => h.date)
        expect(new Set(dates).size, `${country} ${year}`).toBe(dates.length)
      }
    }
  })

  it('returns nothing for a country it has no data for', () => {
    expect(supportsCountry('ZZ')).toBe(false)
    expect(holidaysFor('ZZ', 2026)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('scoped authority across sites', () => {
  /** T-170. A location with future bookings cannot be quietly deactivated. */
  it('T-170: deactivating a location reports its future bookings', async () => {
    const day = nextWeekday(2)
    await employee.post('/api/v1/bookings', {
      roomId: fx.londonRoomId,
      title: 'Still to happen',
      startsAt: at(`${day}T10:00`, 'Europe/London'),
      endsAt: at(`${day}T11:00`, 'Europe/London'),
    })

    const res = await owner.post(`/api/v1/locations/${fx.londonId}/deactivate`, {})
    expect(res.status).toBe(200)
    // The owner is told what they have just hidden, so they can resolve it.
    expect(res.body.futureBookings).toBe(1)
  })

  it('an employee may book at any active location (BR-L5)', async () => {
    const day = nextWeekday(2)
    for (const [roomId, tz] of [
      [fx.hqRoomId, 'Africa/Addis_Ababa'],
      [fx.londonRoomId, 'Europe/London'],
    ] as const) {
      const res = await employee.post('/api/v1/bookings', {
        roomId,
        title: 'Travelling',
        startsAt: at(`${day}T14:00`, tz),
        endsAt: at(`${day}T15:00`, tz),
      })
      expect(res.status, tz).toBe(201)
    }
  })

  it('a scoped admin sees every location but administers only theirs', async () => {
    const londonAdmin = await signIn('ladmin@test.local')

    const list = await londonAdmin.get('/api/v1/locations')
    expect(list.body.data).toHaveLength(2)

    const me = await londonAdmin.get('/api/v1/auth/me')
    expect(me.body.user.adminLocationIds).toEqual([fx.londonId])
    expect(me.body.user.administersAllLocations).toBe(false)
  })
})
