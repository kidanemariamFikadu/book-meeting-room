/**
 * The booking engine: overlap, rules, concurrency and permissions.
 *
 * Case IDs refer to docs/10-testing.md.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { zonedTimeToUtc } from '@roombook/shared'

import { prisma } from '../src/db.js'
import { resetDatabase, seedFixture, signIn, type Client, type Fixture } from './helpers.js'

let fx: Fixture
let employee: Client
let admin: Client
let owner: Client
let londonAdmin: Client

const ADDIS = 'Africa/Addis_Ababa'

/** A UTC instant from a wall-clock time in the Head Office timezone. */
function at(local: string, tz = ADDIS): string {
  return zonedTimeToUtc(
    {
      year: Number(local.slice(0, 4)),
      month: Number(local.slice(5, 7)),
      day: Number(local.slice(8, 10)),
      hour: Number(local.slice(11, 13)),
      minute: Number(local.slice(14, 16)),
    },
    tz,
  ).instant.toISOString()
}

/** A weekday comfortably in the future, so advance-window rules are satisfied. */
function nextTuesday(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + ((2 - d.getUTCDay() + 7) % 7 || 7) + 7)
  return d.toISOString().slice(0, 10)
}

const DAY = nextTuesday()

const book = (client: Client, body: Record<string, unknown>) =>
  client.post('/api/v1/bookings', body)

beforeEach(async () => {
  await resetDatabase()
  fx = await seedFixture()
  ;[employee, admin, owner, londonAdmin] = await Promise.all([
    signIn('emp@test.local'),
    signIn('admin@test.local'),
    signIn('owner@test.local'),
    signIn('ladmin@test.local'),
  ])
})

afterAll(async () => {
  await resetDatabase()
  await prisma.$disconnect()
})

// ---------------------------------------------------------------------------

describe('overlap detection', () => {
  /** T-01. The rule that makes back-to-back meetings possible (BR-T2). */
  it('T-01: allows back-to-back bookings', async () => {
    const first = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'First',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    expect(first.status).toBe(201)

    const second = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Second',
      startsAt: at(`${DAY}T10:00`),
      endsAt: at(`${DAY}T11:00`),
    })
    expect(second.status).toBe(201)
  })

  it('T-02: rejects an exact duplicate', async () => {
    const body = {
      roomId: fx.hqRoomId,
      title: 'Taken',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    }
    expect((await book(employee, body)).status).toBe(201)

    const dup = await book(employee, { ...body, title: 'Duplicate' })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('BOOKING_CONFLICT')
    expect(dup.body.error.details.conflicts).toHaveLength(1)
    expect(dup.body.error.details.conflicts[0].title).toBe('Taken')
  })

  it('T-03/T-04/T-05: rejects containing, contained and partial overlaps', async () => {
    await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Anchor',
      startsAt: at(`${DAY}T10:00`),
      endsAt: at(`${DAY}T11:00`),
    })

    const cases: Array<[string, string, string]> = [
      ['contains it', `${DAY}T09:00`, `${DAY}T12:00`],
      ['inside it', `${DAY}T10:15`, `${DAY}T10:45`],
      ['overlaps the start', `${DAY}T09:30`, `${DAY}T10:30`],
      ['overlaps the end', `${DAY}T10:30`, `${DAY}T11:30`],
    ]

    for (const [label, start, end] of cases) {
      const res = await book(employee, {
        roomId: fx.hqRoomId,
        title: label,
        startsAt: at(start),
        endsAt: at(end),
      })
      expect(res.status, label).toBe(409)
    }
  })

  it('T-06: allows the same time in a different room', async () => {
    const slot = { startsAt: at(`${DAY}T09:00`), endsAt: at(`${DAY}T10:00`) }
    expect((await book(employee, { roomId: fx.hqRoomId, title: 'A', ...slot })).status).toBe(201)

    const otherRoom = await prisma.room.create({
      data: {
        organizationId: fx.orgId,
        locationId: fx.hqId,
        name: 'Second Room',
        capacity: 4,
      },
    })
    expect((await book(employee, { roomId: otherRoom.id, title: 'B', ...slot })).status).toBe(201)
  })

  /** T-07. Cancelling frees the slot the instant it commits (BR-M8). */
  it('T-07: a cancelled booking frees its slot', async () => {
    const slot = { startsAt: at(`${DAY}T09:00`), endsAt: at(`${DAY}T10:00`) }
    const created = await book(employee, { roomId: fx.hqRoomId, title: 'Will cancel', ...slot })

    const cancelled = await employee.post(`/api/v1/bookings/${created.body.data.id}/cancel`, {})
    expect(cancelled.status).toBe(200)

    const reused = await book(employee, { roomId: fx.hqRoomId, title: 'Reuses slot', ...slot })
    expect(reused.status).toBe(201)
  })

  it('T-08: rejects a booking overlapping a closure', async () => {
    await prisma.roomClosure.create({
      data: {
        roomId: fx.hqRoomId,
        startsAt: new Date(at(`${DAY}T09:00`)),
        endsAt: new Date(at(`${DAY}T12:00`)),
        reason: 'Projector repair',
      },
    })

    const res = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'During closure',
      startsAt: at(`${DAY}T10:00`),
      endsAt: at(`${DAY}T11:00`),
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CLOSURE_CONFLICT')
    expect(res.body.error.message).toMatch(/projector repair/i)
  })

  /** T-09/BR-C5. A booking must not conflict with itself when edited. */
  it('T-09: a move that keeps part of the same slot is allowed', async () => {
    const created = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Shifting',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })

    const moved = await admin.post(`/api/v1/bookings/${created.body.data.id}/move`, {
      startsAt: at(`${DAY}T09:30`),
      endsAt: at(`${DAY}T10:30`),
      reason: 'Shifting by half an hour',
    })
    expect(moved.status).toBe(200)
  })

  it('T-10/T-11: rejects zero-length and inverted ranges', async () => {
    const zero = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Zero',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T09:00`),
    })
    expect(zero.status).toBe(422)

    const inverted = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Backwards',
      startsAt: at(`${DAY}T10:00`),
      endsAt: at(`${DAY}T09:00`),
    })
    expect(inverted.status).toBe(422)
  })
})

