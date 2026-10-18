/**
 * The notification pipeline: queueing, sending, retry, reminders.
 *
 * Case IDs refer to docs/10-testing.md.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { zonedTimeToUtc } from '@roombook/shared'

import { prisma } from '../src/db.js'
import { setMailer, type Mailer, type Message } from '../src/mail/Mailer.js'
import { processOutbox } from '../src/mail/OutboxWorker.js'
import { render } from '../src/mail/templates.js'
import { processReminders } from '../src/workers/ReminderWorker.js'
import { mailer, resetDatabase, seedFixture, signIn, type Client, type Fixture } from './helpers.js'

let fx: Fixture
let employee: Client
let admin: Client

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

/** A mailer that fails a configurable number of times before succeeding. */
class FlakyMailer implements Mailer {
  readonly name = 'flaky'
  readonly sent: Message[] = []
  attempts = 0

  constructor(
    private failures: number,
    private readonly error: Error = new Error('Connection timed out'),
  ) {}

  async send(message: Message): Promise<void> {
    this.attempts++
    if (this.failures > 0) {
      this.failures--
      throw this.error
    }
    this.sent.push(message)
  }
}

async function aBooking(title = 'Design review', hour = 9) {
  const res = await employee.post('/api/v1/bookings', {
    roomId: fx.hqRoomId,
    title,
    startsAt: at(`${DAY}T${String(hour).padStart(2, '0')}:00`),
    endsAt: at(`${DAY}T${String(hour + 1).padStart(2, '0')}:00`),
  })
  expect(res.status).toBe(201)
  return res.body.data.id as string
}

beforeEach(async () => {
  await resetDatabase()
  mailer.clear()
  setMailer(mailer)
  fx = await seedFixture()
  ;[employee, admin] = await Promise.all([signIn('emp@test.local'), signIn('admin@test.local')])
})

afterAll(async () => {
  await resetDatabase()
  await prisma.$disconnect()
})

// ---------------------------------------------------------------------------

describe('queueing', () => {
  /** T-70/BR-N2. One row per recipient, never a shared BCC. */
  it('T-70: queues one row per recipient', async () => {
    await prisma.orgSettings.update({
      where: { organizationId: fx.orgId },
      data: { notifyAttendees: true },
    })

    const res = await employee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'With guests',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
      attendees: [{ userId: fx.otherEmployee.id }, { email: 'guest@external.test' }],
    })
    expect(res.status).toBe(201)

    const rows = await prisma.emailOutbox.findMany({ where: { bookingId: res.body.data.id } })
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(r => r.toEmail)).size).toBe(3)
  })

  it('stores the subject at queue time so the log cannot drift', async () => {
    const id = await aBooking('Quarterly review')
    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    expect(row.subject).toContain('Quarterly review')
    expect(row.subject).toContain('Confirmed')
  })
})

// ---------------------------------------------------------------------------

describe('sending', () => {
  it('sends a queued message and records the rendered bodies', async () => {
    const id = await aBooking()

    const result = await processOutbox()
    expect(result.sent).toBe(1)

    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    expect(row.status).toBe('SENT')
    expect(row.sentAt).not.toBeNull()
    // Kept so the admin email log can show exactly what went out.
    expect(row.bodyHtml).toContain('Design review')
    expect(row.bodyText).toContain('Design review')
    expect(row.attempts).toBe(1)
  })

  it('always sends a plain-text alternative alongside the html', async () => {
    await aBooking()
    await processOutbox()

    const sent = mailer.sent[0]!
    expect(sent.text.length).toBeGreaterThan(20)
    expect(sent.html).toContain('<!doctype html>')
    // The text version must carry the real content, not a stub.
    expect(sent.text).toContain('Design review')
  })

  it('attaches a calendar invitation with the correct method', async () => {
    await aBooking()
    await processOutbox()

    const attachment = mailer.sent[0]!.attachments?.[0]
    expect(attachment).toBeDefined()
    expect(attachment!.filename).toBe('invite.ics')
    expect(attachment!.contentType).toContain('method=REQUEST')
    expect(attachment!.content).toContain('BEGIN:VCALENDAR')
    expect(attachment!.content).toContain('METHOD:REQUEST')
  })

  it('threads all mail about one booking together', async () => {
    const id = await aBooking()
    await processOutbox()
    expect(mailer.sent[0]!.references).toBe(`<booking-${id}@roombook>`)
  })

  it('does not send a message that is scheduled for the future', async () => {
    const id = await aBooking()
    await prisma.emailOutbox.updateMany({
      where: { bookingId: id },
      data: { scheduledAt: new Date(Date.now() + 3_600_000) },
    })

    expect((await processOutbox()).sent).toBe(0)
    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    expect(row.status).toBe('QUEUED')
  })

  it('claims each message exactly once even when passes overlap', async () => {
    await aBooking('One', 9)
    await aBooking('Two', 11)

    // Two concurrent passes must not both claim the same rows.
    const [a, b] = await Promise.all([processOutbox(), processOutbox()])
    expect(a.sent + b.sent).toBe(2)

    const addresses = mailer.sent.map(m => `${m.subject}|${m.to}`)
    expect(new Set(addresses).size).toBe(addresses.length)
  })
})

