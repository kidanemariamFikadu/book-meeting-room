/**
 * Request correlation and logging.
 *
 * Every request gets an ID that appears in each log line it produces and in any
 * error response. When a user reports a problem, that ID is what turns
 * "something went wrong" into a specific line in the log.
 */

import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { pinoHttp } from 'pino-http'

import { config } from '../config.js'

declare module 'express-serve-static-core' {
  interface Request {
    id: string
  }
}

/**
 * Redaction is configured here rather than at each call site, because a secret
 * only has to be logged once to be compromised. Tested by T-158.
 */
const httpLogger = pinoHttp({
  level: config.LOG_LEVEL,
  genReqId: (req, res) => {
    const existing = req.headers['x-request-id']
    const id = typeof existing === 'string' && existing.length <= 64 ? existing : randomUUID()
    res.setHeader('x-request-id', id)
    return id
  },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.body.password',
      'req.body.newPassword',
      'req.body.currentPassword',
      'req.body.token',
      'res.headers["set-cookie"]',
      '*.accessToken',
      '*.refreshToken',
      '*.accessTokenEncrypted',
      '*.refreshTokenEncrypted',
      '*.passwordHash',
      '*.tokenHash',
      '*.syncToken',
    ],
    censor: '[redacted]',
  },
  customLogLevel: (_req, res, err) => {
    if (err) return 'error'
    if (res.statusCode >= 500) return 'error'
    if (res.statusCode >= 400) return 'warn'
    // Health checks every few seconds would otherwise drown the log.
    return res.statusCode === 304 ? 'silent' : 'info'
  },
  autoLogging: {
    ignore: req => req.url === '/healthz' || req.url === '/readyz',
  },
  transport: config.isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
})

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  httpLogger(req, res)
  req.id = String(req.id ?? randomUUID())
  next()
}

export const logger = httpLogger.logger
