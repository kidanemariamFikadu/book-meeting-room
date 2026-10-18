/**
 * Recurring series through the API: preview, partial creation, scoped
 * cancellation, exception preservation and the horizon.
 *
 * Case IDs refer to docs/12-recurrence.md section 10.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { timeInZone } from '@roombook/shared'

import { prisma } from '../src/db.js'
import { processOutbox } from '../src/mail/OutboxWorker.js'
import { rollHorizon } from '../src/services/SeriesService.js'
import { mailer, resetDatabase, seedFixture, signIn, type Client, type Fixture } from './helpers.js'

let fx: Fixture
let employee: Client
let otherEmployee: Client
let admin: Client

const ADDIS = 'Africa/Addis_Ababa'

/** The next Tuesday at least a week out, so advance windows are satisfied. */
function nextTuesday(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + (((2 - d.getUTCDay() + 7) % 7) || 7) + 7)
  return d.toISOString().slice(0, 10)
}

const DAY = nextTuesday()

const weekly = (count = 4) => ({
  freq: 'WEEKLY' as const,
  interval: 1,
  byDay: ['TU' as const],
  count,
})

async function previewSeries(body: Record<string, unknown>, client: Client = employee) {
  return client.post('/api/v1/series/preview', {
    roomId: fx.hqRoomId,
    startsAtLocal: `${DAY}T09:00`,
    durationMinutes: 30,
    timezone: ADDIS,
    recurrence: weekly(),
    ...body,
  })
}

async function createSeries(body: Record<string, unknown> = {}, client: Client = employee) {
  return client.post('/api/v1/series', {
    roomId: fx.hqRoomId,
    title: 'Weekly standup',
    startsAtLocal: `${DAY}T09:00`,
    durationMinutes: 30,
    timezone: ADDIS,
    recurrence: weekly(),
    ...body,
  })
}

beforeEach(async () => {
  await resetDatabase()
  mailer.clear()
  fx = await seedFixture()
  ;[employee, otherEmployee, admin] = await Promise.all([
    signIn('emp@test.local'),
    signIn('emp2@test.local'),
    signIn('admin@test.local'),
  ])
})

afterAll(async () => {
  await resetDatabase()
  await prisma.$disconnect()
})

// ---------------------------------------------------------------------------

describe('preview', () => {
  it('describes the rule in plain English and counts the occurrences', async () => {
    const res = await previewSeries({})
    expect(res.status).toBe(200)
    expect(res.body.data.description).toMatch(/Every Tuesday at 09:00, 4 times/)
    expect(res.body.data.totalOccurrences).toBe(4)
    expect(res.body.data.available).toBe(4)
    expect(res.body.data.conflicts).toHaveLength(0)
  })

  /**
   * T-123. The reason preview exists: some dates in a long series will clash,
   * and the user must see which rather than discovering it later.
   */
  it('T-123: reports which dates clash without creating anything', async () => {
    // Occupy the second occurrence.
    const secondWeek = new Date(`${DAY}T06:00:00Z`)
    secondWeek.setUTCDate(secondWeek.getUTCDate() + 7)
    await otherEmployee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Quarterly review',
      startsAt: secondWeek.toISOString(),
      endsAt: new Date(secondWeek.getTime() + 3_600_000).toISOString(),
    })

    const res = await previewSeries({})
    expect(res.body.data.totalOccurrences).toBe(4)
    expect(res.body.data.available).toBe(3)
    expect(res.body.data.conflicts).toHaveLength(1)
    expect(res.body.data.conflicts[0].reason).toBe('BOOKING_CONFLICT')
    expect(res.body.data.conflicts[0].conflictingTitle).toBe('Quarterly review')

    // Nothing was written.
    expect(await prisma.bookingSeries.count()).toBe(0)
    expect(await prisma.booking.count({ where: { seriesId: { not: null } } })).toBe(0)
  })

  it('reports a holiday as a reason of its own', async () => {
    const thirdWeek = new Date(`${DAY}T00:00:00Z`)
    thirdWeek.setUTCDate(thirdWeek.getUTCDate() + 14)
    await prisma.locationHoliday.create({
      data: {
        locationId: fx.hqId,
        date: thirdWeek.toISOString().slice(0, 10),
        name: 'Public holiday',
      },
    })

    const res = await previewSeries({})
    const holiday = res.body.data.conflicts.find((c: { reason: string }) => c.reason === 'HOLIDAY')
    expect(holiday).toBeDefined()
    expect(res.body.data.available).toBe(3)
  })

  it('does not name a private booking it clashes with', async () => {
    const secondWeek = new Date(`${DAY}T06:00:00Z`)
    secondWeek.setUTCDate(secondWeek.getUTCDate() + 7)
    await otherEmployee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Exit interview - J. Smith',
      startsAt: secondWeek.toISOString(),
      endsAt: new Date(secondWeek.getTime() + 3_600_000).toISOString(),
      isPrivate: true,
    })

    const res = await previewSeries({})
    expect(res.body.data.conflicts[0].conflictingTitle).toBe('Busy')
    expect(JSON.stringify(res.body)).not.toContain('Exit interview')
  })

  it('rejects a weekly rule with no weekday', async () => {
    const res = await previewSeries({ recurrence: { freq: 'WEEKLY', interval: 1 } })
    expect(res.status).toBe(422)
  })
})

