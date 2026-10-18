/**
 * The authorization matrix — one file, one function.
 *
 * This runs on BOTH sides. The React UI uses it to decide what to render; the
 * Express endpoints use it to decide what to allow. One definition means they
 * cannot disagree.
 *
 * THE ASYMMETRY THAT MATTERS: the client's use of `can()` is cosmetic, the
 * server's use is the control. A user can edit the JavaScript bundle in their
 * own browser; they cannot edit the server. Every endpoint must call this
 * itself, against the session user, and never trust that the client checked.
 *
 * Specification: docs/08-security.md section 4, docs/14-multi-location.md section 3.
 */

import { ROLE_RANK, type BookingStatus, type Role } from './enums.js'

/** The acting user, as little of them as the decision needs. */
export interface Actor {
  id: string
  organizationId: string
  role: Role
  /** Locations this admin is scoped to. EMPTY means organization-wide (D17). */
  adminLocationIds: string[]
  /** A standing grant covering locations created later (docs/14 §7). */
  administersAllLocations: boolean
}

export interface BookingSubject {
  organizationId: string
  organizerId: string
  locationId: string
  status: BookingStatus
  startsAt: Date
  endsAt: Date
  seriesId?: string | null
  attendeeUserIds?: string[]
}

export interface RoomSubject {
  organizationId: string
  locationId: string
}

export type Action =
  | 'room:view'
  | 'room:create'
  | 'room:update'
  | 'room:deactivate'
  | 'room:mapResource'
  | 'closure:manage'
  | 'booking:view'
  | 'booking:viewDetails'
  | 'booking:create'
  | 'booking:createForOther'
  | 'booking:update'
  | 'booking:endEarly'
  | 'booking:cancel'
  | 'booking:move'
  | 'booking:transfer'
  | 'booking:approve'
  | 'series:update'
  | 'series:cancel'
  | 'location:create'
  | 'location:update'
  | 'location:deactivate'
  | 'user:invite'
  | 'user:deactivate'
  | 'user:changeRole'
  | 'user:grantLocationAccess'
  | 'settings:update'
  | 'audit:view'
  | 'email:view'
  | 'report:view'
  | 'display:manage'
  | 'integration:view'

export function isAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum]
}

export const isOwner = (a: Actor) => a.role === 'OWNER'
export const isAdmin = (a: Actor) => isAtLeast(a.role, 'ADMIN')

/**
 * Does this admin have authority over the given location?
 *
 * An ADMIN with no grants is organization-wide, which is what keeps a
 * single-site installation behaving exactly as it did before locations became
 * first-class (BR-L1).
 */
export function administersLocation(actor: Actor, locationId: string): boolean {
  if (actor.role === 'OWNER') return true
  if (actor.role !== 'ADMIN') return false
  if (actor.administersAllLocations) return true
  if (actor.adminLocationIds.length === 0) return true // org-wide admin
  return actor.adminLocationIds.includes(locationId)
}

const hasEnded = (b: BookingSubject, now: Date) => b.endsAt.getTime() <= now.getTime()
const hasStarted = (b: BookingSubject, now: Date) => b.startsAt.getTime() <= now.getTime()
const isInProgress = (b: BookingSubject, now: Date) => hasStarted(b, now) && !hasEnded(b, now)
const isTerminal = (b: BookingSubject) => b.status === 'CANCELLED' || b.status === 'REJECTED'

/**
 * The single entry point for every authorization question.
 *
 * `subject` is required for the actions that concern a specific booking, room
 * or location; omitting it for those returns false rather than throwing, so a
 * missing argument fails closed.
 */
