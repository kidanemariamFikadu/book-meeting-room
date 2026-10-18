/**
 * Approval endpoints (docs/15-approvals.md).
 */

import { Router } from 'express'

import { approveBookingSchema, rejectBookingSchema } from '@roombook/shared'

import { actorOf, requireAuth, requireRole } from '../../../middleware/auth.js'
import { validate } from '../../../middleware/validate.js'
import * as approvals from '../../../services/ApprovalService.js'
import { processApprovalExpiry } from '../../../workers/ApprovalExpiryWorker.js'

export const approvalsRouter: Router = Router()

approvalsRouter.use(requireAuth)

/** The queue, scoped to the locations this admin administers (BR-L1). */
approvalsRouter.get('/', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const locationId = typeof req.query.locationId === 'string' ? req.query.locationId : undefined
    res.json({ data: await approvals.pendingQueue(actorOf(req), locationId) })
  } catch (err) {
    next(err)
  }
})

approvalsRouter.post(
  '/:id/approve',
  requireRole('ADMIN'),
  validate(approveBookingSchema),
  async (req, res, next) => {
    try {
      const actor = actorOf(req)
      const body = req.body as { moveToRoomId?: string; note?: string }
      res.json({
        data: await approvals.approve(actor, String(req.params.id), body, {
          ip: req.ip,
          actorName: actor.fullName,
          actorEmail: actor.email,
        }),
      })
    } catch (err) {
      next(err)
    }
  },
)

approvalsRouter.post(
  '/:id/reject',
  requireRole('ADMIN'),
  validate(rejectBookingSchema),
  async (req, res, next) => {
    try {
      const actor = actorOf(req)
      const { reason } = req.body as { reason: string }
      res.json({
        data: await approvals.reject(actor, String(req.params.id), reason, {
          ip: req.ip,
          actorName: actor.fullName,
          actorEmail: actor.email,
        }),
      })
    } catch (err) {
      next(err)
    }
  },
)

/** A requester withdrawing their own request. Needs no admin role (BR-A5). */
approvalsRouter.post('/:id/withdraw', async (req, res, next) => {
  try {
    const actor = actorOf(req)
    res.json({
      data: await approvals.withdraw(actor, String(req.params.id), {
        ip: req.ip,
        actorName: actor.fullName,
        actorEmail: actor.email,
      }),
    })
  } catch (err) {
    next(err)
  }
})

/** Runs the expiry pass immediately, for tests and for an admin checking. */
approvalsRouter.post('/run-expiry', requireRole('ADMIN'), async (_req, res, next) => {
  try {
    res.json(await processApprovalExpiry())
  } catch (err) {
    next(err)
  }
})