// ---------------------------------------------------------------------------

describe('concurrency', () => {
  /**
   * T-20. The defining correctness test.
   *
   * Many simultaneous attempts on one slot must yield exactly one booking.
   * The pre-check cannot guarantee this — the exclusion constraint does.
   */
  it('T-20: parallel attempts on one slot produce exactly one booking', async () => {
    const slot = { startsAt: at(`${DAY}T14:00`), endsAt: at(`${DAY}T15:00`) }

    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        book(employee, { roomId: fx.hqRoomId, title: `Attempt ${i}`, ...slot }),
      ),
    )

    const created = attempts.filter(r => r.status === 201)
    const conflicted = attempts.filter(r => r.status === 409)

    expect(created).toHaveLength(1)
    expect(conflicted).toHaveLength(11)
    // Nothing may fail in a way the user cannot act on.
    expect(attempts.filter(r => r.status >= 500)).toHaveLength(0)

    const rows = await prisma.booking.findMany({
      where: { roomId: fx.hqRoomId, status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] } },
    })
    expect(rows).toHaveLength(1)
  })

  /** T-22. A rolled-back booking must leave nothing behind (BR-N1). */
  it('T-22: a conflicting attempt writes no audit row and no email', async () => {
    const slot = { startsAt: at(`${DAY}T14:00`), endsAt: at(`${DAY}T15:00`) }
    await book(employee, { roomId: fx.hqRoomId, title: 'Winner', ...slot })

    const before = {
      audit: await prisma.auditEvent.count({ where: { eventType: 'BOOKING_CREATED' } }),
      email: await prisma.emailOutbox.count(),
    }

    const loser = await book(employee, { roomId: fx.hqRoomId, title: 'Loser', ...slot })
    expect(loser.status).toBe(409)

    expect(await prisma.auditEvent.count({ where: { eventType: 'BOOKING_CREATED' } })).toBe(
      before.audit,
    )
    expect(await prisma.emailOutbox.count()).toBe(before.email)
  })

  it('T-23: cancelling twice is refused the second time', async () => {
    const created = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Cancel twice',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    const id = created.body.data.id

    expect((await employee.post(`/api/v1/bookings/${id}/cancel`, {})).status).toBe(200)
    const again = await employee.post(`/api/v1/bookings/${id}/cancel`, {})
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('STATE_CONFLICT')
  })
})

// ---------------------------------------------------------------------------