// ---------------------------------------------------------------------------

describe('creating', () => {
  it('materializes every occurrence as a real booking row', async () => {
    const res = await createSeries()
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(4)

    const rows = await prisma.booking.findMany({
      where: { seriesId: res.body.data.seriesId },
      orderBy: { startsAt: 'asc' },
    })
    expect(rows).toHaveLength(4)

    // Every occurrence is an ordinary CONFIRMED booking, which is what lets
    // the exclusion constraint and the calendar grid work unchanged.
    for (const row of rows) {
      expect(row.status).toBe('CONFIRMED')
      expect(row.isException).toBe(false)
      expect(timeInZone(row.startsAt, ADDIS)).toBe('09:00')
    }

    /*
     * Each ROW has its own uid, because the column is unique — sharing one
     * would make createMany treat the occurrences as duplicates and silently
     * keep only the first. The uid a calendar client sees is the series uid,
     * asserted separately on the invitation itself.
     */
    expect(new Set(rows.map(r => r.icsUid)).size).toBe(4)
    // A distinct recurrence id per occurrence, which is what anchors an
    // exception to its slot in the rule.
    expect(new Set(rows.map(r => r.occurrenceStartLocal)).size).toBe(4)
  })

  /** T-123 again, this time asserting the create path matches the preview. */
  it('T-123: skips the clashing dates and reports exactly which', async () => {
    const secondWeek = new Date(`${DAY}T06:00:00Z`)
    secondWeek.setUTCDate(secondWeek.getUTCDate() + 7)
    await otherEmployee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Blocker',
      startsAt: secondWeek.toISOString(),
      endsAt: new Date(secondWeek.getTime() + 3_600_000).toISOString(),
    })

    const res = await createSeries({ conflictStrategy: 'SKIP' })
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(3)
    expect(res.body.data.skipped).toHaveLength(1)

    const rows = await prisma.booking.findMany({ where: { seriesId: res.body.data.seriesId } })
    expect(rows).toHaveLength(3)
  })

  /** Some people would rather fix the clash than accept a gappy series. */
  it('creates nothing under the FAIL strategy when any date clashes', async () => {
    const secondWeek = new Date(`${DAY}T06:00:00Z`)
    secondWeek.setUTCDate(secondWeek.getUTCDate() + 7)
    await otherEmployee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Blocker',
      startsAt: secondWeek.toISOString(),
      endsAt: new Date(secondWeek.getTime() + 3_600_000).toISOString(),
    })

    const res = await createSeries({ conflictStrategy: 'FAIL' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('SERIES_CONFLICT')
    expect(await prisma.bookingSeries.count()).toBe(0)
  })

  it('refuses a series in a room that needs approval, rather than half-working', async () => {
    await prisma.room.update({ where: { id: fx.hqRoomId }, data: { requiresApproval: true } })
    const res = await createSeries()
    expect(res.status).toBe(422)
    expect(res.body.error.details.rule).toBe('BR-A12')
  })

  /** T-132. A hard ceiling, so a runaway rule cannot be written. */
  it('T-132: refuses a series beyond the occurrence ceiling', async () => {
    await prisma.orgSettings.update({
      where: { organizationId: fx.orgId },
      data: { maxOccurrencesPerSeries: 10 },
    })

    const res = await createSeries({
      recurrence: { freq: 'DAILY', interval: 1 },
    })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('RECURRENCE_LIMIT')
  })

  it('an occurrence conflicts with an ordinary booking afterwards', async () => {
    const created = await createSeries()
    expect(created.status).toBe(201)

    // The first occurrence occupies its slot like any other booking.
    const clash = await otherEmployee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Trying to double book',
      startsAt: new Date(`${DAY}T06:00:00Z`).toISOString(),
      endsAt: new Date(`${DAY}T06:30:00Z`).toISOString(),
    })
    expect(clash.status).toBe(409)
  })

  it('occurrences appear on the calendar grid like any other booking', async () => {
    await createSeries()
    const res = await employee.get(`/api/v1/availability?date=${DAY}&locationId=${fx.hqId}`)
    const room = res.body.rooms.find((r: { roomId: string }) => r.roomId === fx.hqRoomId)
    expect(room.busy).toHaveLength(1)
    expect(room.busy[0].title).toBe('Weekly standup')
  })
})