// ---------------------------------------------------------------------------

describe('retry and failure', () => {
  /** T-75. A transient failure must be retried, and deliver exactly once. */
  it('T-75: retries a transient failure and eventually delivers once', async () => {
    const flaky = new FlakyMailer(2)
    setMailer(flaky)

    const id = await aBooking()

    // First pass fails.
    await processOutbox()
    let row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    expect(row.status).toBe('QUEUED')
    expect(row.attempts).toBe(1)
    // Backed off, so an immediate pass does nothing.
    expect(row.scheduledAt.getTime()).toBeGreaterThan(Date.now())

    // Simulate the backoff elapsing, twice.
    for (let i = 0; i < 2; i++) {
      await prisma.emailOutbox.update({ where: { id: row.id }, data: { scheduledAt: new Date() } })
      await processOutbox()
      row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    }

    expect(row.status).toBe('SENT')
    expect(row.attempts).toBe(3)
    // Delivered once, despite three attempts.
    expect(flaky.sent).toHaveLength(1)
  })

  /** T-76. After the last attempt the row must be visible to an admin. */
  it('T-76: gives up after five attempts and records the error', async () => {
    const alwaysFails = new FlakyMailer(99)
    setMailer(alwaysFails)

    const id = await aBooking()

    for (let i = 0; i < 5; i++) {
      await prisma.emailOutbox.updateMany({
        where: { bookingId: id },
        data: { scheduledAt: new Date() },
      })
      await processOutbox()
    }

    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    expect(row.status).toBe('FAILED')
    expect(row.attempts).toBe(5)
    expect(row.lastError).toContain('Connection timed out')
  })

  /**
   * A rejected recipient fails identically forever. Retrying it five times
   * wastes attempts and delays the FAILED state an admin needs to see.
   */
  it('does not retry a permanent failure', async () => {
    const rejected = new FlakyMailer(99, new Error('550 Mailbox unavailable'))
    setMailer(rejected)

    const id = await aBooking()
    await processOutbox()

    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    expect(row.status).toBe('FAILED')
    expect(row.attempts).toBe(1)
    expect(row.lastError).toContain('Permanent')
  })

  it('one bad address does not block the others', async () => {
    const perRecipient: Mailer = {
      name: 'selective',
      async send(message) {
        if (message.to === 'emp@test.local') throw new Error('550 user unknown')
      },
    }
    setMailer(perRecipient)

    await prisma.orgSettings.update({
      where: { organizationId: fx.orgId },
      data: { notifyAttendees: true },
    })

    const res = await employee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Mixed outcome',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
      attendees: [{ userId: fx.otherEmployee.id }],
    })

    await processOutbox()

    const rows = await prisma.emailOutbox.findMany({ where: { bookingId: res.body.data.id } })
    expect(rows.find(r => r.toEmail === 'emp@test.local')?.status).toBe('FAILED')
    expect(rows.find(r => r.toEmail === 'emp2@test.local')?.status).toBe('SENT')
  })

  /** T-77. A crash mid-send must not lose the message. */
  it('T-77: requeues a message stranded in SENDING by a crash', async () => {
    const id = await aBooking()

    // Simulate a process that claimed the row and then died.
    await prisma.emailOutbox.updateMany({
      where: { bookingId: id },
      data: { status: 'SENDING', createdAt: new Date(Date.now() - 11 * 60_000) },
    })

    const result = await processOutbox()
    expect(result.sent).toBe(1)

    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    expect(row.status).toBe('SENT')
  })

  it('leaves a recently claimed message alone, since it may still be in flight', async () => {
    const id = await aBooking()
    await prisma.emailOutbox.updateMany({
      where: { bookingId: id },
      data: { status: 'SENDING' },
    })

    expect((await processOutbox()).sent).toBe(0)
    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    expect(row.status).toBe('SENDING')
  })
})

// ---------------------------------------------------------------------------

