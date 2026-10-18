/**
 * The approval workflow.
 *
 * A pending request HOLDS its slot, so nobody can book over a room that is
 * awaiting a decision — and it EXPIRES, so a forgotten request cannot
 * sterilize the best room in the building indefinitely. Neither property works
 * without the other (docs/15-approvals.md section 2).
 *
 * Specification: docs/15-approvals.md.
 */

import { Prisma } from '@prisma/client'
import { can, type Actor } from '@roombook/shared'

import { config } from '../config.js'
import { prisma } from '../db.js'
import {
  AuthorizationError,
  BookingConflictError,
  NotFoundError,
  RoomInactiveError,
  StateConflictError,
  ValidationError,
} from '../domain/errors.js'
import { logger } from '../middleware/requestContext.js'
import * as audit from './AuditService.js'
import { loadRoomContext } from './AvailabilityService.js'

const MIN_REASON = 3

export interface Approver {
  id: string
  email: string
  fullName: string
}

/**
 * Who may decide this request.
 *
 * A named approver is the person who actually owns the room, but location
 * admins remain able to act as a backstop — otherwise one person's holiday
 * blocks every request for a fortnight (docs/15 section 3).
 */
export async function approversFor(
  organizationId: string,
  roomId: string,
): Promise<{ named: Approver | null; fallback: Approver[] }> {
  const room = await prisma.room.findFirst({
    where: { id: roomId, organizationId },
    select: {
      locationId: true,
      approver: { select: { id: true, email: true, fullName: true, status: true } },
    },
  })
  if (!room) return { named: null, fallback: [] }

  const named =
    room.approver && room.approver.status === 'ACTIVE'
      ? { id: room.approver.id, email: room.approver.email, fullName: room.approver.fullName }
      : null

  // Admins and owners who administer this location. An ADMIN with no grants is
  // organization-wide, so an empty grant list counts as covering every site.
  const candidates = await prisma.user.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      role: { in: ['ADMIN', 'OWNER'] },
    },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      locationAccess: { select: { locationId: true } },
    },
  })

  const fallback = candidates
    .filter(
      u =>
        u.role === 'OWNER' ||
        u.locationAccess.length === 0 ||
        u.locationAccess.some(a => a.locationId === room.locationId),
    )
    .map(u => ({ id: u.id, email: u.email, fullName: u.fullName }))

  return { named, fallback }
}

/**
 * Queues the notification that a decision is needed.
 *
 * This is the deliberate exception to D6 (organizer-only email): an approver is
 * not the organizer, and an approver who is never told has nothing to act on.
 *
 * Written in the SAME transaction as the booking, like every other
 * notification, so a rolled-back request notifies nobody.
 */
