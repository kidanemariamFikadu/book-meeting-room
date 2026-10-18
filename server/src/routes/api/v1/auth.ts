/**
 * Authentication endpoints (docs/05-api-spec.md section 2).
 */

import { Router, type Request } from 'express'

import {
  acceptInviteSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
} from '@roombook/shared'

import * as auth from '../../../services/AuthService.js'
import { actorOf, requireAuth } from '../../../middleware/auth.js'
import { issueCsrfToken } from '../../../middleware/csrf.js'
import { loginIpLimiter, passwordResetLimiter } from '../../../middleware/rateLimit.js'
import { validate } from '../../../middleware/validate.js'

export const authRouter: Router = Router()

/**
 * Logs a user in and rotates the session identifier.
 *
 * Regenerating the session is what prevents session fixation: a value planted
 * before login cannot survive it (T-94).
 */
function establishSession(req: Request, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err)
      req.session.userId = userId
      // A fresh CSRF secret per session, so a token minted before login is
      // useless afterwards.
      issueCsrfToken(req)
      req.session.save(saveErr => (saveErr ? reject(saveErr) : resolve()))
    })
  })
}

authRouter.get('/csrf', (req, res) => {
  res.json({ csrfToken: issueCsrfToken(req) })
})

authRouter.post('/login', loginIpLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body as { email: string; password: string }
    const result = await auth.login(email, password, req.ip)
    await establishSession(req, result.userId)

    const me = await auth.describeUser(result.userId)
    res.json({ user: me })
  } catch (err) {
    next(err)
  }
})

authRouter.post('/logout', async (req, res, next) => {
  try {
    await new Promise<void>((resolve, reject) => {
      req.session.destroy(err => (err ? reject(err) : resolve()))
    })
    res.clearCookie('rb.sid', { path: '/' })
    res.clearCookie('__Host-rb.sid', { path: '/' })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

/** Who am I, plus a CSRF token so the SPA can boot in one round trip. */
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const actor = actorOf(req)
    res.json({
      user: await auth.describeUser(actor.id),
      csrfToken: issueCsrfToken(req),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * Always 202, whether or not the address exists, so the endpoint cannot be used
 * to discover who has an account.
 */
authRouter.post(
  '/forgot-password',
  passwordResetLimiter,
  validate(forgotPasswordSchema),
  async (req, res, next) => {
    try {
      await auth.requestPasswordReset((req.body as { email: string }).email)
      res.status(202).json({ status: 'accepted' })
    } catch (err) {
      next(err)
    }
  },
)

authRouter.post(
  '/reset-password',
  passwordResetLimiter,
  validate(resetPasswordSchema),
  async (req, res, next) => {
    try {
      const { token, password } = req.body as { token: string; password: string }
      const result = await auth.resetPassword(token, password)
      // Signed in straight away: the user has just proved control of the
      // mailbox and chosen a password, so a second login form adds nothing.
      await establishSession(req, result.userId)
      res.json({ user: await auth.describeUser(result.userId) })
    } catch (err) {
      next(err)
    }
  },
)

authRouter.post(
  '/accept-invite',
  passwordResetLimiter,
  validate(acceptInviteSchema),
  async (req, res, next) => {
    try {
      const { token, fullName, password } = req.body as {
        token: string
        fullName: string
        password: string
      }
      const result = await auth.acceptInvitation(token, fullName, password)
      await establishSession(req, result.userId)
      res.status(201).json({ user: await auth.describeUser(result.userId) })
    } catch (err) {
      next(err)
    }
  },
)
