/**
 * User and account endpoints (docs/05-api-spec.md section 6).
 */

import { Router } from 'express'
import { z } from 'zod'

import {
  changePasswordSchema,
  inviteUserSchema,
  updateOwnProfileSchema,
  updateUserSchema,
} from '@roombook/shared'

import { prisma } from '../../../db.js'
import { NotFoundError } from '../../../domain/errors.js'
import { actorOf, requireAuth } from '../../../middleware/auth.js'
import { validate } from '../../../middleware/validate.js'
import * as auth from '../../../services/AuthService.js'
import * as users from '../../../services/UserService.js'

export const usersRouter: Router = Router()
export const accountRouter: Router = Router()

usersRouter.use(requireAuth)
accountRouter.use(requireAuth)

/** The staff directory, used by the attendee picker. */
usersRouter.get('/', async (req, res, next) => {
  try {
    const actor = actorOf(req)
    res.json({
      data: await users.list(actor, { includeDisabled: req.query.includeDisabled === 'true' }),
    })
  } catch (err) {
    next(err)
  }
})

usersRouter.get('/:id', async (req, res, next) => {
  try {
    res.json({ data: await users.get(actorOf(req), String(req.params.id)) })
  } catch (err) {
    next(err)
  }
})

usersRouter.post('/invite', validate(inviteUserSchema), async (req, res, next) => {
  try {
    const created = await users.invite(actorOf(req), req.body as users.InviteInput, req.ip)
    res.status(201).json({ data: created })
  } catch (err) {
    next(err)
  }
})

usersRouter.post('/:id/resend-invite', async (req, res, next) => {
  try {
    res.json(await users.resendInvitation(actorOf(req), String(req.params.id)))
  } catch (err) {
    next(err)
  }
})

usersRouter.patch('/:id', validate(updateUserSchema), async (req, res, next) => {
  try {
    const updated = await users.update(
      actorOf(req),
      String(req.params.id),
      req.body as users.UpdateUserInput,
      req.ip,
    )
    res.json({ data: updated })
  } catch (err) {
    next(err)
  }
})

const forceBody = z.object({ force: z.boolean().default(false) }).strict()

usersRouter.post('/:id/deactivate', validate(forceBody), async (req, res, next) => {
  try {
    const { force } = req.body as { force: boolean }
    const updated = await users.setStatus(
      actorOf(req),
      String(req.params.id),
      'DISABLED',
      force,
      req.ip,
    )
    res.json({ data: updated })
  } catch (err) {
    next(err)
  }
})

usersRouter.post('/:id/activate', async (req, res, next) => {
  try {
    const updated = await users.setStatus(
      actorOf(req),
      String(req.params.id),
      'ACTIVE',
      false,
      req.ip,
    )
    res.json({ data: updated })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// Own account
// ---------------------------------------------------------------------------

accountRouter.patch('/', validate(updateOwnProfileSchema), async (req, res, next) => {
  try {
    const actor = actorOf(req)
    const updated = await users.update(
      actor,
      actor.id,
      req.body as users.UpdateUserInput,
      req.ip,
    )
    res.json({ data: updated })
  } catch (err) {
    next(err)
  }
})

/**
 * Changing a password destroys every OTHER session for this user, keeping the
 * current one so the person is not signed out of the device they are using.
 */
accountRouter.patch('/password', validate(changePasswordSchema), async (req, res, next) => {
  try {
    const actor = actorOf(req)
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string
      newPassword: string
    }
    await auth.changeOwnPassword(actor.id, currentPassword, newPassword, req.sessionID)
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

/** Lets a user see and revoke their own sessions on other devices. */
accountRouter.get('/sessions', async (req, res, next) => {
  try {
    const actor = actorOf(req)
    const rows = await prisma.session.findMany({
      where: { userId: actor.id, expiresAt: { gt: new Date() } },
      select: { id: true, ip: true, userAgent: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })
    res.json({
      data: rows.map(s => ({
        // The raw session id is a live credential, so only a prefix is exposed.
        id: s.id.slice(0, 8),
        current: s.id === req.sessionID,
        ip: s.ip,
        userAgent: s.userAgent,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
      })),
    })
  } catch (err) {
    next(err)
  }
})

accountRouter.delete('/sessions/:prefix', async (req, res, next) => {
  try {
    const actor = actorOf(req)
    const prefix = String(req.params.prefix)
    const target = await prisma.session.findFirst({
      where: { userId: actor.id, id: { startsWith: prefix } },
      select: { id: true },
    })
    if (!target) throw new NotFoundError('That session')
    await prisma.session.delete({ where: { id: target.id } })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})
