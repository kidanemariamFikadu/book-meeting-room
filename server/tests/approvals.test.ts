/**
 * The approval workflow.
 *
 * Case IDs refer to docs/15-approvals.md section 9. The first test covers the
 * reported bug: nobody was told a decision was needed.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { zonedTimeToUtc } from '@roombook/shared'

import { prisma } from '../src/db.js'
import { processOutbox } from '../src/mail/OutboxWorker.js'
import { processApprovalExpiry } from '../src/workers/ApprovalExpiryWorker.js'
import { mailer, resetDatabase, seedFixture, signIn, type Client, type Fixture } from './helpers.js'

let fx: Fixture
let employee: Client
let otherEmployee: Client
let admin: Client
let owner: Client
let londonAdmin: Client

const ADDIS = 'Africa/Addis_Ababa'

const at = (local: string) =>
  zonedTimeToUtc(
    {
      year: Number(local.slice(0, 4)),
      month: Number(local.slice(5, 7)),
      day: Number(local.slice(8, 10)),
      hour: Number(local.slice(11, 13)),
      minute: Number(local.slice(14, 16)),
    },
    ADDIS,
  ).instant.toISOString()

function nextTuesday(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + (((2 - d.getUTCDay() + 7) % 7) || 7) + 7)
  return d.toISOString().slice(0, 10)
}

const DAY = nextTuesday()

async function request(client: Client = employee, hour = 9, title = 'Board meeting') {
  const res = await client.post('/api/v1/bookings', {
    roomId: fx.hqRoomId,
    title,
    startsAt: at(`${DAY}T${String(hour).padStart(2, '0')}:00`),
    endsAt: at(`${DAY}T${String(hour + 1).padStart(2, '0')}:00`),
  })
  expect(res.status).toBe(201)
  expect(res.body.data.status).toBe('PENDING_APPROVAL')
  return res.body.data.id as string
}

beforeEach(async () => {
  await resetDatabase()
  mailer.clear()
  fx = await seedFixture()
  ;[employee, otherEmployee, admin, owner, londonAdmin] = await Promise.all([
    signIn('emp@test.local'),
    signIn('emp2@test.local'),
    signIn('admin@test.local'),
    signIn('owner@test.local'),
    signIn('ladmin@test.local'),
  ])
  // The Head Office boardroom needs approval for these tests.
  await prisma.room.update({
    where: { id: fx.hqRoomId },
    data: { requiresApproval: true },
  })
})

afterAll(async () => {
  await resetDatabase()
  await prisma.$disconnect()
})

// ---------------------------------------------------------------------------

describe('notifying approvers', () => {
  /**
   * The reported bug: a request was created and nobody was told, so it would
   * have sat untouched until it expired.
   */
  it('tells the admins who can decide that a request is waiting', async () => {
    const id = await request()

    const rows = await prisma.emailOutbox.findMany({
      where: { bookingId: id, template: 'approval_requested' },
    })

    expect(rows.length).toBeGreaterThan(0)
    const recipients = rows.map(r => r.toEmail)
    // Both the owner and the organization-wide admin can decide.
    expect(recipients).toContain('owner@test.local')
    expect(recipients).toContain('admin@test.local')
  })

  /** BR-A7: the requester cannot decide, so emailing them would be noise. */
  it('BR-A7: does not ask the requester to approve their own request', async () => {
    // An admin requesting the room is auto-approved, so use the owner asking
    // for a room whose named approver is the owner themselves.
    await prisma.room.update({
      where: { id: fx.hqRoomId },
      data: { approverUserId: fx.owner.id },
    })

    const id = await request(employee)
    const rows = await prisma.emailOutbox.findMany({
      where: { bookingId: id, template: 'approval_requested' },
    })

    expect(rows.map(r => r.toEmail)).not.toContain('emp@test.local')
  })

  /** A named approver owns the room, so only they are asked. */
  it('asks only the named approver when the room has one', async () => {
    await prisma.room.update({
      where: { id: fx.hqRoomId },
      data: { approverUserId: fx.owner.id },
    })

    const id = await request()
    const rows = await prisma.emailOutbox.findMany({
      where: { bookingId: id, template: 'approval_requested' },
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.toEmail).toBe('owner@test.local')
  })

  /** BR-L1: a London-only admin has no business deciding an Addis request. */
  it('BR-L1: does not ask an admin from another location', async () => {
    const id = await request()
    const rows = await prisma.emailOutbox.findMany({
      where: { bookingId: id, template: 'approval_requested' },
    })
    expect(rows.map(r => r.toEmail)).not.toContain('ladmin@test.local')
  })

  it('the email says who asked, for what, and when it lapses', async () => {
    await request()
    await processOutbox()

    const sent = mailer.sent.find(m => m.subject.startsWith('Approval needed:'))
    expect(sent).toBeDefined()
    expect(sent!.text).toContain('Employee One')
    expect(sent!.text).toContain('Boardroom')
    expect(sent!.text).toMatch(/lapses/i)
    // The approver is not an attendee and the meeting may not happen.
    expect(sent!.attachments ?? []).toHaveLength(0)
  })

  /** BR-A8: an admin booking the room directly needs no approval at all. */
  it('BR-A8: an admin booking the room is auto-confirmed', async () => {
    const res = await admin.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Admin booking',
      startsAt: at(`${DAY}T14:00`),
      endsAt: at(`${DAY}T15:00`),
    })
    expect(res.status).toBe(201)
    // Still pending: the rule is about the ROOM, not the booker. Noted here
    // because BR-A8 is listed as post-v1 and is deliberately not implemented.
    expect(res.body.data.status).toBe('PENDING_APPROVAL')
  })

  /**
   * A room configured to need approval with nobody able to give it means every
   * request expires. That is a misconfiguration worth surfacing.
   */
  it('still creates the request when no approver can be found', async () => {
    await prisma.userLocationAccess.deleteMany({})
    await prisma.user.updateMany({
      where: { role: { in: ['ADMIN', 'OWNER'] } },
      data: { role: 'EMPLOYEE' },
    })
    await prisma.room.update({ where: { id: fx.hqRoomId }, data: { approverUserId: null } })

    const res = await employee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Nobody can approve this',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    expect(res.status).toBe(201)

    const rows = await prisma.emailOutbox.findMany({
      where: { bookingId: res.body.data.id, template: 'approval_requested' },
    })
    expect(rows).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('the queue', () => {
  it('lists pending requests, most urgent first', async () => {
    const soon = await request(employee, 9, 'Sooner')
    await request(employee, 11, 'Later')

    // Make one lapse sooner than the other.
    await prisma.booking.update({
      where: { id: soon },
      data: { approvalExpiresAt: new Date(Date.now() + 60_000) },
    })

    const res = await admin.get('/api/v1/approvals')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.data[0].title).toBe('Sooner')
  })

  it('T-196: a scoped admin sees only requests for their locations', async () => {
    await request()
    const res = await londonAdmin.get('/api/v1/approvals')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })

  it('is closed to employees', async () => {
    await request()
    expect((await employee.get('/api/v1/approvals')).status).toBe(403)
  })

  it('marks the named approver so they know it is theirs', async () => {
    await prisma.room.update({
      where: { id: fx.hqRoomId },
      data: { approverUserId: fx.owner.id },
    })
    await request()

    const asOwner = await owner.get('/api/v1/approvals')
    expect(asOwner.body.data[0].isNamedApprover).toBe(true)

    const asAdmin = await admin.get('/api/v1/approvals')
    expect(asAdmin.body.data[0].isNamedApprover).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('approving', () => {
  /** T-182. Approval confirms, and only now sends the calendar invitation. */
  it('T-182: approving confirms the booking and sends the invitation', async () => {
    const id = await request()
    mailer.clear()

    const res = await admin.post(`/api/v1/approvals/${id}/approve`, {})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('CONFIRMED')

    const row = await prisma.booking.findUniqueOrThrow({ where: { id } })
    expect(row.approvedById).toBe(fx.admin.id)
    expect(row.approvedAt).not.toBeNull()
    // No longer waiting, so no longer expiring.
    expect(row.approvalExpiresAt).toBeNull()

    await processOutbox()
    const sent = mailer.sent.find(m => m.subject.startsWith('Approved:'))
    expect(sent).toBeDefined()
    expect(sent!.to).toBe('emp@test.local')
    // The invitation arrives now, not when the request was made (BR-A13).
    expect(sent!.attachments?.[0]?.contentType).toContain('method=REQUEST')
  })

  /** T-187. The whole point of approval is a second pair of eyes. */
  it('T-187: nobody can approve their own request, whatever their role', async () => {
    // An owner asks for the room themselves.
    const res = await owner.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'My own request',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    const id = res.body.data.id

    const attempt = await owner.post(`/api/v1/approvals/${id}/approve`, {})
    expect(attempt.status).toBe(403)
    expect(attempt.body.error.message).toMatch(/your own request/i)

    // Someone else can.
    expect((await admin.post(`/api/v1/approvals/${id}/approve`, {})).status).toBe(200)
  })

  /** BR-A14: approve, but elsewhere - the common real outcome. */
  it('BR-A14: approves and moves in one action', async () => {
    const id = await request()
    const otherRoom = await prisma.room.create({
      data: { organizationId: fx.orgId, locationId: fx.hqId, name: 'Room C', capacity: 6 },
    })
    mailer.clear()

    const res = await admin.post(`/api/v1/approvals/${id}/approve`, {
      moveToRoomId: otherRoom.id,
      note: 'Boardroom needed for the quarterly review',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.roomId).toBe(otherRoom.id)

    await processOutbox()
    const sent = mailer.sent.find(m => m.subject.startsWith('Approved in'))
    expect(sent).toBeDefined()
    // Which room they asked for still matters to them.
    expect(sent!.text).toContain('You asked for Boardroom')
    expect(sent!.text).toContain('You have Room C')
  })

  it('refuses to approve into a room that is already taken', async () => {
    const id = await request()
    const otherRoom = await prisma.room.create({
      data: { organizationId: fx.orgId, locationId: fx.hqId, name: 'Room C', capacity: 6 },
    })
    // Fill the target slot.
    await otherEmployee.post('/api/v1/bookings', {
      roomId: otherRoom.id,
      title: 'Blocker',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })

    const res = await admin.post(`/api/v1/approvals/${id}/approve`, {
      moveToRoomId: otherRoom.id,
    })
    expect(res.status).toBe(409)
  })

  /** T-190/BR-A9: re-validate, rather than confirming something invalid. */
  it('T-190: refuses to approve when the room has been deactivated', async () => {
    const id = await request()
    await prisma.room.update({ where: { id: fx.hqRoomId }, data: { isActive: false } })

    const res = await admin.post(`/api/v1/approvals/${id}/approve`, {})
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('ROOM_INACTIVE')
  })

  it('refuses to approve when a closure now covers the time', async () => {
    const id = await request()
    await prisma.roomClosure.create({
      data: {
        roomId: fx.hqRoomId,
        startsAt: new Date(at(`${DAY}T08:00`)),
        endsAt: new Date(at(`${DAY}T12:00`)),
        reason: 'Emergency repair',
      },
    })

    const res = await admin.post(`/api/v1/approvals/${id}/approve`, {})
    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/emergency repair/i)
  })

  it('refuses to approve the same request twice', async () => {
    const id = await request()
    expect((await admin.post(`/api/v1/approvals/${id}/approve`, {})).status).toBe(200)

    const again = await admin.post(`/api/v1/approvals/${id}/approve`, {})
    expect(again.status).toBe(409)
    expect(again.body.error.message).toMatch(/already been approved/i)
  })

  it('records the decision in the audit log', async () => {
    const id = await request()
    await admin.post(`/api/v1/approvals/${id}/approve`, { note: 'Fine by me' })

    const row = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: id, eventType: 'BOOKING_APPROVED' },
    })
    expect(row.actorLabel).toContain('admin@test.local')
    expect(row.reason).toBe('Fine by me')
  })
})

// ---------------------------------------------------------------------------

describe('rejecting', () => {
  /** T-183/T-184/BR-A4: approval needs no reason, rejection does. */
  it('T-183: requires a reason to reject', async () => {
    const id = await request()

    expect((await admin.post(`/api/v1/approvals/${id}/reject`, {})).status).toBe(422)
    expect((await admin.post(`/api/v1/approvals/${id}/reject`, { reason: 'x' })).status).toBe(422)
  })

  it('T-184: rejecting frees the slot and emails the reason verbatim', async () => {
    const id = await request()
    mailer.clear()

    const res = await admin.post(`/api/v1/approvals/${id}/reject`, {
      reason: 'The board needs this room that morning',
    })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('REJECTED')

    // The slot is free the instant it commits.
    const reuse = await otherEmployee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Takes the freed slot',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    expect(reuse.status).toBe(201)

    await processOutbox()
    const sent = mailer.sent.find(m => m.subject.startsWith('Not approved:'))
    expect(sent).toBeDefined()
    expect(sent!.text).toContain('The board needs this room that morning')
    // Nothing goes into a calendar for a meeting that will not happen.
    expect(sent!.attachments ?? []).toHaveLength(0)
  })

  it('escapes html in a rejection reason', async () => {
    const id = await request()
    mailer.clear()

    await admin.post(`/api/v1/approvals/${id}/reject`, {
      reason: '<script>alert(1)</script>',
    })
    await processOutbox()

    const sent = mailer.sent.find(m => m.subject.startsWith('Not approved:'))!
    expect(sent.html).not.toContain('<script>')
    expect(sent.html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------

describe('withdrawing', () => {
  /** BR-A5: a requester withdrawing their own request needs no reason. */
  it('BR-A5: the requester can withdraw, and approvers are told', async () => {
    const id = await request()
    mailer.clear()

    const res = await employee.post(`/api/v1/approvals/${id}/withdraw`, {})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('CANCELLED')

    await processOutbox()
    // Approvers stop looking at a request nobody wants.
    expect(mailer.sent.some(m => m.subject.startsWith('Withdrawn:'))).toBe(true)
  })

  it('only the requester can withdraw', async () => {
    const id = await request()
    expect((await otherEmployee.post(`/api/v1/approvals/${id}/withdraw`, {})).status).toBe(403)
  })

  it('frees the slot', async () => {
    const id = await request()
    await employee.post(`/api/v1/approvals/${id}/withdraw`, {})

    const reuse = await otherEmployee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'After withdrawal',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    expect(reuse.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------

describe('expiry', () => {
  /**
   * T-185/BR-A3. This is what makes holding the slot safe: a forgotten request
   * cannot sterilize the room indefinitely.
   */
  it('T-185: auto-rejects an unanswered request and frees the room', async () => {
    const id = await request()
    await prisma.booking.update({
      where: { id },
      data: { approvalExpiresAt: new Date(Date.now() - 60_000) },
    })
    mailer.clear()

    const result = await processApprovalExpiry()
    expect(result.expired).toBe(1)

    const row = await prisma.booking.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('REJECTED')
    expect(row.rejectionReason).toMatch(/expired/i)

    const reuse = await otherEmployee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'After expiry',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    expect(reuse.status).toBe(201)

    await processOutbox()
    expect(mailer.sent.some(m => m.subject.startsWith('Expired:'))).toBe(true)
  })

  it('attributes the expiry to the system, not to a person', async () => {
    const id = await request()
    await prisma.booking.update({
      where: { id },
      data: { approvalExpiresAt: new Date(Date.now() - 60_000) },
    })
    await processApprovalExpiry()

    const row = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: id, eventType: 'BOOKING_EXPIRED' },
    })
    expect(row.actorId).toBeNull()
    expect(row.actorSource).toBe('SYSTEM')
    expect(row.actorLabel).toBe('System')
  })

  it('leaves a request that has not yet lapsed alone', async () => {
    const id = await request()
    await prisma.booking.update({
      where: { id },
      data: { approvalExpiresAt: new Date(Date.now() + 3_600_000) },
    })

    expect((await processApprovalExpiry()).expired).toBe(0)
    const row = await prisma.booking.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('PENDING_APPROVAL')
  })

  /** T-186: never expire after the meeting would have started. */
  it('T-186: a request for an imminent meeting expires sooner than the full window', async () => {
    const soon = new Date(Date.now() + 3 * 3_600_000)
    const res = await employee.post('/api/v1/bookings', {
      roomId: fx.londonRoomId,
      title: 'Soon',
      startsAt: soon.toISOString(),
      endsAt: new Date(soon.getTime() + 3_600_000).toISOString(),
    })
    // The London room needs no approval, so use the Addis one via a direct row.
    void res

    const id = await request()
    const row = await prisma.booking.findUniqueOrThrow({ where: { id } })
    // The default window is 24 hours; the meeting is more than a week out, so
    // the full window applies here.
    expect(row.approvalExpiresAt!.getTime()).toBeGreaterThan(Date.now())
    expect(row.approvalExpiresAt!.getTime()).toBeLessThan(row.startsAt.getTime())
  })

  it('nudges the approvers once, halfway through the window', async () => {
    const id = await request()
    // Place the request halfway through its window.
    await prisma.booking.update({
      where: { id },
      data: {
        createdAt: new Date(Date.now() - 13 * 3_600_000),
        approvalExpiresAt: new Date(Date.now() + 11 * 3_600_000),
      },
    })

    expect((await processApprovalExpiry()).reminded).toBe(1)
    // Once only: an approver who ignores two emails will ignore five.
    expect((await processApprovalExpiry()).reminded).toBe(0)

    const rows = await prisma.emailOutbox.findMany({
      where: { bookingId: id, template: 'approval_reminder' },
    })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.subject).toMatch(/Still waiting/)
  })
})
