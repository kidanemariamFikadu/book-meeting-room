/**
 * Serving the built React bundle, and the single-page-app fallback.
 *
 * This is the part of a monolith that is easy to get wrong in a way only
 * production reveals, so it is built in M0 rather than at the end, and the
 * end-to-end tests run against the built artifact (docs/10-testing.md).
 *
 * Specification: docs/09-configuration.md section 3.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express, { type Express } from 'express'

import { config } from './config.js'
import { logger } from './middleware/requestContext.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Resolved by walking up to the repository root, so this works whether the
 * module is running from `server/src` under tsx or `server/dist` after a build.
 */
function resolveClientDist(): string | null {
  for (const up of ['../..', '../../..', '../../../..']) {
    const candidate = path.resolve(here, up, 'client/dist')
    if (existsSync(path.join(candidate, 'index.html'))) return candidate
  }
  return null
}

export function mountStatic(app: Express): void {
  const clientDist = resolveClientDist()

  if (!clientDist) {
    // In development the client is served by Vite on its own port, so this is
    // the normal case rather than an error.
    logger.info(
      config.isDevelopment
        ? 'Client bundle not built - Vite serves the UI in development'
        : 'Client bundle missing - run "npm run build" before starting in production',
    )
    app.get('/', (_req, res) => {
      res.json({
        service: 'roombook-api',
        status: 'running',
        ui: config.isDevelopment ? 'http://localhost:5173' : 'not built',
        health: '/healthz',
      })
    })
    return
  }

  // Vite content-hashes every filename under /assets, so these can be cached
  // indefinitely. A new deploy produces new filenames.
  app.use(
    '/assets',
    express.static(path.join(clientDist, 'assets'), {
      immutable: true,
      maxAge: '1y',
      fallthrough: false,
    }),
  )

  // Other static files (favicon, manifest) are revalidated.
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }))

  /**
   * SPA fallback. Scoped to GET and HEAD, and explicitly NOT applied to /api,
   * so an unknown API path returns a JSON 404 rather than an HTML page — a
   * client parsing `index.html` as JSON is a confusing failure to debug, and it
   * is on the security checklist for exactly that reason.
   */
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(path.join(clientDist, 'index.html'))
  })

  logger.info({ clientDist }, 'Serving client bundle')
}
