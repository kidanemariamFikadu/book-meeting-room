/**
 * API v1 router.
 *
 * Breaking changes mean /api/v2; the version is never dropped
 * (docs/05-api-spec.md section 1).
 */

import { Router } from 'express'

import { config } from '../../../config.js'
import { loadActor } from '../../../middleware/auth.js'
import { csrfProtection } from '../../../middleware/csrf.js'
import { apiLimiter } from '../../../middleware/rateLimit.js'
import { sessionMiddleware } from '../../../middleware/session.js'
import { authRouter } from './auth.js'
import { locationsRouter } from './locations.js'
import { roomsRouter } from './rooms.js'
import { accountRouter, usersRouter } from './users.js'

export const apiRouter: Router = Router()

// Order matters: a session must exist before the actor can be loaded, the actor
// before CSRF can be bound to it, and the rate limiter keys on the session.
apiRouter.use(sessionMiddleware)
apiRouter.use(loadActor)
apiRouter.use(csrfProtection)
apiRouter.use(apiLimiter)

apiRouter.get('/', (_req, res) => {
  res.json({
    name: 'RoomBook API',
    version: 'v1',
    milestone: 'M1 - authentication, users, locations, rooms',
    docs: 'docs/05-api-spec.md',
    calendarSync: config.CALENDAR_SYNC_ENABLED ? 'enabled' : 'disabled',
    routers: {
      auth: 'ready',
      users: 'ready',
      account: 'ready',
      locations: 'ready',
      rooms: 'ready',
      availability: 'M3',
      bookings: 'M3',
      series: 'M4b',
      calendar: 'M4c',
    },
  })
})

apiRouter.use('/auth', authRouter)
apiRouter.use('/users', usersRouter)
apiRouter.use('/account', accountRouter)
apiRouter.use('/locations', locationsRouter)
apiRouter.use('/rooms', roomsRouter)

// Mounted in later milestones:
//   apiRouter.use('/availability', availabilityRouter)  M3
//   apiRouter.use('/bookings', bookingsRouter)          M3
//   apiRouter.use('/series', seriesRouter)              M4b
//   apiRouter.use('/calendar', calendarRouter)          M4c