describe('booking rules', () => {
  it('T-40: rejects a booking in the past', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const res = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Yesterday',
      startsAt: at(`${yesterday}T09:00`),
      endsAt: at(`${yesterday}T10:00`),
    })
    expect(res.status).toBe(422)
    expect(res.body.error.details.rule).toBe('BR-V5')
  })

  it('T-42: enforces the maximum duration', async () => {
    const res = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Marathon',
      startsAt: at(`${DAY}T08:00`),
      endsAt: at(`${DAY}T18:00`), // 10 hours, over the 8-hour default
    })
    expect(res.status).toBe(422)
    expect(res.body.error.details.rule).toBe('BR-V4')
  })

  it('T-43: enforces the advance window', async () => {
    const farOff = new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10)
    const res = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Next year',
      startsAt: at(`${farOff}T09:00`),
      endsAt: at(`${farOff}T10:00`),
    })
    expect(res.status).toBe(422)
    expect(res.body.error.details.rule).toBe('BR-V6')
  })

  /** T-44. The message must name the actual hours, not just refuse. */
  it('T-44: rejects a time outside bookable hours, naming them', async () => {
    const res = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Midnight meeting',
      startsAt: at(`${DAY}T23:00`),
      endsAt: at(`${DAY}T23:30`),
    })
    expect(res.status).toBe(422)
    expect(res.body.error.details.rule).toBe('BR-V8')
    expect(res.body.error.message).toMatch(/08:00|bookable/i)
  })

  it('BR-T7: rejects a time off the slot boundary', async () => {
    const res = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Odd time',
      startsAt: at(`${DAY}T09:07`),
      endsAt: at(`${DAY}T10:07`),
    })
    expect(res.status).toBe(422)
    expect(res.body.error.details.rule).toBe('BR-T7')
  })

  it('T-46: rejects a booking in an inactive room', async () => {
    await prisma.room.update({ where: { id: fx.hqRoomId }, data: { isActive: false } })
    const res = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Closed room',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ROOM_INACTIVE')
  })

  it('T-47: returns 404 for a room in another organization', async () => {
    const other = await prisma.organization.create({
      data: { name: 'Other', slug: `o-${Date.now()}`, defaultTimezone: 'UTC' },
    })
    const loc = await prisma.location.create({
      data: { organizationId: other.id, name: 'X', timezone: 'UTC', businessDays: [] },
    })
    const room = await prisma.room.create({
      data: { organizationId: other.id, locationId: loc.id, name: 'Secret', capacity: 2 },
    })

    const res = await book(employee, {
      roomId: room.id,
      title: 'Cross-org',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    expect(res.status).toBe(404)
  })

  it('respects a per-location holiday', async () => {
    await prisma.locationHoliday.create({
      data: { locationId: fx.hqId, date: DAY, name: 'Public holiday' },
    })
    const res = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'On a holiday',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    expect(res.status).toBe(422)
    expect(res.body.error.message).toMatch(/closed/i)
  })
})

// ---------------------------------------------------------------------------

