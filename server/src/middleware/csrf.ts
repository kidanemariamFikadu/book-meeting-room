/**
 * CSRF protection: signed double-submit token.
 *
 * SameSite=Lax already blocks cross-site POSTs in current browsers, but it is
 * one mechanism and it is the browser's, not ours. This is the second.
 *
 * The token is an HMAC of a per-session secret, so it cannot be forged without
 * the server key, and it is bound to the session so a token minted for one
 * user is useless to another.
 *
 * Specification: docs/08-security.md section 5, docs/05-api-spec.md section 1.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

import { config } from '../config.js'
import { CsrfError } from '../domain/errors.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Paths exempt from CSRF, each for a specific reason:
 *  - login and the token-bearing auth endpoints have no session yet, and are
 *    instead protected by rate limiting and by their own single-use tokens;
 *  - provider webhooks are machine-to-machine with their own authenticity
 *    checks, and a browser cannot be tricked into producing a valid one.
 */
const EXEMPT = [
  '/api/v1/auth/login',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/accept-invite',
  '/api/v1/webhooks/',
]

function sign(secret: string): string {
  return createHmac('sha256', config.SESSION_SECRET).update(secret).digest('base64url')
}

/** Mints the token for this session, creating the secret on first use. */
export function issueCsrfToken(req: Request): string {
  req.session.csrfSecret ??= randomBytes(32).toString('base64url')
  return sign(req.session.csrfSecret)
}

export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next()

  // Matched against the FULL path, not req.path: inside a mounted router the
  // latter is relative to the mount point, so absolute patterns never match and
  // every exemption silently fails.
  const fullPath = (req.originalUrl.split('?')[0] ?? req.path).replace(/\/+$/, '')
  if (EXEMPT.some(p => fullPath === p.replace(/\/$/, '') || fullPath.startsWith(p))) {
    return next()
  }

  const secret = req.session.csrfSecret
  const provided = req.get('x-csrf-token') ?? (req.body as { _csrf?: unknown } | undefined)?._csrf

  if (!secret || typeof provided !== 'string' || provided.length === 0) {
    return next(new CsrfError())
  }

  const expected = Buffer.from(sign(secret))
  const actual = Buffer.from(provided)

  // Compare in constant time, and only after a length check — timingSafeEqual
  // throws on a length mismatch rather than returning false.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return next(new CsrfError())
  }

  next()
}
