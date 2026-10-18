/**
 * Expires approval requests nobody acted on.
 *
 * This worker is what makes "a pending request holds the slot" safe to do at
 * all. Holding a slot indefinitely would let one forgotten request sterilize
 * the best room in the building; expiring it returns the room and tells both
 * sides why (BR-A3, docs/15-approvals.md section 2).
 */

import { config } from '../config.js'
import { prisma } from '../db.js'
import { logger } from '../middleware/requestContext.js'
import * as audit from '../services/AuditService.js'

export interface ExpiryResult {
  expired: number
  reminded: number
}

/** Halfway through the window, nudge the approvers once. */
const REMINDER_AT_FRACTION = 0.5

export async function processApprovalExpiry(now = new Date()): Promise<ExpiryResult> {
  const due = await prisma.booking.findMany({
    where: {
      status: 'PENDING_APPROVAL',
      approvalExpiresAt: { not: null, lte: now },
    },
    include: {
      organizer: { select: { email: true, fullName: true } },
      room: {
        select: {
          name: true,
          locationId: true,
          location: { select: { name: true, timezone: true } },
        },
      },
    },
    take: 100,
  })

  let expired = 0

  for (const booking of due) {
    await prisma.$transaction(async tx => {
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          status: 'REJECTED',
          rejectedAt: now,
          rejectionReason: 'Expired - nobody responded in time',
          approvalExpiresAt: null,
        },
      })

      await audit.record(
        {
          // No actor: this is the system acting, and the audit log should say
          // so rather than attributing it to whoever happened to be signed in.
          actor: { id: null, organizationId: booking.organizationId },
          eventType: 'BOOKING_EXPIRED',
          entityType: 'booking',
          entityId: booking.id,
          locationId: booking.room.locationId,
          before: { status: 'PENDING_APPROVAL' },
          after: { status: 'REJECTED' },
          reason: 'Approval window elapsed',
          source: 'SYSTEM',
        },
        tx,
      )

      await tx.emailOutbox.create({
        data: {
          organizationId: booking.organizationId,
          bookingId: booking.id,
          template: 'approval_expired',
          toEmail: booking.organizer.email,
          toName: booking.organizer.fullName,
          subject: `Expired: ${booking.title} - ${booking.room.name}`,
          payload: {
            bookingId: booking.id,
            title: booking.title,
            room: booking.room.name,
            location: booking.room.location.name,
            timeZone: booking.room.location.timezone,
            startsAt: booking.startsAt.toISOString(),
            endsAt: booking.endsAt.toISOString(),
            organizer: booking.organizer.fullName,
          },
          icsMethod: null,
        },
      })

      // Any reminder queued for a meeting that will now not happen must not
      // fire (BR-M9).
      await tx.emailOutbox.updateMany({
        where: { bookingId: booking.id, template: 'booking_reminder', status: 'QUEUED' },
        data: { status: 'CANCELLED' },
      })
    })
    expired++
  }

  const reminded = await sendMidWindowReminders(now)

  if (expired > 0 || reminded > 0) {
    logger.info({ expired, reminded }, 'Approval expiry processed')
  }
  return { expired, reminded }
}

/**
 * One nudge, halfway through the window.
 *
 * Deliberately once: an approver who ignores two emails will ignore five, and
 * the expiry already prevents the worst outcome.
 */
async function sendMidWindowReminders(now: Date): Promise<number> {
  const pending = await prisma.booking.findMany({
    where: {
      status: 'PENDING_APPROVAL',
      approvalExpiresAt: { not: null, gt: now },
      // Approvers were told once; this is the second and last nudge.
      emails: { none: { template: 'approval_reminder' } },
    },
    include: {
      organizer: { select: { fullName: true } },
      room: { select: { name: true, location: { select: { timezone: true } } } },
      emails: {
        where: { template: 'approval_requested' },
        select: { toEmail: true, toName: true },
      },
    },
    take: 100,
  })

  let reminded = 0

  for (const booking of pending) {
    // Narrowed into a local so the compiler keeps the non-null guarantee
    // across the awaits below.
    const expiresAt = booking.approvalExpiresAt
    if (!expiresAt || booking.emails.length === 0) continue

    const total = expiresAt.getTime() - booking.createdAt.getTime()
    const elapsed = now.getTime() - booking.createdAt.getTime()
    if (total <= 0 || elapsed / total < REMINDER_AT_FRACTION) continue

    const hoursLeft = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 3_600_000))

    await prisma.emailOutbox.createMany({
      data: booking.emails.map(recipient => ({
        organizationId: booking.organizationId,
        bookingId: booking.id,
        template: 'approval_reminder',
        toEmail: recipient.toEmail,
        toName: recipient.toName,
        subject: `Still waiting: ${booking.title} - ${booking.room.name} (${hoursLeft}h left)`,
        payload: {
          bookingId: booking.id,
          title: booking.title,
          room: booking.room.name,
          timeZone: booking.room.location.timezone,
          startsAt: booking.startsAt.toISOString(),
          endsAt: booking.endsAt.toISOString(),
          organizer: booking.organizer.fullName,
          requestedBy: booking.organizer.fullName,
          expiresAt: expiresAt.toISOString(),
          url: `${config.APP_URL}/admin/approvals`,
        },
        icsMethod: null,
      })),
    })
    reminded++
  }

  return reminded
}

let timer: NodeJS.Timeout | null = null
let running = false

export function startApprovalExpiryWorker(): void {
  if (timer) return

  const tick = async () => {
    if (running) return
    running = true
    try {
      await processApprovalExpiry()
    } catch (err) {
      logger.error({ err }, 'Approval expiry pass failed')
    } finally {
      running = false
    }
  }

  // Once a minute: the window is measured in hours, so this is ample, and an
  // expired request freeing its room a minute late harms nobody.
  timer = setInterval(() => void tick(), 60_000)
  timer.unref()
  logger.info('Approval expiry worker started')
}

export function stopApprovalExpiryWorker(): void {
  if (timer) clearInterval(timer)
  timer = null
}