describe('admin move and cancel', () => {
  async function aBooking(title = 'Design review') {
    const res = await book(employee, {
      roomId: fx.hqRoomId,
      title,
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    expect(res.status).toBe(201)
    return res.body.data.id as string
  }

  it('T-51: an employee cannot move anyone booking, including their own', async () => {
    const id = await aBooking()
    const res = await employee.post(`/api/v1/bookings/${id}/move`, {
      startsAt: at(`${DAY}T11:00`),
      endsAt: at(`${DAY}T12:00`),
      reason: 'I would like to',
    })
    expect(res.status).toBe(403)
  })

  it('T-52/T-53: an admin move requires a reason of at least 3 characters', async () => {
    const id = await aBooking()
    const noReason = await admin.post(`/api/v1/bookings/${id}/move`, {
      startsAt: at(`${DAY}T11:00`),
      endsAt: at(`${DAY}T12:00`),
    })
    expect(noReason.status).toBe(422)

    const tooShort = await admin.post(`/api/v1/bookings/${id}/move`, {
      startsAt: at(`${DAY}T11:00`),
      endsAt: at(`${DAY}T12:00`),
      reason: 'x',
    })
    expect(tooShort.status).toBe(422)
  })

  /**
   * BR-M3. The booking keeps its identity so the organizer calendar entry
   * updates rather than the meeting appearing twice.
   */
  it('BR-M3: a move preserves the id and ics uid, and increments the sequence', async () => {
    const id = await aBooking()
    const before = await prisma.booking.findUniqueOrThrow({ where: { id } })

    const otherRoom = await prisma.room.create({
      data: { organizationId: fx.orgId, locationId: fx.hqId, name: 'Room C', capacity: 6 },
    })

    const moved = await admin.post(`/api/v1/bookings/${id}/move`, {
      roomId: otherRoom.id,
      reason: 'Boardroom required for the quarterly review',
    })
    expect(moved.status).toBe(200)

    const after = await prisma.booking.findUniqueOrThrow({ where: { id } })
    expect(after.id).toBe(before.id)
    expect(after.icsUid).toBe(before.icsUid)
    expect(after.icsSequence).toBe(before.icsSequence + 1)
    expect(after.roomId).toBe(otherRoom.id)
  })

  it('T-71: a move emails the organizer with the reason quoted', async () => {
    const id = await aBooking()
    await admin.post(`/api/v1/bookings/${id}/move`, {
      startsAt: at(`${DAY}T11:00`),
      endsAt: at(`${DAY}T12:00`),
      reason: 'Boardroom required for the quarterly review',
    })

    const mail = await prisma.emailOutbox.findFirst({
      where: { bookingId: id, template: 'booking_moved' },
    })
    expect(mail).not.toBeNull()
    expect(mail?.toEmail).toBe('emp@test.local')
    expect(JSON.stringify(mail?.payload)).toContain('quarterly review')
  })

  it('T-05 on move: refuses to move into an occupied slot', async () => {
    const id = await aBooking()
    await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Blocker',
      startsAt: at(`${DAY}T11:00`),
      endsAt: at(`${DAY}T12:00`),
    })

    const res = await admin.post(`/api/v1/bookings/${id}/move`, {
      startsAt: at(`${DAY}T11:00`),
      endsAt: at(`${DAY}T12:00`),
      reason: 'Trying to double book',
    })
    expect(res.status).toBe(409)
    expect(res.body.error.details.conflicts[0].title).toBe('Blocker')
  })

  /** BR-L2. A scoped admin may not move a booking into a location they do not administer. */
  it('BR-L2: a London-only admin cannot move an Addis booking', async () => {
    const id = await aBooking()
    const res = await londonAdmin.post(`/api/v1/bookings/${id}/move`, {
      startsAt: at(`${DAY}T11:00`),
      endsAt: at(`${DAY}T12:00`),
      reason: 'Out of scope attempt',
    })
    expect(res.status).toBe(403)
  })

  it('an admin cancellation requires a reason and records it', async () => {
    const id = await aBooking()

    const noReason = await admin.post(`/api/v1/bookings/${id}/cancel`, {})
    expect(noReason.status).toBe(422)

    const ok = await admin.post(`/api/v1/bookings/${id}/cancel`, {
      reason: 'Emergency maintenance on the projector',
    })
    expect(ok.status).toBe(200)

    const row = await prisma.booking.findUniqueOrThrow({ where: { id } })
    expect(row.cancellationReason).toMatch(/projector/)

    const audit = await prisma.auditEvent.findFirst({
      where: { entityId: id, eventType: 'BOOKING_CANCELLED' },
    })
    expect(audit?.reason).toMatch(/projector/)
  })

  it('the organizer may cancel their own booking with no reason', async () => {
    const id = await aBooking()
    expect((await employee.post(`/api/v1/bookings/${id}/cancel`, {})).status).toBe(200)
  })

  it('T-50: one employee cannot cancel another employee booking', async () => {
    const id = await aBooking()
    const other = await signIn('emp2@test.local')
    expect((await other.post(`/api/v1/bookings/${id}/cancel`, {})).status).toBe(403)
  })

  /** T-54/BR-M1. Past bookings are immutable for everyone, owner included. */
  it('T-54: nobody can cancel a booking that has already ended', async () => {
    const past = await prisma.booking.create({
      data: {
        organizationId: fx.orgId,
        roomId: fx.hqRoomId,
        organizerId: fx.employee.id,
        createdById: fx.employee.id,
        title: 'Finished',
        startsAt: new Date(Date.now() - 7_200_000),
        endsAt: new Date(Date.now() - 3_600_000),
        status: 'CONFIRMED',
        icsUid: `past-${Date.now()}@roombook`,
      },
    })

    for (const [who, client] of [
      ['employee', employee],
      ['admin', admin],
      ['owner', owner],
    ] as const) {
      const res = await client.post(`/api/v1/bookings/${past.id}/cancel`, { reason: 'Tidying up' })
      expect([403, 409], who).toContain(res.status)
    }
  })

  /**
   * D3 / BR-M2a. Ending early TRUNCATES rather than erasing, so the twenty
   * minutes the room was genuinely used still count.
   */
  it('BR-M2a: ending an in-progress booking truncates it and frees the rest', async () => {
    const inProgress = await prisma.booking.create({
      data: {
        organizationId: fx.orgId,
        roomId: fx.hqRoomId,
        organizerId: fx.employee.id,
        createdById: fx.employee.id,
        title: 'Running now',
        startsAt: new Date(Date.now() - 20 * 60_000),
        endsAt: new Date(Date.now() + 40 * 60_000),
        status: 'CONFIRMED',
        icsUid: `now-${Date.now()}@roombook`,
      },
    })

    const res = await employee.post(`/api/v1/bookings/${inProgress.id}/end-early`, {})
    expect(res.status).toBe(200)

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: inProgress.id } })
    expect(row.status).toBe('ENDED_EARLY')
    expect(row.endsAt.getTime()).toBeLessThan(inProgress.endsAt.getTime())
    expect(row.endedEarlyById).toBe(fx.employee.id)
    // Still occupies the time it actually used, so utilization stays honest.
    expect(row.endsAt.getTime()).toBeGreaterThan(row.startsAt.getTime())
  })
})