// ---------------------------------------------------------------------------

describe('notifications', () => {
  /**
   * T-129. The rule that makes recurrence usable: one email per ACTION, not
   * one per occurrence. Nobody would tolerate 52 messages.
   */
  it('T-129: sends one email for the whole series, not one per occurrence', async () => {
    const res = await createSeries({ recurrence: weekly(12) })
    expect(res.body.data.created).toBe(12)

    const rows = await prisma.emailOutbox.findMany({
      where: { seriesId: res.body.data.seriesId },
    })
    expect(rows).toHaveLength(1)

    await processOutbox()
    const sent = mailer.sent.find(m => m.subject.startsWith('Confirmed:'))!
    // The pattern, not a list of fifty-two dates.
    expect(sent.text).toMatch(/Every Tuesday/)
    expect(sent.text).toMatch(/Meetings: 12/)
    // And genuinely one message, not twelve.
    expect(mailer.sent.filter(m => m.subject.startsWith('Confirmed:'))).toHaveLength(1)
  })

  /** A series that silently missed dates is a meeting people miss. */
  it('names the skipped dates in the confirmation', async () => {
    const secondWeek = new Date(`${DAY}T06:00:00Z`)
    secondWeek.setUTCDate(secondWeek.getUTCDate() + 7)
    await otherEmployee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Quarterly review',
      startsAt: secondWeek.toISOString(),
      endsAt: new Date(secondWeek.getTime() + 3_600_000).toISOString(),
    })

    await createSeries()
    await processOutbox()

    // The blocker booking produced its own confirmation, so the series email
    // has to be picked out rather than assumed to be first.
    const sent = mailer.sent.find(m => m.text.includes('recurring booking is confirmed'))!
    expect(sent).toBeDefined()
    expect(sent.text).toMatch(/could not be booked|skipped/i)
    expect(sent.text).toContain(secondWeek.toISOString().slice(0, 10))
  })

  it('attaches a calendar invitation carrying the RRULE', async () => {
    await createSeries()
    await processOutbox()

    const ics = mailer.sent[0]!.attachments?.[0]?.content ?? ''
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
    expect(ics).toContain('METHOD:REQUEST')
  })
})

// ---------------------------------------------------------------------------

