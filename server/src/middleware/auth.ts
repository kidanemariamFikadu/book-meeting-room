/**
 * Loading the actor, and gating routes on role.
 *
 * `loadActor` turns a session into the `Actor` that the SHARED `can()` function
 * consumes, so the server enforces exactly the rules the React client renders
 * against — but independently, against the session rather than anything the
 * client sent.
 *
 * Specification: docs/08-security.md section 3.
 */

import type { NextFunction, Request, Response } from 'express'

import { can, isAtLeast, type Action, type Actor, type Role } from '@roombook/shared'

import { prisma } from '../db.js'
import { AuthenticationError, AuthorizationError } from '../domain/errors.js'

export interface SessionUser extends Actor {
  email: string
  fullName: string
  timezone: string | null
  homeLocationId: string | null
  status: string
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser
  }
}

/**
 * Attaches the user when a session exists. Does not reject anonymous requests —
 * that is `requireAuth` — because some routes are legitimately public.
 */
export async function loadActor(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId
  if (!userId) return next()

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        organizationId: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        timezone: true,
        homeLocationId: true,
        locationAccess: { select: { locationId: true } },
      },
    })

    // The row is re-read on every request rather than cached in the session, so
    // a deactivation or a role change takes effect on the very next request
    // rather than whenever the session happens to expire (BR-U4, T-96).
    if (!user || user.status !== 'ACTIVE') {
      req.session.destroy(() => undefined)
      return next()
    }

    req.user = {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      fullName: user.fullName,
      role: user.role as Role,
      status: user.status,
      timezone: user.timezone,
      homeLocationId: user.homeLocationId,
      adminLocationIds: user.locationAccess.map(a => a.locationId),
      // Reserved for the standing "all locations, including future ones" grant
      // (docs/14 section 7). Modelled as an empty grant list for now, which the
      // shared `administersLocation` already treats as organization-wide.
      administersAllLocations: false,
    }
    next()
  } catch (err) {
    next(err)
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(new AuthenticationError())
  next()
}

/** Gate on a minimum role. Cumulative: OWNER satisfies ADMIN. */
export function requireRole(minimum: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new AuthenticationError())
    if (!isAtLeast(req.user.role, minimum)) {
      return next(new AuthorizationError())
    }
    next()
  }
}

/**
 * Gate on a specific action that needs no subject (creation, listing).
 * Actions concerning a particular booking or room are checked inside the
 * service, where the subject has been loaded and its organization verified.
 */
export function requirePermission(action: Action) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new AuthenticationError())
    if (!can(req.user, action, { organizationId: req.user.organizationId })) {
      return next(new AuthorizationError())
    }
    next()
  }
}

/** The actor, or a 401. Use inside handlers that sit behind `requireAuth`. */
export function actorOf(req: Request): SessionUser {
  if (!req.user) throw new AuthenticationError()
  return req.user
}
