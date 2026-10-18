/**
 * Express application assembly.
 *
 * Exported separately from `index.ts` so integration tests can mount the app
 * with Supertest without opening a port or starting the background workers.
 *
 * Specification: docs/02-architecture.md section 2.
 */

import express, { type Express } from 'express'
import helmet from 'helmet'

import { config } from './config.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { requestContext } from './middleware/requestContext.js'
import { healthRouter } from './routes/health.js'
import { apiRouter } from './routes/api/v1/index.js'
import { mountStatic } from './static.js'

export function createApp(): Express {
  const app = express()

  // Behind a reverse proxy, req.ip must come from X-Forwarded-For or the rate
  // limiter sees every request as originating from the proxy itself.
  app.set('trust proxy', config.TRUST_PROXY)
  app.disable('x-powered-by')
  app.set('etag', 'strong')

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Vite injects inline styles in development; production uses the
          // built stylesheet, so the allowance is scoped to dev only.
          styleSrc: config.isDevelopment ? ["'self'", "'unsafe-inline'"] : ["'self'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      // Nothing in this app is ever legitimately framed, and the CSP above
      // says so too. X-Frame-Options is the fallback for older browsers
      // (docs/08-security.md section 5).
      xFrameOptions: { action: 'deny' },
      // The SPA and the API are same-origin; nothing is embedded cross-origin.
      crossOriginEmbedderPolicy: false,
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  )

  // 100 KB is generous for the largest legitimate payload (a 100-attendee
  // booking) and far below what would make a memory-exhaustion attempt useful.
  app.use(express.json({ limit: '100kb' }))
  app.use(express.urlencoded({ extended: false, limit: '100kb' }))

  app.use(requestContext)

  // Liveness and readiness, before anything that could fail, so an unhealthy
  // dependency still produces a meaningful answer.
  app.use(healthRouter)

  app.use('/api/v1', apiRouter)

  // Display views (D11) and the SPA both live below the API, so a route under
  // /api can never be shadowed by the single-page-app fallback.
  mountStatic(app)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
