/**
 * Admin endpoints: the email log, and the development mailbox.
 *
 * The email log exists so an admin can answer "did Bob actually get told?"
 * without access to a mail server. That question comes up on the first day of
 * real use, which is why it is part of the product rather than an afterthought
 * (US-N6).
 *
 * Specification: docs/05-api-spec.md section 7, docs/06-email-notifications.md section 6.
 */

import { Router } from 'express'
import { z } from 'zod'

import { config } from '../../../config.js'
import { prisma } from '../../../db.js'
import { NotFoundError, StateConflictError } from '../../../domain/errors.js'
import { ConsoleMailer, getMailer } from '../../../mail/Mailer.js'
import { MAX_ATTEMPTS, processOutbox } from '../../../mail/OutboxWorker.js'
import { actorOf, requireAuth, requireRole } from '../../../middleware/auth.js'
import { validate, validated } from '../../../middleware/validate.js'

export const adminRouter: Router = Router()
export const devRouter: Router = Router()

adminRouter.use(requireAuth, requireRole('ADMIN'))

const logQuery = z
  .object({
    status: z.enum(['QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED']).optional(),
    bookingId: z.string().uuid().optional(),
    toEmail: z.string().trim().max(200).optional(),
    template: z.string().trim().max(60).optional(),
    page: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strip()

adminRouter.get('/emails', validate(logQuery, 'query'), async (req, res, next) => {
  try {
    const actor = actorOf(req)
    const q = validated<z.infer<typeof logQuery>>(req, 'query')
    const page = q.page ?? 1
    const perPage = 50

    const where = {
      organizationId: actor.organizationId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.bookingId ? { bookingId: q.bookingId } : {}),
      ...(q.template ? { template: q.template } : {}),
      ...(q.toEmail ? { toEmail: { contains: q.toEmail, mode: 'insensitive' as const } } : {}),
    }

    const [rows, total, counts] = await Promise.all([
      prisma.emailOutbox.findMany({
        where,
        select: {
          id: true,
          template: true,
          toEmail: true,
          toName: true,
          subject: true,
          status: true,
          attempts: true,
          lastError: true,
          scheduledAt: true,
          sentAt: true,
          createdAt: true,
          bookingId: true,
          booking: { select: { title: true, room: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      prisma.emailOutbox.count({ where }),
      // A per-status summary, so the screen leads with "3 failed" rather than
      // making an admin scan a list to find out.
      prisma.emailOutbox.groupBy({
        by: ['status'],
        where: { organizationId: actor.organizationId },
        _count: true,
      }),
    ])

    res.json({
      data: rows,
      meta: {
        page,
        perPage,
        total,
        totalPages: Math.max(1, Math.ceil(total / perPage)),
        counts: Object.fromEntries(counts.map(c => [c.status, c._count])),
        maxAttempts: MAX_ATTEMPTS,
      },
    })
  } catch (err) {
    next(err)
  }
})

/** The rendered bodies, so an admin can see exactly what was sent. */
adminRouter.get('/emails/:id', async (req, res, next) => {
  try {
    const actor = actorOf(req)
    const row = await prisma.emailOutbox.findFirst({
      where: { id: String(req.params.id), organizationId: actor.organizationId },
    })
    if (!row) throw new NotFoundError('That email')
    res.json({ data: row })
  } catch (err) {
    next(err)
  }
})

/**
 * Requeues a failed message.
 *
 * Only FAILED rows: requeueing something already sent would deliver it twice,
 * and a QUEUED row is going to be sent anyway.
 */
adminRouter.post('/emails/:id/resend', async (req, res, next) => {
  try {
    const actor = actorOf(req)
    const row = await prisma.emailOutbox.findFirst({
      where: { id: String(req.params.id), organizationId: actor.organizationId },
      select: { id: true, status: true },
    })
    if (!row) throw new NotFoundError('That email')

    if (row.status !== 'FAILED' && row.status !== 'CANCELLED') {
      throw new StateConflictError(
        row.status === 'SENT'
          ? 'That email was already sent. Resending would deliver it twice.'
          : 'That email is already queued to send.',
      )
    }

    await prisma.emailOutbox.update({
      where: { id: row.id },
      data: { status: 'QUEUED', attempts: 0, lastError: null, scheduledAt: new Date() },
    })

    res.json({ requeued: true })
  } catch (err) {
    next(err)
  }
})

/** Drains the queue immediately rather than waiting for the next tick. */
adminRouter.post('/emails/flush', async (_req, res, next) => {
  try {
    res.json(await processOutbox())
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// Development mailbox (S-21)
// ---------------------------------------------------------------------------

/**
 * Everything the console mailer captured.
 *
 * This is what makes it possible to build and demonstrate the whole
 * notification system with no SMTP credentials at all (D2). Refused outside
 * development, since in production it would expose message bodies.
 */
devRouter.get('/emails', requireAuth, (_req, res, next) => {
  try {
    if (config.isProduction) throw new NotFoundError('That endpoint')

    const mailer = getMailer()
    if (!(mailer instanceof ConsoleMailer)) {
      res.json({
        transport: mailer.name,
        captured: [],
        note:
          mailer.name === 'smtp'
            ? `SMTP is configured, so nothing is captured here. Check your mail catcher, for example Mailpit at http://localhost:8025`
            : 'No captured messages for this transport.',
      })
      return
    }

    res.json({ transport: 'console', captured: mailer.list() })
  } catch (err) {
    next(err)
  }
})