describe('moving one occurrence', () => {
  /**
   * T-125 / BR-M3. The feature the whole milestone exists for: an admin moves
   * next Tuesday without disturbing the rest of the standup.
   */
  it('T-125: moving one occurrence leaves the others untouched', async () => {
    const created = await createSeries()
    const occurrences = await prisma.booking.findMany({
      where: { seriesId: created.body.data.seriesId },
      orderBy: { startsAt: 'asc' },
    })
    const target = occurrences[1]!

    const otherRoom = await prisma.room.create({
      data: { organizationId: fx.orgId, locationId: fx.hqId, name: 'Room C', capacity: 6 },
    })

    const moved = await admin.post(`/api/v1/bookings/${target.id}/move`, {
      roomId: otherRoom.id,
      reason: 'Boardroom needed for the quarterly review',
    })
    expect(moved.status).toBe(200)

    const after = await prisma.booking.findMany({
      where: { seriesId: created.body.data.seriesId },
      orderBy: { startsAt: 'asc' },
    })

    // Only the one moved.
    expect(after.filter(o => o.roomId === otherRoom.id)).toHaveLength(1)
    expect(after.filter(o => o.roomId === fx.hqRoomId)).toHaveLength(3)

    const exception = after.find(o => o.id === target.id)!
    expect(exception.isException).toBe(true)
    expect(exception.exceptionFields).toContain('roomId')
    // The RECURRENCE-ID must NOT change: it anchors the row to its slot.
    expect(exception.occurrenceStartLocal).toBe(target.occurrenceStartLocal)
  })

  it('records a time change as an exception too', async () => {
    const created = await createSeries()
    const target = (
      await prisma.booking.findMany({
        where: { seriesId: created.body.data.seriesId },
        orderBy: { startsAt: 'asc' },
      })
    )[1]!

    await admin.post(`/api/v1/bookings/${target.id}/move`, {
      startsAt: new Date(target.startsAt.getTime() + 2 * 3_600_000).toISOString(),
      endsAt: new Date(target.endsAt.getTime() + 2 * 3_600_000).toISOString(),
      reason: 'Shifting this one later',
    })

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: target.id } })
    expect(after.isException).toBe(true)
    expect(after.exceptionFields).toContain('startsAt')
    expect(after.occurrenceStartLocal).toBe(target.occurrenceStartLocal)
  })
})

// ---------------------------------------------------------------------------

