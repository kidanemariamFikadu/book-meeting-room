/**
 * Liveness and readiness.
 *
 * The distinction matters to an orchestrator: a failing /healthz means restart
 * the process, while a failing /readyz means stop sending traffic but leave it
 * alone — it may be waiting on the database.
 *
 * Specification: docs/09-configuration.md section 3.
 */

import { Router } from 'express'

import { prisma } from '../db.js'

export const healthRouter: Router = Router()

/** Liveness: the event loop is turning. Must not touch any dependency. */
healthRouter.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) })
})

/** Readiness: the database is reachable and migrations have been applied. */
healthRouter.get('/readyz', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ status: 'ready' })
  } catch (err) {
    req.log?.error({ err }, 'Readiness check failed')
    res.status(503).json({ status: 'not-ready', reason: 'database unreachable' })
  }
})
