/**
 * The outbox worker.
 *
 * Email is queued transactionally with the change that caused it, so this
 * worker's only job is to drain the queue reliably. The properties that matter:
 *
 *  - a crash mid-send must not lose a message, and must not send it twice;
 *  - one bad address must not block everyone else;
 *  - a transient SMTP failure must be retried, a permanent one must not be.
 *
 * Specification: docs/06-email-notifications.md section 1.
 */

import { Prisma } from '@prisma/client'

import { config } from '../config.js'
import { prisma } from '../db.js'
import { logger } from '../middleware/requestContext.js'
import { getMailer } from './Mailer.js'
import { buildIcs, type IcsMethod } from './ics.js'
import { render, type BookingPayload } from './templates.js'

/** 1 min, 5 min, 15 min, 1 h, 6 h — then the row is marked FAILED. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 360]
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length

const BATCH_SIZE = 20

/**
 * A row left in SENDING for longer than this is assumed orphaned by a crash
 * and returned to the queue. Generous enough that a slow relay is not treated
 * as a crash.
 */
const ORPHAN_MINUTES = 10

export interface SendResult {
  sent: number
  failed: number
  requeued: number
}

/**
 * Claims up to `BATCH_SIZE` due rows atomically.
 *
 * A single UPDATE ... RETURNING is what makes this safe: two workers, or two
 * overlapping ticks of the same worker, cannot claim the same row, because the
 * database serializes the update. Selecting and then updating would allow both
 * to pick up the same message and send it twice.
 */