describe('move and cancel notifications', () => {
  /** T-71. The reason must reach the organizer word for word. */
  it('T-71: a move email shows before and after and quotes the reason', async () => {
    const id = await aBooking()
    await processOutbox()
    mailer.clear()

    const otherRoom = await prisma.room.create({
      data: { organizationId: fx.orgId, locationId: fx.hqId, name: 'Room C', capacity: 6 },
    })

    await admin.post(`/api/v1/bookings/${id}/move`, {
      roomId: otherRoom.id,
      reason: 'Boardroom required for the quarterly review',
    })
    await processOutbox()

    const sent = mailer.sent.find(m => m.subject.startsWith('Moved:'))
    expect(sent).toBeDefined()

    // Both rooms named, the words Before and After present, reason verbatim.
    expect(sent!.html).toContain('Boardroom')
    expect(sent!.html).toContain('Room C')
    expect(sent!.html).toContain('Before')
    expect(sent!.html).toContain('After')
    expect(sent!.html).toContain('Boardroom required for the quarterly review')
    expect(sent!.text).toContain('Before:')
    expect(sent!.text).toContain('quarterly review')

    // The ics must update rather than duplicate: same uid, advanced sequence.
    const ics = sent!.attachments?.[0]?.content ?? ''
    expect(ics).toContain('METHOD:REQUEST')
    expect(ics).toContain('SEQUENCE:1')
  })

  /** T-72. A cancellation needs METHOD:CANCEL to leave the calendar. */
  it('T-72: a cancellation sends METHOD:CANCEL with the reason', async () => {
    const id = await aBooking()
    await processOutbox()
    mailer.clear()

    await admin.post(`/api/v1/bookings/${id}/cancel`, {
      reason: 'Emergency maintenance on the projector',
    })
    await processOutbox()

    const sent = mailer.sent.find(m => m.subject.startsWith('Cancelled:'))
    expect(sent).toBeDefined()
    expect(sent!.html).toContain('Emergency maintenance on the projector')

    const ics = sent!.attachments?.[0]?.content ?? ''
    expect(ics).toContain('METHOD:CANCEL')
    expect(ics).toContain('STATUS:CANCELLED')
  })

  /**
   * T-79. The reason is free text an admin types. It must not be able to
   * inject markup into the email the organizer opens.
   */
  it('T-79: escapes html in a cancellation reason', async () => {
    const id = await aBooking()
    mailer.clear()

    await admin.post(`/api/v1/bookings/${id}/cancel`, {
      reason: '<script>alert(1)</script> and <b>bold</b>',
    })
    await processOutbox()

    const sent = mailer.sent.find(m => m.subject.startsWith('Cancelled:'))!
    expect(sent.html).not.toContain('<script>')
    expect(sent.html).toContain('&lt;script&gt;')
    expect(sent.html).not.toContain('<b>bold</b>')
  })

  it('escapes html in a meeting title too', async () => {
    const id = await aBooking('<img src=x onerror=alert(1)>')
    await processOutbox()
    const sent = mailer.sent[0]!
    expect(sent.html).not.toContain('<img src=x')
    expect(sent.html).toContain('&lt;img')
  })
})

// ---------------------------------------------------------------------------

