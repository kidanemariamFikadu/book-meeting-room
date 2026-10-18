/**
 * Server-side sessions, stored in PostgreSQL via Prisma.
 *
 * Sessions are server-side rather than JWTs so that they can be revoked
 * immediately — on password change, role change or deactivation. A JWT cannot
 * be withdrawn before it expires, which makes offboarding unenforceable.
 *
 * Specification: docs/08-security.md section 2.
 */

import { randomBytes } from 'node:crypto'
import session, { Store, type SessionData } from 'express-session'
import type { RequestHandler } from 'express'

import { config } from '../config.js'
import { prisma } from '../db.js'
import { logger } from './requestContext.js'

declare module 'express-session' {
  interface SessionData {
    userId?: string
    csrfSecret?: string
    /** Where the user was heading before being bounced to login. */
    returnTo?: string
  }
}

/**
 * A Prisma-backed store. `connect-pg-simple` would also work, but it manages
 * its own table and pool; reusing Prisma keeps one connection pool and one
 * migration history.
 */
class PrismaSessionStore extends Store {
  override get(
    sid: string,
    callback: (err?: unknown, session?: SessionData | null) => void,
  ): void {
    prisma.session
      .findUnique({ where: { id: sid } })
      .then(row => {
        if (!row) return callback(null, null)
        // Expired rows may still be present until the nightly sweep runs, so
        // expiry is enforced on read as well.
        if (row.expiresAt.getTime() <= Date.now()) {
          return void prisma.session
            .delete({ where: { id: sid } })
            .catch(() => undefined)
            .then(() => callback(null, null))
        }
        callback(null, row.data as unknown as SessionData)
      })
      .catch(err => callback(err))
  }

  override set(sid: string, sess: SessionData, callback?: (err?: unknown) => void): void {
    const expiresAt = sess.cookie?.expires
      ? new Date(sess.cookie.expires)
      : new Date(Date.now() + IDLE_TIMEOUT_MS)

    const data = sess as unknown as object
    prisma.session
      .upsert({
        where: { id: sid },
        create: {
          id: sid,
          userId: sess.userId ?? '',
          data,
          expiresAt,
        },
        update: { data, expiresAt, userId: sess.userId ?? '' },
      })
      .then(() => callback?.())
      .catch(err => {
        // An anonymous session has no userId and the column is required, so a
        // pre-login session is simply not persisted. Nothing is lost: there is
        // no state worth keeping until the user authenticates.
        if (!sess.userId) return callback?.()
        callback?.(err)
      })
  }

  override destroy(sid: string, callback?: (err?: unknown) => void): void {
    prisma.session
      .delete({ where: { id: sid } })
      .then(() => callback?.())
      .catch(() => callback?.()) // already gone is success
  }

  override touch(sid: string, sess: SessionData, callback?: () => void): void {
    const expiresAt = sess.cookie?.expires
      ? new Date(sess.cookie.expires)
      : new Date(Date.now() + IDLE_TIMEOUT_MS)
    prisma.session
      .update({ where: { id: sid }, data: { expiresAt } })
      .then(() => callback?.())
      .catch(() => callback?.())
  }
}

/** 12 hours of inactivity, 30 days absolute (docs/08-security.md section 2). */
const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000
export const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000

export const sessionMiddleware: RequestHandler = session({
  name: config.isProduction ? '__Host-rb.sid' : 'rb.sid',
  secret: config.SESSION_SECRET,
  store: new PrismaSessionStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true, // each request extends the idle window
  // 256 bits of entropy from the OS CSPRNG. The cookie carries only this
  // opaque identifier; no user data is ever placed in it.
  genid: () => randomBytes(32).toString('base64url'),
  proxy: config.TRUST_PROXY > 0,
  cookie: {
    httpOnly: true,
    // Lax rather than Strict: Strict would drop the cookie when a user arrives
    // from an emailed link, which is exactly how invitations are opened.
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: IDLE_TIMEOUT_MS,
    path: '/',
  },
})

/** Removes expired sessions. Called by the nightly cleanup worker in M5. */
export async function sweepExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  })
  if (count > 0) logger.debug({ count }, 'Swept expired sessions')
  return count
}

/**
 * Destroys every session belonging to a user.
 *
 * Called on password change, password reset, role change and deactivation.
 * This is the mechanism that makes "revoke access now" actually mean now
 * (BR-U4, T-95, T-96).
 */
export async function destroyUserSessions(userId: string, exceptSid?: string): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { userId, ...(exceptSid ? { id: { not: exceptSid } } : {}) },
  })
  return count
}