export async function queueApprovalRequest(
  tx: Prisma.TransactionClient,
  booking: {
    id: string
    organizationId: string
    roomId: string
    title: string
    startsAt: Date
    endsAt: Date
    approvalExpiresAt: Date | null
    organizer: { fullName: string; email: string }
    room: { name: string; location: { name: string; timezone: string } }
  },
  approvers: Approver[],
  requesterId: string,
): Promise<void> {
  // A requester may never approve their own request, so there is no point
  // emailing them about it (BR-A7).
  const recipients = approvers.filter(a => a.id !== requesterId)

  if (recipients.length === 0) {
    // Worth a loud log: the room is configured to need approval but nobody can
    // give it, so every request will expire. An admin needs to fix the setup.
    logger.error(
      { bookingId: booking.id, roomId: booking.roomId },
      'Approval-required room has no eligible approver; requests will expire',
    )
    return
  }

  const tz = booking.room.location.timezone
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(booking.startsAt)

  await tx.emailOutbox.createMany({
    data: recipients.map(a => ({
      organizationId: booking.organizationId,
      bookingId: booking.id,
      template: 'approval_requested',
      toEmail: a.email,
      toName: a.fullName,
      subject: `Approval needed: ${booking.title} - ${booking.room.name}, ${when}`,
      payload: {
        bookingId: booking.id,
        title: booking.title,
        room: booking.room.name,
        location: booking.room.location.name,
        timeZone: tz,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        organizer: booking.organizer.fullName,
        requestedBy: booking.organizer.fullName,
        expiresAt: booking.approvalExpiresAt?.toISOString() ?? null,
        url: `${config.APP_URL}/admin/approvals`,
      } as Prisma.InputJsonValue,
      // No calendar attachment: the approver is not an attendee, and the
      // meeting may never happen.
      icsMethod: null,
    })),
  })
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

const pendingInclude = {
  room: {
    select: {
      id: true,
      name: true,
      capacity: true,
      floor: true,
      colour: true,
      locationId: true,
      approverUserId: true,
      location: { select: { id: true, name: true, timezone: true } },
    },
  },
  organizer: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.BookingInclude

/**
 * Requests awaiting a decision, most urgent first.
 *
 * Sorted by expiry rather than submission: what an admin needs to see is what
 * is about to lapse, not what arrived first.
 */
export async function pendingQueue(actor: Actor, locationId?: string) {
  const rows = await prisma.booking.findMany({
    where: {
      organizationId: actor.organizationId,
      status: 'PENDING_APPROVAL',
      ...(locationId ? { room: { locationId } } : {}),
    },
    include: pendingInclude,
    orderBy: [{ approvalExpiresAt: 'asc' }, { startsAt: 'asc' }],
    take: 200,
  })

  // A location-scoped admin sees only their own sites (BR-L1, T-196).
  return rows
    .filter(b =>
      can(actor, 'booking:approve', {
        organizationId: b.organizationId,
        organizerId: b.organizerId,
        locationId: b.room.locationId,
        status: b.status,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
      }),
    )
    .map(b => ({
      id: b.id,
      title: b.title,
      description: b.description,
      approvalNote: b.approvalNote,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      approvalExpiresAt: b.approvalExpiresAt,
      createdAt: b.createdAt,
      room: b.room,
      organizer: b.organizer,
      /** True when this admin is the room's named approver. */
      isNamedApprover: b.room.approverUserId === actor.id,
    }))
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

async function loadPending(actor: Actor, id: string) {
  const booking = await prisma.booking.findFirst({
    where: { id, organizationId: actor.organizationId },
    include: pendingInclude,
  })
  if (!booking) throw new NotFoundError('That request')

  if (booking.status !== 'PENDING_APPROVAL') {
    throw new StateConflictError(
      booking.status === 'CONFIRMED'
        ? 'That request has already been approved'
        : `That request is no longer pending (it is ${booking.status.toLowerCase()})`,
    )
  }

  const subject = {
    organizationId: booking.organizationId,
    organizerId: booking.organizerId,
    locationId: booking.room.locationId,
    status: booking.status,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
  }

  if (!can(actor, 'booking:approve', subject)) {
    // Distinguishing the two reasons is worth it: "you cannot approve your own
    // request" is actionable, where a bare 403 is not.
    throw new AuthorizationError(
      booking.organizerId === actor.id
        ? 'You cannot approve your own request - someone else must decide'
        : 'You do not administer that location',
    )
  }

  return booking
}

export interface DecisionMeta {
  ip?: string
  actorName?: string
  actorEmail?: string
}

/**
 * Approves a request, optionally moving it to another room in the same action.
 *
 * Approve-and-move is the common real outcome: the boardroom is wanted, so the
 * meeting is allowed but elsewhere (BR-A14).
 */
export async function approve(
  actor: Actor,
  id: string,
  options: { moveToRoomId?: string; note?: string },
  meta: DecisionMeta = {},
) {
  const booking = await loadPending(actor, id)
  const targetRoomId = options.moveToRoomId ?? booking.roomId

  const ctx = await loadRoomContext(actor.organizationId, targetRoomId)
  if (!ctx) throw new NotFoundError('That room')

  /*
   * BR-A9: re-validate before confirming. The room may have been deactivated,
   * or a closure added, since the request was made. Confirming a booking that
   * is no longer valid would be worse than refusing it.
   */
  if (!ctx.room.isActive) throw new RoomInactiveError()

  if (targetRoomId !== booking.roomId) {
    if (
      !can(actor, 'room:update', {
        organizationId: actor.organizationId,
        locationId: ctx.room.locationId,
      })
    ) {
      throw new AuthorizationError(`You do not administer ${ctx.room.location.name}`)
    }

    // The target must be free. The pending request holds its original slot, not
    // this one.
    const clash = await prisma.booking.findFirst({
      where: {
        roomId: targetRoomId,
        status: { in: ['PENDING_APPROVAL', 'CONFIRMED', 'ENDED_EARLY'] },
        startsAt: { lt: booking.endsAt },
        endsAt: { gt: booking.startsAt },
        id: { not: id },
      },
      select: { id: true, title: true, startsAt: true, endsAt: true },
    })
    if (clash) {
      throw new BookingConflictError([
        {
          id: clash.id,
          startsAt: clash.startsAt.toISOString(),
          endsAt: clash.endsAt.toISOString(),
          title: clash.title,
        },
      ])
    }
  }

  const closure = await prisma.roomClosure.findFirst({
    where: { roomId: targetRoomId, startsAt: { lt: booking.endsAt }, endsAt: { gt: booking.startsAt } },
    select: { reason: true },
  })
  if (closure) {
    throw new StateConflictError(
      `That room is now closed during this time: ${closure.reason}. Reject the request or move it elsewhere.`,
    )
  }

  const moved = targetRoomId !== booking.roomId

  return prisma.$transaction(async tx => {
    const row = await tx.booking.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        roomId: targetRoomId,
        approvedAt: new Date(),
        approvedById: actor.id,
        approvalExpiresAt: null,
        // The calendar invitation goes out now, so the sequence advances.
        icsSequence: { increment: 1 },
      },
      include: {
        ...pendingInclude,
        attendees: { select: { email: true, displayName: true } },
      },
    })

    await audit.record(
      {
        actor: {
          id: actor.id,
          fullName: meta.actorName,
          email: meta.actorEmail,
          organizationId: actor.organizationId,
        },
        eventType: 'BOOKING_APPROVED',
        entityType: 'booking',
        entityId: id,
        locationId: ctx.room.locationId,
        before: { status: 'PENDING_APPROVAL', room: booking.room.name },
        after: { status: 'CONFIRMED', room: ctx.room.name },
        reason: options.note ?? null,
        ip: meta.ip ?? null,
      },
      tx,
    )

    const when = formatWhen(row.startsAt, row.endsAt, ctx.timeZone)

    // Only now does the requester get a calendar invitation (BR-A13).
    await tx.emailOutbox.create({
      data: {
        organizationId: row.organizationId,
        bookingId: row.id,
        template: moved ? 'booking_approved_moved' : 'booking_approved',
        toEmail: row.organizer.email,
        toName: row.organizer.fullName,
        subject: moved
          ? `Approved in ${ctx.room.name}: ${row.title} - ${when}`
          : `Approved: ${row.title} - ${ctx.room.name}, ${when}`,
        payload: {
          bookingId: row.id,
          title: row.title,
          room: ctx.room.name,
          location: ctx.room.location.name,
          timeZone: ctx.timeZone,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          organizer: row.organizer.fullName,
          approvedBy: meta.actorName ?? 'An administrator',
          note: options.note ?? null,
          requestedRoom: moved ? booking.room.name : null,
          url: `${config.APP_URL}/bookings/${row.id}`,
        } as Prisma.InputJsonValue,
        icsMethod: 'REQUEST',
      },
    })

    return row
  })
}