describe('reminders', () => {
  async function aBookingStartingIn(minutes: number, status = 'CONFIRMED') {
    const start = new Date(Date.now() + minutes * 60_000)
    return prisma.booking.create({
      data: {
        organizationId: fx.orgId,
        roomId: fx.hqRoomId,
        organizerId: fx.employee.id,
        createdById: fx.employee.id,
        title: 'Soon',
        startsAt: start,
        endsAt: new Date(start.getTime() + 3_600_000),
        status: status as never,
        icsUid: `rem-${Math.random().toString(36).slice(2)}@roombook`,
      },
    })
  }

  it('queues a reminder for a booking inside the lead window', async () => {
    const booking = await aBookingStartingIn(10)

    const result = await processReminders()
    expect(result.queued).toBe(1)

    const row = await prisma.emailOutbox.findFirstOrThrow({
      where: { bookingId: booking.id, template: 'booking_reminder' },
    })
    expect(row.toEmail).toBe('emp@test.local')
    expect(row.subject).toMatch(/Starting in \d+ minutes/)
  })

  it('does not queue one for a booking beyond the lead window', async () => {
    await aBookingStartingIn(120)
    expect((await processReminders()).queued).toBe(0)
  })

  /** BR-N6. A cancelled meeting must never remind. */
  it('BR-N6: skips cancelled and pending bookings', async () => {
    await aBookingStartingIn(10, 'CANCELLED')
    await aBookingStartingIn(10, 'PENDING_APPROVAL')
    expect((await processReminders()).queued).toBe(0)
  })

  it('queues at most one reminder per booking', async () => {
    await aBookingStartingIn(10)
    await processReminders()
    await processReminders()

    const rows = await prisma.emailOutbox.findMany({ where: { template: 'booking_reminder' } })
    expect(rows).toHaveLength(1)
  })

  /** T-82/BR-N8. Reminders are mutable; cancellations are not. */
  it('T-82: respects a reminder opt-out but still sends cancellations', async () => {
    await prisma.user.update({
      where: { id: fx.employee.id },
      data: { emailOptOutReminders: true },
    })

    await aBookingStartingIn(10)
    const result = await processReminders()
    expect(result.queued).toBe(0)
    expect(result.dropped).toBe(1)

    // A cancellation is not optional.
    const id = await aBooking('Not optional', 14)
    mailer.clear()
    await admin.post(`/api/v1/bookings/${id}/cancel`, { reason: 'Room needed elsewhere' })
    await processOutbox()
    expect(mailer.sent.some(m => m.subject.startsWith('Cancelled:'))).toBe(true)
  })

  /**
   * T-78/BR-N7. A reminder arriving after the meeting started is worse than
   * none: it tells the recipient something they already know.
   */
  it('T-78: does not queue a reminder for a meeting that already started', async () => {
    await aBookingStartingIn(-30)
    expect((await processReminders()).queued).toBe(0)
  })

  it('a reminder carries no calendar attachment', async () => {
    await aBookingStartingIn(10)
    await processReminders()
    await processOutbox()

    const sent = mailer.sent.find(m => m.subject.startsWith('Starting in'))!
    expect(sent.attachments ?? []).toHaveLength(0)
    // Marked bulk so out-of-office replies do not storm back.
    expect(sent.precedence).toBe('bulk')
  })

  /** BR-M9. A queued reminder for a cancelled booking must never fire. */
  it('BR-M9: cancelling a booking cancels its queued reminder', async () => {
    const booking = await aBookingStartingIn(10)
    await processReminders()

    // Cancel it directly, since the API refuses to cancel an imminent meeting
    // only once it has started; this one has not.
    const client = await signIn('admin@test.local')
    const res = await client.post(`/api/v1/bookings/${booking.id}/cancel`, {
      reason: 'No longer needed',
    })
    expect(res.status).toBe(200)

    const reminder = await prisma.emailOutbox.findFirstOrThrow({
      where: { bookingId: booking.id, template: 'booking_reminder' },
    })
    expect(reminder.status).toBe('CANCELLED')

    // And it must not be picked up by a later pass.
    const before = mailer.sent.length
    await processOutbox()
    expect(mailer.sent.filter(m => m.subject.startsWith('Starting in'))).toHaveLength(0)
    expect(mailer.sent.length).toBeGreaterThanOrEqual(before)
  })
})

// ---------------------------------------------------------------------------

describe('admin email log', () => {
  it('lists messages with a status summary', async () => {
    await aBooking()
    await processOutbox()

    const res = await admin.get('/api/v1/admin/emails')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.meta.counts.SENT).toBe(1)
    expect(res.body.meta.maxAttempts).toBe(5)
  })

  it('is closed to employees', async () => {
    expect((await employee.get('/api/v1/admin/emails')).status).toBe(403)
  })

  /** US-N6. An admin must be able to answer "did Bob get told?". */
  it('US-N6: shows the exact body that was sent', async () => {
    const id = await aBooking()
    await processOutbox()

    const list = await admin.get(`/api/v1/admin/emails?bookingId=${id}`)
    const detail = await admin.get(`/api/v1/admin/emails/${list.body.data[0].id}`)

    expect(detail.status).toBe(200)
    expect(detail.body.data.bodyHtml).toContain('Design review')
    expect(detail.body.data.bodyText).toContain('Design review')
  })

  it('requeues a failed message', async () => {
    setMailer(new FlakyMailer(99))
    const id = await aBooking()

    for (let i = 0; i < 5; i++) {
      await prisma.emailOutbox.updateMany({
        where: { bookingId: id },
        data: { scheduledAt: new Date() },
      })
      await processOutbox()
    }

    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    expect(row.status).toBe('FAILED')

    setMailer(mailer)
    const resend = await admin.post(`/api/v1/admin/emails/${row.id}/resend`)
    expect(resend.status).toBe(200)

    await processOutbox()
    const after = await prisma.emailOutbox.findFirstOrThrow({ where: { id: row.id } })
    expect(after.status).toBe('SENT')
    expect(after.attempts).toBe(1)
  })

  /** Resending something already delivered would deliver it twice. */
  it('refuses to resend a message that was already sent', async () => {
    const id = await aBooking()
    await processOutbox()

    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { bookingId: id } })
    const res = await admin.post(`/api/v1/admin/emails/${row.id}/resend`)

    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/twice/i)
  })
})