describe('cancelling with a scope', () => {
  async function seriesWithOccurrences() {
    const created = await createSeries()
    const occurrences = await prisma.booking.findMany({
      where: { seriesId: created.body.data.seriesId },
      orderBy: { startsAt: 'asc' },
    })
    return { seriesId: created.body.data.seriesId as string, occurrences }
  }

  /** T-127. One date only, which is the common case. */
  it('T-127: cancels a single occurrence and frees only that slot', async () => {
    const { occurrences } = await seriesWithOccurrences()
    const target = occurrences[1]!

    const res = await employee.post(`/api/v1/series/occurrences/${target.id}/cancel`, {
      scope: 'THIS_OCCURRENCE',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.affected).toBe(1)

    const after = await prisma.booking.findMany({ where: { seriesId: occurrences[0]!.seriesId! } })
    expect(after.filter(o => o.status === 'CANCELLED')).toHaveLength(1)
    expect(after.filter(o => o.status === 'CONFIRMED')).toHaveLength(3)

    // That slot is now bookable by someone else.
    const reuse = await otherEmployee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Takes the freed slot',
      startsAt: target.startsAt.toISOString(),
      endsAt: target.endsAt.toISOString(),
    })
    expect(reuse.status).toBe(201)
  })

  /** T-126. The split: this one and everything after it. */
  it('T-126: cancels this and all following, leaving earlier ones alone', async () => {
    const { seriesId, occurrences } = await seriesWithOccurrences()

    const res = await employee.post(`/api/v1/series/occurrences/${occurrences[2]!.id}/cancel`, {
      scope: 'THIS_AND_FOLLOWING',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.affected).toBe(2)

    const after = await prisma.booking.findMany({
      where: { seriesId },
      orderBy: { startsAt: 'asc' },
    })
    expect(after.map(o => o.status)).toEqual([
      'CONFIRMED',
      'CONFIRMED',
      'CANCELLED',
      'CANCELLED',
    ])

    // The rule itself is ended, so the horizon roll cannot recreate them.
    const series = await prisma.bookingSeries.findUniqueOrThrow({ where: { id: seriesId } })
    expect(series.status).toBe('ENDED')
    expect(series.rrule).toContain('UNTIL=')
  })

  /** T-128. The whole series, but never the past. */
  it('T-128: cancels the entire series without touching past occurrences', async () => {
    const { seriesId, occurrences } = await seriesWithOccurrences()

    // Make the first occurrence historic.
    await prisma.booking.update({
      where: { id: occurrences[0]!.id },
      data: {
        startsAt: new Date(Date.now() - 7 * 86_400_000),
        endsAt: new Date(Date.now() - 7 * 86_400_000 + 1_800_000),
      },
    })

    const res = await employee.post(`/api/v1/series/occurrences/${occurrences[3]!.id}/cancel`, {
      scope: 'ENTIRE_SERIES',
    })
    expect(res.status).toBe(200)

    const after = await prisma.booking.findMany({
      where: { seriesId },
      orderBy: { startsAt: 'asc' },
    })
    // The historic one survives: it records what actually happened (BR-M1).
    expect(after[0]!.status).toBe('CONFIRMED')
    expect(after.slice(1).every(o => o.status === 'CANCELLED')).toBe(true)

    const series = await prisma.bookingSeries.findUniqueOrThrow({ where: { id: seriesId } })
    expect(series.status).toBe('CANCELLED')
  })

  it('requires a scope rather than guessing', async () => {
    const { occurrences } = await seriesWithOccurrences()
    const res = await employee.post(`/api/v1/series/occurrences/${occurrences[0]!.id}/cancel`, {})
    expect(res.status).toBe(422)
  })

  it('requires a reason when an admin cancels someone else series', async () => {
    const { occurrences } = await seriesWithOccurrences()

    const noReason = await admin.post(
      `/api/v1/series/occurrences/${occurrences[1]!.id}/cancel`,
      { scope: 'THIS_OCCURRENCE' },
    )
    expect(noReason.status).toBe(422)

    const withReason = await admin.post(
      `/api/v1/series/occurrences/${occurrences[1]!.id}/cancel`,
      { scope: 'THIS_OCCURRENCE', reason: 'Room needed for the board' },
    )
    expect(withReason.status).toBe(200)
  })

  it('another employee cannot cancel someone else series', async () => {
    const { occurrences } = await seriesWithOccurrences()
    const res = await otherEmployee.post(
      `/api/v1/series/occurrences/${occurrences[1]!.id}/cancel`,
      { scope: 'ENTIRE_SERIES' },
    )
    expect(res.status).toBe(403)
  })

  /** One email per action, including for a scoped cancellation. */
  it('sends one email naming the scope, not one per occurrence', async () => {
    const { occurrences } = await seriesWithOccurrences()
    mailer.clear()

    await employee.post(`/api/v1/series/occurrences/${occurrences[0]!.id}/cancel`, {
      scope: 'ENTIRE_SERIES',
    })
    await processOutbox()

    const cancellations = mailer.sent.filter(m => m.subject.startsWith('Cancelled:'))
    expect(cancellations).toHaveLength(1)
    expect(cancellations[0]!.subject).toMatch(/all remaining/i)
  })

  it('a single-occurrence cancellation says it affects only that date', async () => {
    const { occurrences } = await seriesWithOccurrences()
    mailer.clear()

    await employee.post(`/api/v1/series/occurrences/${occurrences[1]!.id}/cancel`, {
      scope: 'THIS_OCCURRENCE',
    })
    await processOutbox()

    const sent = mailer.sent.find(m => m.subject.startsWith('Cancelled:'))!
    expect(sent.subject).toMatch(/one date only/i)
  })
})

// ---------------------------------------------------------------------------

