/**
 * Room endpoints — runtime CRUD for owners and admins
 * (docs/05-api-spec.md section 3).
 */

import { Router } from 'express'
import { z } from 'zod'

import { createFeatureSchema, createRoomSchema, updateRoomSchema } from '@roombook/shared'

import { actorOf, requireAuth } from '../../../middleware/auth.js'
import { validate, validated } from '../../../middleware/validate.js'
import * as rooms from '../../../services/RoomService.js'

export const roomsRouter: Router = Router()

roomsRouter.use(requireAuth)

const listQuery = z
  .object({
    locationId: z.string().uuid().optional(),
    minCapacity: z.coerce.number().int().min(1).max(10000).optional(),
    // Repeatable query parameter or a comma-separated list, since both forms
    // are natural to write by hand and from a client.
    features: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform(v =>
        v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).filter(Boolean),
      ),
    includeInactive: z
      .enum(['true', 'false'])
      .optional()
      .transform(v => v === 'true'),
    q: z.string().trim().max(120).optional(),
  })
  .strip()

roomsRouter.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const filters = validated<z.infer<typeof listQuery>>(req, 'query')
    const actor = actorOf(req)
    const data = await rooms.list(actor, {
      ...filters,
      // Only admins may see deactivated rooms; for everyone else the flag is
      // ignored rather than rejected, since it changes nothing they can do.
      includeInactive: filters.includeInactive && actor.role !== 'EMPLOYEE',
    })

    res.json({
      data: data.map(r => ({
        id: r.id,
        name: r.name,
        capacity: r.capacity,
        floor: r.floor,
        description: r.description,
        colour: r.colour,
        isActive: r.isActive,
        requiresApproval: r.requiresApproval,
        location: r.location,
        features: r.features.map(f => ({ id: f.feature.id, name: f.feature.name, icon: f.feature.icon })),
        hours: r.hours,
        approver: r.approver,
        limits: {
          minBookingMinutes: r.minBookingMinutes,
          maxBookingMinutes: r.maxBookingMinutes,
          maxAdvanceDays: r.maxAdvanceDays,
          minNoticeMinutes: r.minNoticeMinutes,
        },
      })),
    })
  } catch (err) {
    next(err)
  }
})

// Declared before '/:id' so the literal path is not captured as an id.
roomsRouter.get('/features', async (req, res, next) => {
  try {
    res.json({ data: await rooms.listFeatures(actorOf(req)) })
  } catch (err) {
    next(err)
  }
})

roomsRouter.post('/features', validate(createFeatureSchema), async (req, res, next) => {
  try {
    const created = await rooms.createFeature(
      actorOf(req),
      req.body as { name: string; icon?: string; sortOrder?: number },
    )
    res.status(201).json({ data: created })
  } catch (err) {
    next(err)
  }
})

roomsRouter.delete('/features/:id', async (req, res, next) => {
  try {
    res.json(await rooms.removeFeature(actorOf(req), String(req.params.id)))
  } catch (err) {
    next(err)
  }
})

roomsRouter.get('/:id', async (req, res, next) => {
  try {
    res.json({ data: await rooms.get(actorOf(req), String(req.params.id)) })
  } catch (err) {
    next(err)
  }
})

roomsRouter.post('/', validate(createRoomSchema), async (req, res, next) => {
  try {
    const created = await rooms.create(actorOf(req), req.body as rooms.RoomInput, req.ip)
    res.status(201).json({ data: created })
  } catch (err) {
    next(err)
  }
})

roomsRouter.patch('/:id', validate(updateRoomSchema), async (req, res, next) => {
  try {
    const updated = await rooms.update(
      actorOf(req),
      String(req.params.id),
      req.body as Partial<rooms.RoomInput>,
      req.ip,
    )
    res.json({ data: updated })
  } catch (err) {
    next(err)
  }
})

const forceBody = z.object({ force: z.boolean().default(false) }).strict()

roomsRouter.post('/:id/deactivate', validate(forceBody), async (req, res, next) => {
  try {
    const { force } = req.body as { force: boolean }
    const updated = await rooms.setActive(actorOf(req), String(req.params.id), false, force, req.ip)
    res.json({ data: updated })
  } catch (err) {
    next(err)
  }
})

roomsRouter.post('/:id/activate', async (req, res, next) => {
  try {
    const updated = await rooms.setActive(actorOf(req), String(req.params.id), true, false, req.ip)
    res.json({ data: updated })
  } catch (err) {
    next(err)
  }
})

/**
 * Deletes a room. Refused with 409 if any booking has ever referenced it,
 * because removing it would orphan that history; the message points the admin
 * at deactivation, which achieves the same visible result (BR-R3).
 */
roomsRouter.delete('/:id', async (req, res, next) => {
  try {
    res.json(await rooms.remove(actorOf(req), String(req.params.id), req.ip))
  } catch (err) {
    next(err)
  }
})