// ---------------------------------------------------------------------------

describe('privacy', () => {
  /** T-58/BR-P3. Redaction happens server-side; the title never reaches the client. */
  it('T-58: a private booking shows only Busy to an uninvolved employee', async () => {
    const created = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Exit interview - J. Smith',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
      isPrivate: true,
    })
    expect(created.status).toBe(201)

    const other = await signIn('emp2@test.local')
    const view = await other.get(`/api/v1/availability?date=${DAY}&locationId=${fx.hqId}`)

    const slot = view.body.rooms
      .flatMap((r: { busy: unknown[] }) => r.busy)
      .find((b: { bookingId: string }) => b.bookingId === created.body.data.id)

    expect(slot.title).toBe('Busy')
    expect(slot.organizer).toBeNull()
    expect(JSON.stringify(view.body)).not.toContain('Exit interview')
  })

  it('T-59: an admin sees the full details, because they must to move it', async () => {
    const created = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Exit interview - J. Smith',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
      isPrivate: true,
    })

    const view = await admin.get(`/api/v1/availability?date=${DAY}&locationId=${fx.hqId}`)
    const slot = view.body.rooms
      .flatMap((r: { busy: unknown[] }) => r.busy)
      .find((b: { bookingId: string }) => b.bookingId === created.body.data.id)

    expect(slot.title).toBe('Exit interview - J. Smith')
  })
})

// ---------------------------------------------------------------------------