// ---------------------------------------------------------------------------

describe('template rendering', () => {
  it('names the timezone on every rendered time', () => {
    const rendered = render('booking_confirmed', {
      title: 'Standup',
      room: 'Boardroom',
      location: 'Head Office',
      timeZone: ADDIS,
      startsAt: '2026-11-04T06:00:00Z',
      endsAt: '2026-11-04T07:00:00Z',
      organizer: 'Alice Bekele',
    })

    // A time without its zone is how people dial in an hour late.
    expect(rendered.text).toMatch(/GMT\+3|EAT/)
    expect(rendered.html).toMatch(/GMT\+3|EAT/)
  })

  it('falls back gracefully for an unknown template', () => {
    const rendered = render('something_new', { title: 'Fallback' }, 'Stored subject')
    expect(rendered.subject).toBe('Stored subject')
    expect(rendered.html).toContain('Fallback')
    expect(rendered.text).toContain('Fallback')
  })

  it('renders a move with only a time change without an empty room row', () => {
    const rendered = render('booking_moved', {
      title: 'Standup',
      room: 'Boardroom',
      timeZone: ADDIS,
      startsAt: '2026-11-04T08:00:00Z',
      endsAt: '2026-11-04T09:00:00Z',
      previousStartsAt: '2026-11-04T06:00:00Z',
      previousEndsAt: '2026-11-04T07:00:00Z',
      timeChanged: true,
      roomChanged: false,
      movedBy: 'Sara Mengistu',
    })

    expect(rendered.text).toContain('Sara Mengistu has moved your meeting')
    expect(rendered.text).toContain('When:')
    expect(rendered.text).not.toContain('Room:\n  Before:')
  })
})

// ---------------------------------------------------------------------------

describe('approval-required rooms', () => {
  beforeEach(async () => {
    await prisma.room.update({
      where: { id: fx.hqRoomId },
      data: { requiresApproval: true },
    })
  })

  /**
   * Reported from real use: booking an approval-required room sent an email
   * saying "Confirmed" before anyone had approved it.
   *
   * Three separate defects produced that: the template was hardcoded to
   * booking_confirmed, the subject fell through to a "Confirmed:" default, and
   * a calendar invitation was attached for a booking that might be rejected.
   */
  it('does not say confirmed for a booking that is awaiting approval', async () => {
    const res = await employee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Board meeting',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('PENDING_APPROVAL')

    const row = await prisma.emailOutbox.findFirstOrThrow({
      where: { bookingId: res.body.data.id },
    })

    expect(row.template).toBe('booking_pending')
    expect(row.subject).not.toMatch(/confirmed/i)
    expect(row.subject).toMatch(/^Requested:/)

    await processOutbox()
    const sent = mailer.sent[0]!
    expect(sent.subject).not.toMatch(/confirmed/i)
    expect(sent.text).not.toMatch(/your booking is confirmed/i)
    expect(sent.text).toMatch(/awaiting approval/i)
  })

  /**
   * BR-A13. A tentative calendar entry that may vanish is worse than none:
   * the recipient plans around a meeting that was never approved.
   */
  it('BR-A13: attaches no calendar invitation until the booking is approved', async () => {
    const res = await employee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Board meeting',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })

    const row = await prisma.emailOutbox.findFirstOrThrow({
      where: { bookingId: res.body.data.id },
    })
    expect(row.icsMethod).toBeNull()

    await processOutbox()
    expect(mailer.sent[0]!.attachments ?? []).toHaveLength(0)
  })

  it('still says confirmed for a room that needs no approval', async () => {
    await prisma.room.update({
      where: { id: fx.hqRoomId },
      data: { requiresApproval: false },
    })

    const res = await employee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Ordinary meeting',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })

    const row = await prisma.emailOutbox.findFirstOrThrow({
      where: { bookingId: res.body.data.id },
    })
    expect(row.template).toBe('booking_confirmed')
    expect(row.subject).toMatch(/^Confirmed:/)
    expect(row.icsMethod).toBe('REQUEST')
  })

  it('tells the requester the room is being held for them', async () => {
    const res = await employee.post('/api/v1/bookings', {
      roomId: fx.hqRoomId,
      title: 'Board meeting',
      startsAt: at(`${DAY}T09:00`),
      endsAt: at(`${DAY}T10:00`),
    })
    void res

    await processOutbox()
    // The useful reassurance: nobody can book over it while it waits.
    expect(mailer.sent[0]!.text).toMatch(/held for you/i)
  })
})
