/**
 * Queues reminders shortly before a meeting starts.
 *
 * Specification: docs/06-email-notifications.md, BR-N6, BR-N7.
 */

import { config } from '../config.js'
import { prisma } from '../db.js'
import { logger } from '../middleware/requestContext.js'

/**
 * A reminder whose moment has passed is DROPPED, not sent late.
 *
 * If the system was down over the window, a reminder arriving after the
 * meeting started is worse than none at all - it tells the recipient
 * something they already know and makes the tool look broken (BR-N7).
 */
const LATE_TOLERANCE_MINUTES = 2

export interface ReminderResult {
  queued: number
  dropped: number
}

export async function processReminders(now = new Date()): Promise<ReminderResult> {
  const settings = await prisma.orgSettings.findMany({
    select: { organizationId: true, reminderLeadMinutes: true },
  })

  let queued = 0
  let dropped = 0

  for (const org of settings) {
    const lead = org.reminderLeadMinutes
    if (lead <= 0) continue

    const windowStart = new Date(now.getTime() - LATE_TOLERANCE_MINUTES * 60_000)
    const windowEnd = new Date(now.getTime() + lead * 60_000)

    const due = await prisma.booking.findMany({
      where: {
        organizationId: org.organizationId,
        // Only a confirmed meeting is worth reminding about: a pending request
        // may never happen, and a cancelled one must never remind (BR-N6).
        status: 'CONFIRMED',
        startsAt: { gt: windowStart, lte: windowEnd },
        // One reminder per booking, whatever its state.
        emails: { none: { template: 'booking_reminder' } },
      },
      select: {
        id: true,
        organizationId: true,
        title: true,
        startsAt: true,
        endsAt: true,
        organizerId: true,
        organizer: {
          select: { email: true, fullName: true, emailOptOutReminders: true },
        },
        room: {
          select: {
            name: true,
            location: { select: { name: true, timezone: true, address: true } },
          },
        },
      },
      take: 200,
    })

    for (const booking of due) {
      // Reminders are the one thing a user may mute; cancellations and moves
      // are not optional (BR-N8).
      if (booking.organizer.emailOptOutReminders) {
        dropped++
        continue
      }

      const minutesUntil = Math.max(
        1,
        Math.round((booking.startsAt.getTime() - now.getTime()) / 60_000),
      )

      await prisma.emailOutbox.create({
        data: {
          organizationId: booking.organizationId,
          bookingId: booking.id,
          template: 'booking_reminder',
          toEmail: booking.organizer.email,
          toName: booking.organizer.fullName,
          subject: `Starting in ${minutesUntil} minutes: ${booking.title} - ${booking.room.name}`,
          payload: {
            bookingId: booking.id,
            title: booking.title,
            room: booking.room.name,
            location: booking.room.location.name,
            address: booking.room.location.address,
            timeZone: booking.room.location.timezone,
            startsAt: booking.startsAt.toISOString(),
            endsAt: booking.endsAt.toISOString(),
            organizer: booking.organizer.fullName,
            minutesUntil,
            url: `${config.APP_URL}/bookings/${booking.id}`,
          },
        },
      })
      queued++
    }
  }

  if (queued > 0 || dropped > 0) logger.info({ queued, dropped }, 'Reminders processed')
  return { queued, dropped }
}

let timer: NodeJS.Timeout | null = null
let running = false

export function startReminderWorker(): void {
  if (timer) return

  const tick = async () => {
    if (running) return
    running = true
    try {
      await processReminders()
    } catch (err) {
      logger.error({ err }, 'Reminder worker pass failed')
    } finally {
      running = false
    }
  }

  timer = setInterval(() => void tick(), config.REMINDER_POLL_MS)
  timer.unref()
  logger.info({ intervalMs: config.REMINDER_POLL_MS }, 'Reminder worker started')
}

export function stopReminderWorker(): void {
  if (timer) clearInterval(timer)
  timer = null
}
