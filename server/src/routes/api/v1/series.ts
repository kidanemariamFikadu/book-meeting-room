/**
 * Recurring series endpoints (docs/05-api-spec.md section 5b).
 */

import { Router } from 'express'
import { z } from 'zod'

import { EDIT_SCOPES, previewSeriesSchema, recurrenceInput } from '@roombook/shared'

import { actorOf, requireAuth } from '../../../middleware/auth.js'
import { mutationLimiter } from '../../../middleware/rateLimit.js'
import { validate } from '../../../middleware/validate.js'
import * as series from '../../../services/SeriesService.js'
import { rollHorizon } from '../../../services/SeriesService.js'

export const seriesRouter: Router = Router()

seriesRouter.use(requireAuth)

function metaOf(req: Parameters<Parameters<Router['get']>[1]>[0]) {
  const actor = actorOf(req)
  return { ip: req.ip, actorName: actor.fullName, actorEmail: actor.email }
}

const toInput = (body: z.infer<typeof previewSeriesSchema>): series.SeriesInput => ({
  roomId: body.roomId,
  title: 'title' in body ? String((body as { title?: string }).title ?? 'Meeting') : 'Meeting',
  startsAtLocal: body.startsAtLocal,
  durationMinutes: body.durationMinutes,
  recurrence: body.recurrence as series.SeriesInput['recurrence'],
})

/**
 * The dry run.
 *
 * Read-only and separate from creation on purpose: the user sees exactly which
 * dates clash and decides, rather than discovering afterwards that a series
 * quietly missed three weeks (docs/12 section 4).
 */
seriesRouter.post('/preview', validate(previewSeriesSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof previewSeriesSchema>
    res.json({ data: await series.preview(actorOf(req), toInput(body)) })
  } catch (err) {
    next(err)
  }
})

const createSchema = previewSeriesSchema
  .extend({
    title: z.string().trim().min(1, 'A title is required').max(200),
    description: z.string().trim().max(5000).optional(),
    isPrivate: z.boolean().default(false),
    organizerId: z.string().uuid().optional(),
    conflictStrategy: z.enum(['SKIP', 'FAIL']).default('SKIP'),
  })
  .strict()

seriesRouter.post('/', mutationLimiter, validate(createSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSchema>
    const result = await series.createSeries(
      actorOf(req),
      {
        roomId: body.roomId,
        title: body.title,
        description: body.description,
        isPrivate: body.isPrivate,
        startsAtLocal: body.startsAtLocal,
        durationMinutes: body.durationMinutes,
        recurrence: body.recurrence as series.SeriesInput['recurrence'],
        organizerId: body.organizerId,
      },
      body.conflictStrategy,
      metaOf(req),
    )
    res.status(201).json({ data: result })
  } catch (err) {
    next(err)
  }
})

seriesRouter.get('/:id', async (req, res, next) => {
  try {
    res.json({ data: await series.getSeries(actorOf(req), String(req.params.id)) })
  } catch (err) {
    next(err)
  }
})

/**
 * Cancels part or all of a series.
 *
 * The scope is required rather than defaulted: guessing between "just this
 * Tuesday" and "the whole standup forever" is not a guess worth making.
 */
const cancelSchema = z
  .object({
    scope: z.enum(EDIT_SCOPES),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()

seriesRouter.post(
  '/occurrences/:bookingId/cancel',
  validate(cancelSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof cancelSchema>
      res.json({
        data: await series.cancelScoped(
          actorOf(req),
          String(req.params.bookingId),
          body.scope,
          body.reason,
          metaOf(req),
        ),
      })
    } catch (err) {
      next(err)
    }
  },
)

/** Rolls the horizon immediately, for tests and for an admin checking. */
seriesRouter.post('/roll-horizon', async (req, res, next) => {
  try {
    const actor = actorOf(req)
    if (actor.role === 'EMPLOYEE') {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Admins only' } })
      return
    }
    res.json(await rollHorizon())
  } catch (err) {
    next(err)
  }
})

void recurrenceInput
