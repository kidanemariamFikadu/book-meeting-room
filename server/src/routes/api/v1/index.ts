/**
 * API v1 router.
 *
 * Feature routers are mounted here as each milestone lands. Breaking changes
 * mean /api/v2; the version is never dropped (docs/05-api-spec.md section 1).
 */

import { Router } from 'express'

import { config } from '../../../config.js'

export const apiRouter: Router = Router()

/**
 * Describes what this API is and what it currently exposes. Useful during
 * M0-M2 when most routers do not exist yet, and harmless afterwards.
 */
apiRouter.get('/', (_req, res) => {
  res.json({
    name: 'RoomBook API',
    version: 'v1',
    milestone: 'M0 - foundations',
    docs: 'docs/05-api-spec.md',
    calendarSync: config.CALENDAR_SYNC_ENABLED ? 'enabled' : 'disabled',
    routers: {
      auth: 'M1',
      users: 'M1',
      rooms: 'M2',
      locations: 'M3b',
      availability: 'M3',
      bookings: 'M3',
      series: 'M4b',
      calendar: 'M4c',
      admin: 'M2',
    },
  })
})

// Mounted in later milestones:
//   apiRouter.use('/auth', authRouter)            M1
//   apiRouter.use('/users', usersRouter)          M1
//   apiRouter.use('/rooms', roomsRouter)          M2
//   apiRouter.use('/locations', locationsRouter)  M3b
//   apiRouter.use('/availability', availability)  M3
//   apiRouter.use('/bookings', bookingsRouter)    M3
//   apiRouter.use('/series', seriesRouter)        M4b
//   apiRouter.use('/calendar', calendarRouter)    M4c
//   apiRouter.use('/admin', adminRouter)          M2