describe('series detail', () => {
  it('reports the pattern, the occurrences and a summary', async () => {
    const created = await createSeries()
    const res = await employee.get(`/api/v1/series/${created.body.data.seriesId}`)

    expect(res.status).toBe(200)
    expect(res.body.data.pattern).toMatch(/Every Tuesday/)
    expect(res.body.data.occurrences).toHaveLength(4)
    expect(res.body.data.counts.total).toBe(4)
    expect(res.body.data.counts.exceptions).toBe(0)
  })

  it('counts exceptions after one occurrence is moved', async () => {
    const created = await createSeries()
    const target = (
      await prisma.booking.findMany({
        where: { seriesId: created.body.data.seriesId },
        orderBy: { startsAt: 'asc' },
      })
    )[1]!

    await admin.post(`/api/v1/bookings/${target.id}/move`, {
      startsAt: new Date(target.startsAt.getTime() + 2 * 3_600_000).toISOString(),
      endsAt: new Date(target.endsAt.getTime() + 2 * 3_600_000).toISOString(),
      reason: 'Just this once',
    })

    const res = await employee.get(`/api/v1/series/${created.body.data.seriesId}`)
    expect(res.body.data.counts.exceptions).toBe(1)
  })

  it('returns 404 for a series in another organization', async () => {
    const other = await prisma.organization.create({
      data: { name: 'Other', slug: `o-${Date.now()}`, defaultTimezone: 'UTC' },
    })
    const loc = await prisma.location.create({
      data: { organizationId: other.id, name: 'X', timezone: 'UTC', businessDays: [] },
    })
    const room = await prisma.room.create({
      data: { organizationId: other.id, locationId: loc.id, name: 'R', capacity: 2 },
    })
    const user = await prisma.user.create({
      data: {
        organizationId: other.id,
        email: `u-${Date.now()}@other.test`,
        fullName: 'U',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
      },
    })
    const series = await prisma.bookingSeries.create({
      data: {
        organizationId: other.id,
        roomId: room.id,
        organizerId: user.id,
        title: 'Theirs',
        rrule: 'FREQ=WEEKLY;BYDAY=TU',
        dtstartLocal: `${DAY}T09:00`,
        durationMinutes: 30,
        timezone: 'UTC',
        horizonUntil: new Date(),
      },
    })

    expect((await employee.get(`/api/v1/series/${series.id}`)).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------

describe('horizon', () => {
  /** T-131. An open-ended series must keep producing occurrences. */
  it('T-131: extends an open-ended series without duplicating', async () => {
    /*
     * The real scenario is that time passes and the horizon moves forward.
     * Simulated by materializing against a short horizon, then widening it —
     * which is equivalent, and far quicker than waiting a year.
     */
    await prisma.orgSettings.update({
      where: { organizationId: fx.orgId },
      data: { recurrenceHorizonDays: 60 },
    })

    const created = await createSeries({
      // No count and no end date: open-ended.
      recurrence: { freq: 'WEEKLY', interval: 1, byDay: ['TU'] },
    })
    expect(created.status).toBe(201)

    const before = await prisma.booking.count({ where: { seriesId: created.body.data.seriesId } })
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThan(15)

    await prisma.orgSettings.update({
      where: { organizationId: fx.orgId },
      data: { recurrenceHorizonDays: 365 },
    })

    const result = await rollHorizon()
    expect(result.seriesExtended).toBeGreaterThan(0)
    expect(result.occurrencesAdded).toBeGreaterThan(0)

    const after = await prisma.booking.count({ where: { seriesId: created.body.data.seriesId } })
    expect(after).toBeGreaterThan(before)

    // Running it again adds nothing: the pass is idempotent, which matters
    // because it runs hourly.
    const second = await rollHorizon()
    expect(second.occurrencesAdded).toBe(0)
  })

  /** A cancelled occurrence must never be resurrected by the roll. */
  it('does not recreate a cancelled occurrence', async () => {
    await prisma.orgSettings.update({
      where: { organizationId: fx.orgId },
      data: { recurrenceHorizonDays: 60 },
    })

    const created = await createSeries({
      recurrence: { freq: 'WEEKLY', interval: 1, byDay: ['TU'] },
    })
    const occurrences = await prisma.booking.findMany({
      where: { seriesId: created.body.data.seriesId },
      orderBy: { startsAt: 'asc' },
    })

    await employee.post(`/api/v1/series/occurrences/${occurrences[1]!.id}/cancel`, {
      scope: 'THIS_OCCURRENCE',
    })

    await prisma.orgSettings.update({
      where: { organizationId: fx.orgId },
      data: { recurrenceHorizonDays: 365 },
    })
    await rollHorizon()

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: occurrences[1]!.id } })
    expect(after.status).toBe('CANCELLED')
    // And no replacement row was created for that slot.
    const sameSlot = await prisma.booking.findMany({
      where: {
        seriesId: created.body.data.seriesId,
        occurrenceStartLocal: occurrences[1]!.occurrenceStartLocal,
      },
    })
    expect(sameSlot).toHaveLength(1)
  })

  it('leaves a finished series alone', async () => {
    await createSeries({ recurrence: weekly(2) })
    const result = await rollHorizon()
    expect(result.occurrencesAdded).toBe(0)
  })
})