describe('availability and suggestions', () => {
  it('reports bookable windows, busy slots and the free gaps between them', async () => {
    await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Morning',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })

    const res = await employee.get(`/api/v1/availability?date=${DAY}&locationId=${fx.hqId}`)
    expect(res.status).toBe(200)
    expect(res.body.timezone).toBe(ADDIS)

    const room = res.body.rooms.find((r: { roomId: string }) => r.roomId === fx.hqRoomId)
    expect(room.busy).toHaveLength(1)
    expect(room.bookableWindows).toHaveLength(1)
    // 08:00-09:00 and 10:00-18:00 remain.
    expect(room.freeSlots).toHaveLength(2)
  })

  /** BR-C4. A conflict is never a dead end. */
  it('BR-C4: a conflict offers alternatives in the same room and others', async () => {
    const otherRoom = await prisma.room.create({
      data: { organizationId: fx.orgId, locationId: fx.hqId, name: 'Alt Room', capacity: 8 },
    })
    void otherRoom

    const slot = { startsAt: at(`${DAY}T09:00`), endsAt: at(`${DAY}T10:00`) }
    await book(employee, { roomId: fx.hqRoomId, title: 'Taken', ...slot })

    const clash = await book(employee, { roomId: fx.hqRoomId, title: 'Wants it', ...slot })
    expect(clash.status).toBe(409)

    const suggestions = clash.body.error.details.suggestions
    expect(suggestions.sameRoom.length).toBeGreaterThan(0)
    expect(suggestions.otherRooms.length).toBeGreaterThan(0)
    expect(suggestions.otherRooms[0].name).toBe('Alt Room')
  })

  it('finds free rooms, smallest first so a pair does not take the boardroom', async () => {
    await prisma.room.createMany({
      data: [
        { organizationId: fx.orgId, locationId: fx.hqId, name: 'Small', capacity: 2 },
        { organizationId: fx.orgId, locationId: fx.hqId, name: 'Huge', capacity: 40 },
      ],
    })

    const res = await employee.get(
      `/api/v1/availability/find?startsAt=${encodeURIComponent(at(`${DAY}T09:00`))}` +
        `&endsAt=${encodeURIComponent(at(`${DAY}T10:00`))}&locationId=${fx.hqId}`,
    )
    expect(res.status).toBe(200)
    const names = res.body.data.map((r: { name: string }) => r.name)
    expect(names[0]).toBe('Small')
    expect(names).toContain('Huge')
  })

  it('excludes a room that is busy for part of the range', async () => {
    await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Partial',
      startsAt: at(`${DAY}T09:30`),
      endsAt: at(`${DAY}T10:00`),
    })

    const res = await employee.get(
      `/api/v1/availability/find?startsAt=${encodeURIComponent(at(`${DAY}T09:00`))}` +
        `&endsAt=${encodeURIComponent(at(`${DAY}T10:00`))}&locationId=${fx.hqId}`,
    )
    const ids = res.body.data.map((r: { roomId: string }) => r.roomId)
    expect(ids).not.toContain(fx.hqRoomId)
  })
})

// ---------------------------------------------------------------------------

describe('approval-required rooms', () => {
  /** BR-A1/BR-A2. A pending request holds the slot so nobody books over it. */
  it('BR-A2: a pending request blocks the slot', async () => {
    await prisma.room.update({
      where: { id: fx.hqRoomId },
      data: { requiresApproval: true },
    })

    const slot = { startsAt: at(`${DAY}T09:00`), endsAt: at(`${DAY}T10:00`) }
    const requested = await book(employee, { roomId: fx.hqRoomId, title: 'Needs sign-off', ...slot })
    expect(requested.status).toBe(201)
    expect(requested.body.data.status).toBe('PENDING_APPROVAL')
    expect(requested.body.data.approvalExpiresAt).not.toBeNull()

    const over = await book(employee, { roomId: fx.hqRoomId, title: 'Over the top', ...slot })
    expect(over.status).toBe(409)
  })
})

// ---------------------------------------------------------------------------

describe('notifications', () => {
  /** D6: organizer only in v1; attendee templates exist but are gated. */
  it('D6: emails the organizer only, with attendees gated off', async () => {
    const created = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'With guests',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
      attendees: [{ userId: fx.otherEmployee.id }],
    })
    expect(created.status).toBe(201)

    const mails = await prisma.emailOutbox.findMany({ where: { bookingId: created.body.data.id } })
    expect(mails).toHaveLength(1)
    expect(mails[0]?.toEmail).toBe('emp@test.local')
  })

  it('emails attendees once the organization opts in', async () => {
    await prisma.orgSettings.update({
      where: { organizationId: fx.orgId },
      data: { notifyAttendees: true },
    })

    const created = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'With guests',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
      attendees: [{ userId: fx.otherEmployee.id }],
    })

    const mails = await prisma.emailOutbox.findMany({ where: { bookingId: created.body.data.id } })
    expect(mails).toHaveLength(2)
  })

  /** BR-M9. A reminder for a cancelled booking must never fire. */
  it('BR-M9: cancelling cancels any queued reminder', async () => {
    const created = await book(employee, {
      roomId: fx.hqRoomId,
      title: 'Has a reminder',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    const id = created.body.data.id

    await prisma.emailOutbox.create({
      data: {
        organizationId: fx.orgId,
        bookingId: id,
        template: 'booking_reminder',
        toEmail: 'emp@test.local',
        subject: 'Starting soon',
        payload: {},
        scheduledAt: new Date(Date.now() + 3_600_000),
      },
    })

    await employee.post(`/api/v1/bookings/${id}/cancel`, {})

    const reminder = await prisma.emailOutbox.findFirst({
      where: { bookingId: id, template: 'booking_reminder' },
    })
    expect(reminder?.status).toBe('CANCELLED')
  })
})