async function claimBatch(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "email_outbox"
    SET "status" = 'SENDING'
    WHERE "id" IN (
      SELECT "id" FROM "email_outbox"
      WHERE "status" = 'QUEUED' AND "scheduledAt" <= now()
      ORDER BY "scheduledAt" ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `)
  return rows.map(r => r.id)
}

/** Returns rows stranded in SENDING by a crash back to the queue. */
async function requeueOrphans(): Promise<number> {
  const cutoff = new Date(Date.now() - ORPHAN_MINUTES * 60_000)
  const { count } = await prisma.emailOutbox.updateMany({
    where: { status: 'SENDING', createdAt: { lt: cutoff } },
    data: { status: 'QUEUED' },
  })
  if (count > 0) logger.warn({ count }, 'Requeued orphaned email rows')
  return count
}

/**
 * Is this failure worth retrying?
 *
 * A rejected recipient or a malformed address will fail identically forever, so
 * retrying wastes five attempts and delays the FAILED state an admin needs to
 * see. A connection problem or a rate limit will not.
 */
function isPermanentFailure(err: unknown): boolean {
  const code = (err as { responseCode?: number; code?: string } | null)?.responseCode
  if (typeof code === 'number' && code >= 500 && code < 600) return true

  const message = err instanceof Error ? err.message.toLowerCase() : ''
  return (
    message.includes('no recipients') ||
    message.includes('invalid address') ||
    message.includes('mailbox unavailable') ||
    message.includes('user unknown')
  )
}

/** Builds the calendar attachment for templates that carry one. */
function attachmentFor(
  template: string,
  icsMethod: string | null,
  payload: BookingPayload,
  sequence: number,
  series?: { id: string; rrule: string } | null,
): Array<{ filename: string; content: string; contentType: string }> {
  // A reminder deliberately has none: the meeting is already in the calendar.
  if (!icsMethod || template === 'booking_reminder') return []

  /*
   * For a series, the UID belongs to the SERIES and the event carries an
   * RRULE, so a client shows one repeating entry rather than N unrelated
   * meetings. The per-row uid is used only for a standalone booking.
   */
  const uid = series ? `${series.id}@roombook` : payload.icsUid
  const start = series ? (payload.firstOccurrence ?? payload.startsAt) : payload.startsAt

  if (!start || !uid) return []
  const end =
    payload.endsAt ??
    (payload.startsAt && payload.endsAt ? payload.endsAt : null) ??
    new Date(new Date(String(start)).getTime() + 30 * 60_000).toISOString()

  const content = buildIcs({
    uid: String(uid),
    sequence,
    ...(series ? { rrule: series.rrule } : {}),
    method: icsMethod as IcsMethod,
    start: new Date(String(start)),
    end: new Date(String(end)),
    title: String(payload.title ?? 'Meeting'),
    description: payload.description ? String(payload.description) : null,
    location: [payload.room, payload.location, payload.address].filter(Boolean).join(', '),
    url: payload.url ? String(payload.url) : null,
    organizer: {
      email: String(payload.organizerEmail ?? config.MAIL_FROM_ADDRESS),
      name: payload.organizer ? String(payload.organizer) : null,
    },
    timeZone: String(payload.timeZone ?? 'UTC'),
  })

  return [
    {
      filename: 'invite.ics',
      content,
      contentType: `text/calendar; charset=utf-8; method=${icsMethod}`,
    },
  ]
}

async function sendOne(id: string): Promise<'sent' | 'failed' | 'requeued'> {
  const row = await prisma.emailOutbox.findUnique({
    where: { id },
    include: {
      booking: {
        select: {
          icsUid: true,
          icsSequence: true,
          description: true,
          organizer: { select: { email: true, fullName: true } },
        },
      },
    },
  })
  if (!row) return 'failed'

  // A series email carries the RRULE, so the recipient's calendar shows one
  // repeating entry instead of N separate meetings.
  const series = row.seriesId
    ? await prisma.bookingSeries.findUnique({
        where: { id: row.seriesId },
        select: { id: true, rrule: true },
      })
    : null
  const payload: BookingPayload = {
    ...(row.payload as BookingPayload),
    icsUid: row.booking?.icsUid,
    description: row.booking?.description,
    organizerEmail: row.booking?.organizer.email,
  }

  try {
    const rendered = render(row.template, payload, row.subject)

    await getMailer().send({
      to: row.toEmail,
      toName: row.toName,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      attachments: attachmentFor(
        row.template,
        row.icsMethod,
        payload,
        row.booking?.icsSequence ?? 0,
        series,
      ),
      // Replying should reach a person, not a monitored-by-nobody address.
      replyTo: row.booking?.organizer.email,
      // Threads every message about one booking together in the recipient's
      // client, which noticeably reduces inbox noise.
      references: row.bookingId ? `<booking-${row.bookingId}@roombook>` : undefined,
      // Stops out-of-office replies storming back; reminders are bulk.
      precedence: row.template === 'booking_reminder' ? 'bulk' : undefined,
    })

    await prisma.emailOutbox.update({
      where: { id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        attempts: { increment: 1 },
        // Kept so the admin email log can show exactly what was sent.
        bodyHtml: rendered.html,
        bodyText: rendered.text,
        lastError: null,
      },
    })
    return 'sent'
  } catch (err) {
    const attempts = row.attempts + 1
    const permanent = isPermanentFailure(err)
    const giveUp = permanent || attempts >= MAX_ATTEMPTS
    const message = err instanceof Error ? err.message : String(err)

    await prisma.emailOutbox.update({
      where: { id },
      data: {
        status: giveUp ? 'FAILED' : 'QUEUED',
        attempts,
        lastError: permanent ? `Permanent: ${message}` : message,
        ...(giveUp
          ? {}
          : {
              scheduledAt: new Date(
                Date.now() + (BACKOFF_MINUTES[attempts - 1] ?? 360) * 60_000,
              ),
            }),
      },
    })

    logger.warn(
      { id, attempts, permanent, to: maskEmail(row.toEmail), err: message },
      giveUp ? 'Email failed permanently' : 'Email failed; will retry',
    )
    return giveUp ? 'failed' : 'requeued'
  }
}

/** One pass. Exported so tests can drive the worker deterministically. */
export async function processOutbox(): Promise<SendResult> {
  await requeueOrphans()

  const ids = await claimBatch()
  if (ids.length === 0) return { sent: 0, failed: 0, requeued: 0 }

  const result: SendResult = { sent: 0, failed: 0, requeued: 0 }

  // Sequential rather than parallel: a pooled SMTP connection is the
  // bottleneck, and hammering a relay is a good way to get rate limited.
  for (const id of ids) {
    const outcome = await sendOne(id)
    if (outcome === 'sent') result.sent++
    else if (outcome === 'failed') result.failed++
    else result.requeued++
  }

  if (result.sent + result.failed > 0) {
    logger.info(result, 'Outbox processed')
  }
  return result
}

let timer: NodeJS.Timeout | null = null
let running = false

export function startOutboxWorker(): void {
  if (timer) return

  const tick = async () => {
    // Guarded so a slow pass never overlaps itself, which would otherwise
    // double the claim rate under load.
    if (running) return
    running = true
    try {
      await processOutbox()
    } catch (err) {
      logger.error({ err }, 'Outbox worker pass failed')
    } finally {
      running = false
    }
  }

  timer = setInterval(() => void tick(), config.OUTBOX_POLL_MS)
  timer.unref()
  logger.info({ intervalMs: config.OUTBOX_POLL_MS }, 'Outbox worker started')
  void tick()
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer)
  timer = null
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}