export async function reject(actor: Actor, id: string, reason: string, meta: DecisionMeta = {}) {
  const booking = await loadPending(actor, id)

  // BR-A4: approval needs no reason, rejection does. The requester is losing
  // something and deserves to know why.
  if (!reason || reason.trim().length < MIN_REASON) {
    throw new ValidationError('Please give a reason, which is shown to the requester', {
      reason: 'A reason is required',
    })
  }

  return prisma.$transaction(async tx => {
    const row = await tx.booking.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
        rejectedById: actor.id,
        rejectionReason: reason.trim(),
        approvalExpiresAt: null,
        icsSequence: { increment: 1 },
      },
      include: pendingInclude,
    })

    await audit.record(
      {
        actor: {
          id: actor.id,
          fullName: meta.actorName,
          email: meta.actorEmail,
          organizationId: actor.organizationId,
        },
        eventType: 'BOOKING_REJECTED',
        entityType: 'booking',
        entityId: id,
        locationId: booking.room.locationId,
        before: { status: 'PENDING_APPROVAL' },
        after: { status: 'REJECTED' },
        reason: reason.trim(),
        ip: meta.ip ?? null,
      },
      tx,
    )

    await tx.emailOutbox.create({
      data: {
        organizationId: row.organizationId,
        bookingId: row.id,
        template: 'booking_rejected',
        toEmail: row.organizer.email,
        toName: row.organizer.fullName,
        subject: `Not approved: ${row.title} - ${row.room.name}`,
        payload: {
          bookingId: row.id,
          title: row.title,
          room: row.room.name,
          location: row.room.location.name,
          timeZone: row.room.location.timezone,
          startsAt: row.startsAt.toISOString(),
          endsAt: row.endsAt.toISOString(),
          organizer: row.organizer.fullName,
          rejectedBy: meta.actorName ?? 'An administrator',
          reason: reason.trim(),
          url: `${config.APP_URL}/find`,
        } as Prisma.InputJsonValue,
        // The slot is free again, so nothing goes into a calendar.
        icsMethod: null,
      },
    })

    return row
  })
}

