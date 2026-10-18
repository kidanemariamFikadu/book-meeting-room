/**
 * Location endpoints — runtime CRUD for the owner (docs/05-api-spec.md §5d).
 */

import { Router } from 'express'
import { z } from 'zod'

import { createLocationSchema, holidaySchema, updateLocationSchema } from '@roombook/shared'

import { actorOf, requireAuth } from '../../../middleware/auth.js'
import { validate } from '../../../middleware/validate.js'
import * as locations from '../../../services/LocationService.js'

export const locationsRouter: Router = Router()

locationsRouter.use(requireAuth)

/**
 * Every authenticated user can list locations: they need the switcher in order
 * to book anywhere (BR-L5). Inactive ones are shown to admins only.
 */
locationsRouter.get('/', async (req, res, next) => {
  try {
    const actor = actorOf(req)
    const includeInactive =
      req.query.includeInactive === 'true' && actor.role !== 'EMPLOYEE'
    const rows = await locations.list(actor, includeInactive)

    res.json({
      data: rows.map(l => ({
        id: l.id,
        name: l.name,
        code: l.code,
        address: l.address,
        timezone: l.timezone,
        country: l.country,
        isActive: l.isActive,
        sortOrder: l.sortOrder,
        roomCount: l._count.rooms,
        // The switcher shows each site's current local time, so a user can see
        // at a glance that London is three hours behind (docs/14 section 7).
        currentLocalTime: new Intl.DateTimeFormat('en-GB', {
          timeZone: l.timezone,
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date()),
        businessHoursStart: l.businessHoursStart,
        businessHoursEnd: l.businessHoursEnd,
        businessDays: l.businessDays,
      })),
    })
  } catch (err) {
    next(err)
  }
})

locationsRouter.get('/:id', async (req, res, next) => {
  try {
    res.json({ data: await locations.get(actorOf(req), String(req.params.id)) })
  } catch (err) {
    next(err)
  }
})

locationsRouter.post('/', validate(createLocationSchema), async (req, res, next) => {
  try {
    const created = await locations.create(
      actorOf(req),
      req.body as locations.LocationInput,
      req.ip,
    )
    res.status(201).json({ data: created })
  } catch (err) {
    next(err)
  }
})

locationsRouter.patch('/:id', validate(updateLocationSchema), async (req, res, next) => {
  try {
    const updated = await locations.update(
      actorOf(req),
      String(req.params.id),
      req.body as Partial<locations.LocationInput>,
      req.ip,
    )
    res.json({ data: updated })
  } catch (err) {
    next(err)
  }
})

locationsRouter.post('/:id/deactivate', async (req, res, next) => {
  try {
    const result = await locations.setActive(actorOf(req), String(req.params.id), false, req.ip)
    res.json({ data: result.location, futureBookings: result.futureBookings })
  } catch (err) {
    next(err)
  }
})

locationsRouter.post('/:id/activate', async (req, res, next) => {
  try {
    const result = await locations.setActive(actorOf(req), String(req.params.id), true, req.ip)
    res.json({ data: result.location })
  } catch (err) {
    next(err)
  }
})

/**
 * Deletes a location. Refused with 409 when rooms or users still reference it,
 * with a message pointing at deactivation instead.
 */
locationsRouter.delete('/:id', async (req, res, next) => {
  try {
    res.json(await locations.remove(actorOf(req), String(req.params.id), req.ip))
  } catch (err) {
    next(err)
  }
})

locationsRouter.get('/:id/holidays', async (req, res, next) => {
  try {
    const location = await locations.get(actorOf(req), String(req.params.id))
    res.json({ data: location.holidays })
  } catch (err) {
    next(err)
  }
})

locationsRouter.put(
  '/:id/holidays',
  validate(z.object({ holidays: z.array(holidaySchema).max(400) }).strict()),
  async (req, res, next) => {
    try {
      const { holidays } = req.body as { holidays: Array<{ date: string; name: string }> }
      res.json({
        data: await locations.setHolidays(actorOf(req), String(req.params.id), holidays, req.ip),
      })
    } catch (err) {
      next(err)
    }
  },
)
