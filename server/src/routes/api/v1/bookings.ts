/**
 * Booking and availability endpoints (docs/05-api-spec.md sections 4 and 5).
 */

import { Router } from 'express'
import { z } from 'zod'

import {
  availabilityQuerySchema,
  cancelBookingSchema,
  createBookingSchema,
  endEarlySchema,
  moveBookingSchema,
  updateBookingSchema,
} from '@roombook/shared'

import { BookingConflictError } from '../../../domain/errors.js'
import { actorOf, requireAuth } from '../../../middleware/auth.js'
import { mutationLimiter } from '../../../middleware/rateLimit.js'
import { validate, validated } from '../../../middleware/validate.js'
import * as availability from '../../../services/AvailabilityService.js'
import * as bookings from '../../../services/BookingService.js'

export const bookingsRouter: Router = Router()
export const availabilityRouter: Router = Router()

bookingsRouter.use(requireAuth)
availabilityRouter.use(requireAuth)

/** Name and email for the audit label and the "moved by" line in emails. */
function metaOf(req: Parameters<Parameters<Router['get']>[1]>[0]) {
  const actor = actorOf(req)
  return { ip: req.ip, actorName: actor.fullName, actorEmail: actor.email }
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const dayQuery = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    locationId: z.string().uuid().optional(),
    minCapacity: z.coerce.number().int().min(1).max(10000).optional(),
    features: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform(v => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).filter(Boolean))),
  })
  .strip()

availabilityRouter.get('/', validate(dayQuery, 'query'), async (req, res, next) => {
  try {
    const q = validated<z.infer<typeof dayQuery>>(req, 'query')
    res.json(await availability.dayAvailability(actorOf(req), q.date, q))
  } catch (err) {
    next(err)
  }
})

const findQuery = z
  .object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    locationId: z.string().uuid().optional(),
    allLocations: z
      .enum(['true', 'false'])
      .optional()
      .transform(v => v === 'true'),
    minCapacity: z.coerce.number().int().min(1).max(10000).optional(),
    features: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform(v => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).filter(Boolean))),
  })
  .strip()

availabilityRouter.get('/find', validate(findQuery, 'query'), async (req, res, next) => {
  try {
    const q = validated<z.infer<typeof findQuery>>(req, 'query')
    const data = await availability.findFreeRooms(
      actorOf(req),
      new Date(q.startsAt),
      new Date(q.endsAt),
      q,
    )
    res.json({ data })
  } catch (err) {
    next(err)
  }
})

const suggestQuery = z
  .object({
    roomId: z.string().uuid(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  })
  .strip()

availabilityRouter.get('/suggestions', validate(suggestQuery, 'query'), async (req, res, next) => {
  try {
    const q = validated<z.infer<typeof suggestQuery>>(req, 'query')
    res.json(
      await availability.suggestions(actorOf(req), q.roomId, new Date(q.startsAt), new Date(q.endsAt)),
    )
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

const listQuery = z
  .object({
    scope: z.enum(['mine', 'all', 'attending']).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    roomId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    organizerId: z.string().uuid().optional(),
    status: z.string().optional(),
    q: z.string().trim().max(120).optional(),
  })
  .strip()

bookingsRouter.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const q = validated<z.infer<typeof listQuery>>(req, 'query')
    const data = await bookings.list(actorOf(req), {
      ...q,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      status: q.status as never,
    })
    res.json({ data })
  } catch (err) {
    next(err)
  }
})

bookingsRouter.get('/:id', async (req, res, next) => {
  try {
    res.json({ data: await bookings.getById(actorOf(req), String(req.params.id)) })
  } catch (err) {
    next(err)
  }
})

/**
 * Creating a booking.
 *
 * On a 409 the response carries alternatives, so the client can render a
 * conflict panel with one-click recovery rather than a dead end (BR-C4).
 */
bookingsRouter.post('/', mutationLimiter, validate(createBookingSchema), async (req, res, next) => {
  try {
    const body = req.body as {
      roomId: string
      title: string
      description?: string
      startsAt: string
      endsAt: string
      isPrivate?: boolean
      attendees?: Array<{ userId?: string; email?: string; displayName?: string }>
      organizerId?: string
    }

    const created = await bookings.create(
      actorOf(req),
      {
        roomId: body.roomId,
        title: body.title,
        description: body.description,
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        isPrivate: body.isPrivate,
        attendees: body.attendees,
        organizerId: body.organizerId,
      },
      metaOf(req),
    )

    res.status(201).json({ data: created })
  } catch (err) {
    next(await withSuggestions(err, req))
  }
})

bookingsRouter.patch('/:id', validate(updateBookingSchema), async (req, res, next) => {
  try {
    const body = req.body as bookings.UpdateBookingInput
    res.json({
      data: await bookings.update(actorOf(req), String(req.params.id), body, metaOf(req)),
    })
  } catch (err) {
    next(err)
  }
})

/** The admin action: move room and/or time, with a mandatory reason (BR-M5). */
bookingsRouter.post('/:id/move', mutationLimiter, validate(moveBookingSchema), async (req, res, next) => {
  try {
    const body = req.body as { roomId?: string; startsAt?: string; endsAt?: string; reason: string }
    const moved = await bookings.move(
      actorOf(req),
      String(req.params.id),
      {
        roomId: body.roomId,
        startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
        endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
        reason: body.reason,
      },
      metaOf(req),
    )
    res.json({ data: moved })
  } catch (err) {
    next(await withSuggestions(err, req))
  }
})

bookingsRouter.post('/:id/cancel', validate(cancelBookingSchema), async (req, res, next) => {
  try {
    const body = req.body as { reason?: string }
    res.json({
      data: await bookings.cancel(actorOf(req), String(req.params.id), body.reason, metaOf(req)),
    })
  } catch (err) {
    next(err)
  }
})

/** D3: release an in-progress booking. Truncates rather than erasing. */
bookingsRouter.post('/:id/end-early', validate(endEarlySchema), async (req, res, next) => {
  try {
    res.json({ data: await bookings.endEarly(actorOf(req), String(req.params.id), metaOf(req)) })
  } catch (err) {
    next(err)
  }
})

/**
 * Attaches recovery options to a conflict.
 *
 * Done here rather than in the service so the service stays free of response
 * shaping, and so a failure to compute suggestions can never turn a clean 409
 * into a 500.
 */
async function withSuggestions(
  err: unknown,
  req: Parameters<Parameters<Router['get']>[1]>[0],
): Promise<unknown> {
  if (!(err instanceof BookingConflictError)) return err

  const body = req.body as { roomId?: string; startsAt?: string; endsAt?: string }
  const roomId = body.roomId
  const startsAt = body.startsAt
  const endsAt = body.endsAt
  if (!roomId || !startsAt || !endsAt) return err

  try {
    const alternatives = await availability.suggestions(
      actorOf(req),
      roomId,
      new Date(startsAt),
      new Date(endsAt),
    )
    return new BookingConflictError(err.details?.conflicts, alternatives)
  } catch {
    return err
  }
}