/** A requester withdrawing their own request needs no reason (BR-A5). */
export async function withdraw(actor: Actor, id: string, meta: DecisionMeta = {}) {
  const booking = await prisma.booking.findFirst({
    where: { id, organizationId: actor.organizationId },
    include: pendingInclude,
  })
  if (!booking) throw new NotFoundError('That request')
  if (booking.status !== 'PENDING_APPROVAL') {
    throw new StateConflictError('That request is no longer pending')
  }
  if (booking.organizerId !== actor.id) {
    throw new AuthorizationError('Only the person who asked can withdraw a request')
  }

  return prisma.$transaction(async tx => {
    const row = await tx.booking.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancellationReason: 'Withdrawn by the requester',
        approvalExpiresAt: null,
      },
      include: pendingInclude,
    })

    await audit.record(
      {
        actor: {
          id: actor.id,
          fullName: meta.actorName,
          email: meta.actorEmail,
          organizationId: actor.organizationId,
        },
        eventType: 'BOOKING_CANCELLED',
        entityType: 'booking',
        entityId: id,
        locationId: booking.room.locationId,
        after: { status: 'CANCELLED', withdrawn: true },
        ip: meta.ip ?? null,
      },
      tx,
    )

    // Approvers are told, so they stop looking at a request nobody wants.
    const { named, fallback } = await approversFor(actor.organizationId, booking.roomId)
    const recipients = (named ? [named] : fallback).filter(a => a.id !== actor.id)

    if (recipients.length > 0) {
      await tx.emailOutbox.createMany({
        data: recipients.map(a => ({
          organizationId: row.organizationId,
          bookingId: row.id,
          template: 'approval_withdrawn',
          toEmail: a.email,
          toName: a.fullName,
          subject: `Withdrawn: ${row.title} - ${row.room.name}`,
          payload: {
            title: row.title,
            room: row.room.name,
            organizer: row.organizer.fullName,
            timeZone: row.room.location.timezone,
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
          } as Prisma.InputJsonValue,
          icsMethod: null,
        })),
      })
    }

    return row
  })
}

function formatWhen(start: Date, end: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(start)
  const time = (d: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d)
  return `${day}, ${time(start)}-${time(end)}`
}