export function can(
  actor: Actor,
  action: Action,
  subject?: BookingSubject | RoomSubject | { organizationId: string; locationId?: string },
  now: Date = new Date(),
): boolean {
  // Nothing crosses an organization boundary, ever. The caller should have
  // returned 404 before reaching here, but fail closed regardless.
  if (subject && subject.organizationId !== actor.organizationId) return false

  const locationId = subject && 'locationId' in subject ? subject.locationId : undefined
  const scoped = locationId === undefined ? isAdmin(actor) : administersLocation(actor, locationId)

  switch (action) {
    // ---- Rooms and places ----
    case 'room:view':
      return true // every authenticated user sees every room (BR-P1)
    case 'room:create':
    case 'room:update':
    case 'room:deactivate':
    case 'room:mapResource':
    case 'closure:manage':
    case 'display:manage':
      return isAdmin(actor) && scoped

    case 'location:create':
    case 'location:update':
    case 'location:deactivate':
      return isOwner(actor) // BR-L3

    // ---- Viewing bookings ----
    case 'booking:view':
      return true // free/busy is visible to all authenticated users (BR-P1)
    case 'booking:viewDetails': {
      const b = subject as BookingSubject | undefined
      if (!b) return false
      if (isAdmin(actor) && scoped) return true // admins always see details (BR-P3)
      if (b.organizerId === actor.id) return true
      if (b.attendeeUserIds?.includes(actor.id)) return true
      return false // a private booking shows only "Busy"
    }

    // ---- Creating ----
    case 'booking:create':
      return true
    case 'booking:createForOther':
      return isAdmin(actor) && scoped // US-M7

    // ---- Changing ----
    case 'booking:update': {
      const b = subject as BookingSubject | undefined
      if (!b || isTerminal(b)) return false
      if (hasEnded(b, now)) return false // BR-M1: ended bookings are immutable
      if (isInProgress(b, now)) return false // only endEarly applies (BR-M2c)
      if (b.organizerId === actor.id) return true
      return isAdmin(actor) && scoped
    }

    /**
     * D3: an organizer may release their own in-progress booking. It is
     * truncated rather than erased, so utilization stays honest (BR-M2a).
     */
    case 'booking:endEarly': {
      const b = subject as BookingSubject | undefined
      if (!b || isTerminal(b)) return false
      if (!isInProgress(b, now)) return false
      if (b.organizerId === actor.id) return true
      return isAdmin(actor) && scoped
    }

    case 'booking:cancel': {
      const b = subject as BookingSubject | undefined
      if (!b || isTerminal(b)) return false
      if (hasEnded(b, now)) return false // BR-M1
      if (hasStarted(b, now)) return false // use endEarly instead
      if (b.organizerId === actor.id) return true
      return isAdmin(actor) && scoped
    }

    /**
     * Moving is admin-only even for your own booking, because a move must be
     * validated against the target room and recorded with a reason (BR-M5).
     * An organizer changing their own time goes through booking:update.
     */
    case 'booking:move':
    case 'booking:transfer': {
      const b = subject as BookingSubject | undefined
      if (!b || isTerminal(b) || hasEnded(b, now)) return false
      return isAdmin(actor) && scoped
    }

    /**
     * A requester may never approve their own request, whatever their role —
     * the entire purpose is a second pair of eyes (BR-A7).
     */
    case 'booking:approve': {
      const b = subject as BookingSubject | undefined
      if (!b || b.status !== 'PENDING_APPROVAL') return false
      if (b.organizerId === actor.id) return false
      return isAdmin(actor) && scoped
    }

    case 'series:update':
    case 'series:cancel': {
      const b = subject as BookingSubject | undefined
      if (!b) return false
      if (b.organizerId === actor.id) return true
      return isAdmin(actor) && scoped
    }

    // ---- People and configuration: owner only ----
    case 'user:invite':
    case 'user:deactivate':
    case 'user:changeRole':
    case 'user:grantLocationAccess':
    case 'settings:update':
      return isOwner(actor) // BR-U6, BR-L4

    // ---- Oversight ----
    case 'audit:view':
    case 'email:view':
    case 'report:view':
    case 'integration:view':
      return isAdmin(actor) && scoped

    default: {
      // Exhaustiveness: adding an Action without handling it fails the build
      // rather than silently granting or denying it.
      const exhaustive: never = action
      return exhaustive
    }
  }
}

/**
 * The permission flags the API embeds in a booking response so the client can
 * render the right controls without re-deriving the rules.
 */
export function bookingPermissions(actor: Actor, booking: BookingSubject, now = new Date()) {
  return {
    canViewDetails: can(actor, 'booking:viewDetails', booking, now),
    canUpdate: can(actor, 'booking:update', booking, now),
    canCancel: can(actor, 'booking:cancel', booking, now),
    canEndEarly: can(actor, 'booking:endEarly', booking, now),
    canMove: can(actor, 'booking:move', booking, now),
    canTransfer: can(actor, 'booking:transfer', booking, now),
    canApprove: can(actor, 'booking:approve', booking, now),
  }
}
