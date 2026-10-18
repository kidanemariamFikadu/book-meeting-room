/**
 * Rate limits.
 *
 * Specification: docs/05-api-spec.md section 8.
 *
 * Login throttling is per EMAIL as well as per IP. Per-IP alone is useless
 * against a slow distributed attempt on one account, and per-email alone lets
 * one host spray many accounts. The per-email lockout itself lives in
 * AuthService, since it must persist across restarts.
 */

import rateLimit, { type Options } from 'express-rate-limit'
import type { Request } from 'express'

import { config } from '../config.js'
import { RateLimitError } from '../domain/errors.js'

const shared: Partial<Options> = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Routed through the error hierarchy so the body matches every other error.
  handler: (req, _res, next, options) => {
    next(new RateLimitError(Math.ceil(options.windowMs / 1000)))
  },
  skip: () => config.RATE_LIMIT_DISABLED,
}

/**
 * Keys an IPv6 address by its /64 prefix rather than the full address.
 *
 * A single IPv6 host is routinely assigned a whole /64, so limiting by the full
 * address lets one machine rotate through billions of keys and bypass the limit
 * entirely. IPv4 is used as-is.
 */
function byIp(req: Request): string {
  const ip = req.ip ?? 'unknown'
  if (!ip.includes(':')) return ip
  const groups = ip.split(':')
  // Keep the first four groups (64 bits); an abbreviated address simply yields
  // fewer, which is still a stable key for that host.
  return groups.slice(0, 4).join(':') + '::/64'
}

const bySession = (req: Request) => req.sessionID ?? byIp(req)

export const loginIpLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: byIp,
  skipSuccessfulRequests: true,
})

export const passwordResetLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  keyGenerator: byIp,
})

export const apiLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 300,
  keyGenerator: bySession,
})

export const globalLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 1000,
  keyGenerator: byIp,
})

/** Creation and mutation of bookings, per user (docs/05 section 8). */
export const mutationLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: (req: Request) => req.user?.id ?? bySession(req),
})

/** Display endpoints are unauthenticated by necessity, so cap them per token. */
export const displayLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req: Request) => String(req.params.token ?? byIp(req)),
})
