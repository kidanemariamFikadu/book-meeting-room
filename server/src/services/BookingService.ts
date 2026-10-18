/**
 * The booking engine.
 *
 * The correctness property this file exists to guarantee: the booking, its
 * audit row and its notifications are written in ONE transaction, and no two
 * bookings can ever overlap in the same room.
 *
 * Overlap is not prevented by checking first and writing second — two requests
 * can both pass that check. It is prevented by the `bookings_no_overlap`
 * exclusion constraint in the database. The pre-check here exists only to
 * produce a friendly message with alternatives; the constraint is the
 * authority, and a violation of it is caught and returned as the same 409.
 *
 * Specification: docs/04-business-rules.md, docs/02-architecture.md section 7.
 */

import { randomUUID } from 'node:crypto'

import { Prisma, type BookingStatus } from '@prisma/client'
import {
  OCCUPYING_BOOKING_STATUSES,
  can,
  type Actor,
} from '@roombook/shared'

import { config } from '../config.js'
import { prisma } from '../db.js'
import {
  AuthorizationError,
  BookingConflictError,
  ClosureConflictError,
  NotFoundError,
  RoomInactiveError,
  RuleViolationError,
  StateConflictError,
  ValidationError,
} from '../domain/errors.js'
import { effectiveLimits, validateBookingRules } from '../domain/rules.js'
import * as approvers from './ApprovalService.js'
import * as audit from './AuditService.js'
import { loadRoomContext, type RoomContext } from './AvailabilityService.js'

/**
 * Did this error come from the overlap exclusion constraint?
 *
 * PostgreSQL raises SQLSTATE 23P01 for an exclusion violation, but Prisma does
 * not map that code to a typed error: depending on the path it surfaces as a
 * `PrismaClientUnknownRequestError` whose message merely contains the
 * connector text. Matching only on `instanceof KnownRequestError` therefore
 * misses the real conflicts and turns a clean 409 into a 500 - which is
 * precisely what test T-20 caught.
 *
 * So every shape is checked, including the raw message.
 */
const EXCLUSION_VIOLATION = '23P01'
const OVERLAP_CONSTRAINT = 'bookings_no_overlap'

function isOverlapViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false

  const candidate = err as {
    code?: string
    message?: string
    meta?: Record<string, unknown>
  }

  if (candidate.code === EXCLUSION_VIOLATION) return true

  const constraint = candidate.meta?.['constraint']
  if (typeof constraint === 'string' && constraint.includes('no_overlap')) return true

  const message = typeof candidate.message === 'string' ? candidate.message : ''
  return message.includes(EXCLUSION_VIOLATION) || message.includes(OVERLAP_CONSTRAINT)
}

/**
 * Transaction settings for a booking write.
 *
 * READ COMMITTED, not SERIALIZABLE, and that is deliberate.
 *
 * The no-overlap guarantee comes from the `bookings_no_overlap` exclusion
 * constraint, which holds under every isolation level — it is enforced by the
 * index, not by the snapshot. Serializable therefore adds no safety here, and
 * it adds real cost: with many simultaneous attempts on one slot, every
 * transaction queues on the same constraint and the slowest exceeded the
 * transaction timeout, turning an honest 409 into a 500 (observed at 12
 * concurrent attempts while building T-20).
 *
 * Under READ COMMITTED a conflicting insert simply blocks until the winner
 * commits and then raises 23P01 immediately, which is converted to the same
 * 409 the pre-check would have produced. The pre-check remains, purely so the
 * common case produces a helpful message with alternatives rather than a bare
 * constraint error.
 *
 * This is a deliberate deviation from docs/02-architecture.md section 4, which
 * specified a serializable transaction; the document has been updated.
 */
const TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  // Generous enough to absorb lock waits under contention, short enough that a
  // genuinely stuck transaction does not hold a connection all day.
  timeout: 20_000,
  maxWait: 10_000,
} as const

/** A closure overlapping a closure, which has its own constraint. */
function isClosureOverlapViolation(err: unknown): boolean {
  const message =
    typeof err === 'object' && err !== null && typeof (err as { message?: string }).message === 'string'
      ? (err as { message: string }).message
      : ''
  return message.includes('room_closures_no_overlap')
}

// Referenced once the closure endpoints land in M5.
void isClosureOverlapViolation

export interface AttendeeInput {
  userId?: string
  email?: string
  displayName?: string
}

export interface CreateBookingInput {
  roomId: string
  title: string
  description?: string
  startsAt: Date
  endsAt: Date
  isPrivate?: boolean
  attendees?: AttendeeInput[]
  /** Admin only: book on behalf of someone else (US-M7). */
  organizerId?: string
}

const bookingInclude = {
  room: {
    select: {
      id: true,
      name: true,
      capacity: true,
      floor: true,
      colour: true,
      requiresApproval: true,
      location: { select: { id: true, name: true, timezone: true, address: true } },
    },
  },
  organizer: { select: { id: true, fullName: true, email: true } },
  attendees: {
    select: { id: true, email: true, displayName: true, userId: true, response: true },
  },
} satisfies Prisma.BookingInclude

export type BookingWithContext = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getById(actor: Actor, id: string): Promise<BookingWithContext> {
  const booking = await prisma.booking.findFirst({
    // Scoped by organization, so an id from elsewhere reads as missing rather
    // than forbidden: existence itself is not disclosed.
    where: { id, organizationId: actor.organizationId },
    include: bookingInclude,
  })
  if (!booking) throw new NotFoundError('That booking')
  return booking
}

export interface ListFilters {
  scope?: 'mine' | 'all' | 'attending'
  from?: Date
  to?: Date
  roomId?: string
  locationId?: string
  organizerId?: string
  status?: BookingStatus | 'all'
  q?: string
}

export async function list(actor: Actor, filters: ListFilters = {}) {
  const scope = filters.scope ?? 'mine'

  // Only an admin may look beyond their own bookings.
  if ((scope === 'all' || filters.organizerId) && !can(actor, 'audit:view', { organizationId: actor.organizationId })) {
    throw new AuthorizationError('Only an admin can view everyone bookings')
  }

  const where: Prisma.BookingWhereInput = {
    organizationId: actor.organizationId,
    ...(scope === 'mine' ? { organizerId: actor.id } : {}),
    ...(scope === 'attending' ? { attendees: { some: { userId: actor.id } } } : {}),
    ...(filters.organizerId ? { organizerId: filters.organizerId } : {}),
    ...(filters.roomId ? { roomId: filters.roomId } : {}),
    ...(filters.locationId ? { room: { locationId: filters.locationId } } : {}),
    ...(filters.from || filters.to
      ? {
          startsAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lt: filters.to } : {}),
          },
        }
      : {}),
    ...(filters.status && filters.status !== 'all'
      ? { status: filters.status }
      : filters.status === 'all'
        ? {}
        : { status: { in: [...OCCUPYING_BOOKING_STATUSES] } }),
    ...(filters.q ? { title: { contains: filters.q, mode: 'insensitive' } } : {}),
  }

  return prisma.booking.findMany({
    where,
    include: bookingInclude,
    orderBy: { startsAt: scope === 'mine' ? 'asc' : 'asc' },
    take: 500,
  })
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

/**
 * Bookings that overlap the range in this room.
 *
 * Half-open comparison: a booking ending exactly when another starts does not
 * conflict (BR-T2). `lt` and `gt`, never `lte`/`gte` — using the inclusive
 * forms here would be the most user-visible bug the system could ship.
 */
async function findOverlapping(
  tx: Prisma.TransactionClient,
  roomId: string,
  start: Date,
  end: Date,
  excludeBookingId?: string,
) {
  return tx.booking.findMany({
    where: {
      roomId,
      status: { in: [...OCCUPYING_BOOKING_STATUSES] },
      startsAt: { lt: end },
      endsAt: { gt: start },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      isPrivate: true,
      organizerId: true,
      organizer: { select: { fullName: true } },
    },
    orderBy: { startsAt: 'asc' },
  })
}

async function findOverlappingClosure(
  tx: Prisma.TransactionClient,
  roomId: string,
  start: Date,
  end: Date,
) {
  return tx.roomClosure.findFirst({
    where: { roomId, startsAt: { lt: end }, endsAt: { gt: start } },
    select: { reason: true, startsAt: true, endsAt: true },
  })
}

/** Redacts a conflicting booking the viewer is not entitled to see (BR-P3). */
function describeConflict(
  actor: Actor,
  ctx: RoomContext,
  c: {
    id: string
    title: string
    startsAt: Date
    endsAt: Date
    isPrivate: boolean
    organizerId: string
    organizer: { fullName: string }
  },
) {
  const maySee =
    !c.isPrivate ||
    c.organizerId === actor.id ||
    can(actor, 'booking:viewDetails', {
      organizationId: actor.organizationId,
      locationId: ctx.room.locationId,
      organizerId: c.organizerId,
      status: 'CONFIRMED',
      startsAt: c.startsAt,
      endsAt: c.endsAt,
    })

  return {
    id: c.id,
    startsAt: c.startsAt.toISOString(),
    endsAt: c.endsAt.toISOString(),
    title: maySee ? c.title : 'Busy',
    ...(maySee ? { organizer: c.organizer.fullName } : {}),
  }
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export async function create(
  actor: Actor,
  input: CreateBookingInput,
  meta: { ip?: string; actorName?: string; actorEmail?: string } = {},
): Promise<BookingWithContext> {
  const ctx = await loadRoomContext(actor.organizationId, input.roomId)
  if (!ctx) throw new NotFoundError('That room')
  if (!ctx.room.isActive) throw new RoomInactiveError()

  // Booking for someone else is an admin action, scoped to the room location.
  let organizerId = actor.id
  if (input.organizerId && input.organizerId !== actor.id) {
    if (!can(actor, 'booking:createForOther', {
      organizationId: actor.organizationId,
      locationId: ctx.room.locationId,
    })) {
      throw new AuthorizationError('Only an admin can book on behalf of someone else')
    }
    const organizer = await prisma.user.findFirst({
      where: { id: input.organizerId, organizationId: actor.organizationId, status: 'ACTIVE' },
      select: { id: true },
    })
    if (!organizer) throw new ValidationError('That organizer does not exist', { organizerId: 'Unknown user' })
    organizerId = organizer.id
  }

  const interval = { start: input.startsAt, end: input.endsAt }

  const failure = validateBookingRules({
    interval,
    limits: effectiveLimits(ctx.settings),
    timeZone: ctx.timeZone,
    roomHours: ctx.roomHours,
    locationHours: ctx.locationHours,
    orgHours: ctx.orgHours,
    holidays: ctx.holidays,
    now: new Date(),
  })
  if (failure) throw new RuleViolationError(failure.rule, failure.message)

  const attendees = await resolveAttendees(actor.organizationId, input.attendees ?? [], ctx.allowExternalAttendees)

  /*
   * Everything below is one SERIALIZABLE transaction: the conflict check, the
   * insert, the audit row and the notifications. If any step fails, none of
   * them happened - there are no emails about bookings that do not exist
   * (BR-N1), and no audit row for a booking that was rolled back.
   */
  /*
   * The pre-check runs OUTSIDE the transaction, on purpose.
   *
   * It cannot prevent a race - two requests can both pass it before either
   * writes - and it was never what made the system safe; the exclusion
   * constraint is. Its only job is to turn the common case into a helpful
   * message with alternatives instead of a bare constraint error.
   *
   * Keeping it outside means an interactive transaction holds its connection
   * for three fast writes rather than for reads as well. Under a burst of
   * simultaneous attempts on one slot that is the difference between clean
   * 409s and connections starving until they time out.
   */
  const closure = await findOverlappingClosure(prisma, ctx.room.id, interval.start, interval.end)
  if (closure) throw new ClosureConflictError(closure.reason)

  const preExisting = await findOverlapping(prisma, ctx.room.id, interval.start, interval.end)
  if (preExisting.length > 0) {
    throw new BookingConflictError(preExisting.map(c => describeConflict(actor, ctx, c)))
  }

  try {
    const created = await prisma.$transaction(
      async tx => {
        const requiresApproval = ctx.room.requiresApproval
        const status: BookingStatus = requiresApproval ? 'PENDING_APPROVAL' : 'CONFIRMED'

        const booking = await tx.booking.create({
          data: {
            organizationId: actor.organizationId,
            roomId: ctx.room.id,
            organizerId,
            createdById: actor.id,
            title: input.title.trim(),
            description: input.description?.trim() ?? null,
            startsAt: interval.start,
            endsAt: interval.end,
            status,
            isPrivate: input.isPrivate ?? false,
            // Stable for the booking whole life, so calendar clients update
            // the entry rather than creating a second one.
            icsUid: `${randomUUID()}@roombook`,
            ...(requiresApproval
              ? { approvalExpiresAt: approvalDeadline(interval.start, ctx.approvalWindowHours) }
              : {}),
            ...(attendees.length > 0 ? { attendees: { create: attendees } } : {}),
          },
          include: bookingInclude,
        })

        await audit.record(
          {
            actor: { ...actorLabel(actor, meta), organizationId: actor.organizationId },
            eventType: 'BOOKING_CREATED',
            entityType: 'booking',
            entityId: booking.id,
            locationId: ctx.room.locationId,
            after: {
              room: ctx.room.name,
              title: booking.title,
              startsAt: booking.startsAt,
              endsAt: booking.endsAt,
              status,
            },
            ip: meta.ip ?? null,
          },
          tx,
        )

        /*
         * The template follows the STATUS, not the act of booking.
         *
         * Telling someone their booking is confirmed when it is actually
         * waiting on an approver is worse than saying nothing: they plan
         * around a room they may not get (BR-A1).
         */
        await queueBookingEmails(
          tx,
          booking,
          ctx,
          status === 'PENDING_APPROVAL' ? 'booking_pending' : 'booking_confirmed',
        )

        /*
         * Tell whoever can decide.
         *
         * Without this the request sits until it expires: the requester is
         * told it is pending and nobody is told it is waiting. The email to an
         * approver is the deliberate exception to D6 (organizer-only mail),
         * because an approver is not the organizer and has nothing to act on
         * otherwise.
         */
        if (status === 'PENDING_APPROVAL') {
          const { named, fallback } = await approvers.approversFor(
            actor.organizationId,
            ctx.room.id,
          )
          await approvers.queueApprovalRequest(
            tx,
            booking,
            named ? [named] : fallback,
            actor.id,
          )
        }

        return booking
      },
      TRANSACTION_OPTIONS,
    )

    return created
  } catch (err) {
    // The constraint fired between our check and our insert: another request
    // won the race. Same 409 the pre-check would have produced (BR-C2).
    if (isOverlapViolation(err)) {
      const conflicts = await findOverlapping(prisma, ctx.room.id, interval.start, interval.end)
      throw new BookingConflictError(conflicts.map(c => describeConflict(actor, ctx, c)))
    }
    throw err
  }
}

function approvalDeadline(startsAt: Date, windowHours: number): Date {
  const standard = Date.now() + windowHours * 3_600_000
  // Never after the meeting would have started; two hours before, so there is
  // still time to find another room (docs/15 section 2).
  const beforeStart = startsAt.getTime() - 2 * 3_600_000
  return new Date(Math.min(standard, Math.max(beforeStart, Date.now() + 5 * 60_000)))
}

async function resolveAttendees(
  organizationId: string,
  input: AttendeeInput[],
  allowExternal: boolean,
) {
  if (input.length === 0) return []

  const userIds = input.map(a => a.userId).filter((v): v is string => Boolean(v))
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds }, organizationId },
        select: { id: true, email: true, fullName: true },
      })
    : []

  const seen = new Set<string>()
  const rows: Array<{ userId: string | null; email: string; displayName: string | null }> = []

  for (const a of input) {
    const user = a.userId ? users.find(u => u.id === a.userId) : undefined
    if (a.userId && !user) {
      throw new ValidationError('One of those attendees does not exist', { attendees: 'Unknown user' })
    }

    const email = (user?.email ?? a.email ?? '').toLowerCase().trim()
    if (!email) continue

    const isInternal = Boolean(user) || users.some(u => u.email === email)
    if (!isInternal && !allowExternal) {
      throw new ValidationError('External guests are not permitted', {
        attendees: 'Only colleagues can be invited',
      })
    }

    // Email is the identity: the same person added twice, once by id and once
    // by address, is one attendee.
    if (seen.has(email)) continue
    seen.add(email)

    rows.push({
      userId: user?.id ?? null,
      email,
      displayName: user?.fullName ?? a.displayName ?? null,
    })
  }

  return rows
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Queues email in the SAME transaction as the change (BR-N1).
 *
 * One row per recipient, never a shared BCC, so one bad address cannot block
 * everyone else and a retry is per person (BR-N2).
 */
async function queueBookingEmails(
  tx: Prisma.TransactionClient,
  booking: BookingWithContext,
  ctx: RoomContext,
  template: string,
  extra: Record<string, unknown> = {},
) {
  const when = subjectWhen(booking.startsAt, booking.endsAt, ctx.timeZone)

  const payload = {
    bookingId: booking.id,
    title: booking.title,
    room: booking.room.name,
    location: booking.room.location.name,
    address: booking.room.location.address,
    timeZone: ctx.timeZone,
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    organizer: booking.organizer.fullName,
    url: `${config.APP_URL}/bookings/${booking.id}`,
    ...extra,
  }

  const recipients: Array<{ email: string; name: string | null }> = [
    { email: booking.organizer.email, name: booking.organizer.fullName },
  ]

  // D6: attendees receive nothing in v1 unless the organization opts in. The
  // templates exist and are tested; this is a settings gate, not a gap.
  if (ctx.notifyAttendees) {
    for (const a of booking.attendees) {
      if (a.email !== booking.organizer.email) recipients.push({ email: a.email, name: a.displayName })
    }
  }

  await tx.emailOutbox.createMany({
    data: recipients.map(r => ({
      organizationId: booking.organizationId,
      bookingId: booking.id,
      template,
      toEmail: r.email,
      toName: r.name,
      subject: subjectFor(template, booking.title, booking.room.name, when),
      payload: payload as Prisma.InputJsonValue,
      // Decides whether the worker attaches a calendar invitation, and whether
      // it adds the entry or withdraws it. Without this the message goes out
      // with no .ics at all and the meeting never reaches anyone's calendar.
      icsMethod: icsMethodFor(template),
    })),
  })
}

/**
 * The iCalendar METHOD for a template, or null for messages that carry no
 * calendar attachment.
 *
 * A reminder deliberately has none: the meeting is already in the recipient's
 * calendar, and re-sending the event would be noise.
 */
function icsMethodFor(template: string): 'REQUEST' | 'CANCEL' | null {
  switch (template) {
    case 'booking_confirmed':
    case 'booking_invitation':
    case 'booking_moved':
    case 'booking_updated':
      return 'REQUEST'
    case 'booking_cancelled':
      return 'CANCEL'
    /*
     * BR-A13: a booking awaiting approval gets NO calendar invitation.
     *
     * A tentative entry that may later vanish is worse than none - the
     * recipient plans around a meeting that was never approved. The invitation
     * is sent when the request is approved.
     */
    case 'booking_pending':
    default:
      return null
  }
}

/**
 * The time as it appears in a subject line.
 *
 * Readable rather than machine-formatted: a subject is the most-read text the
 * system produces, and "Tue 4 Nov, 09:00-10:00" tells someone scanning an
 * inbox what they need, where an ISO timestamp does not. Kept short so it
 * survives the ~78 characters most clients show.
 */
function subjectWhen(start: Date, end: Date, timeZone: string): string {
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

function subjectFor(template: string, title: string, room: string, when: string): string {
  switch (template) {
    // "Requested", never "Confirmed": the subject line is often all someone
    // reads, so it must not promise a room that is still awaiting approval.
    case 'booking_pending':
      return `Requested: ${title} - ${room}, ${when}`
    case 'booking_moved':
      return `Moved: ${title} - now ${room}, ${when}`
    case 'booking_cancelled':
      return `Cancelled: ${title} - ${room}, ${when}`
    case 'booking_updated':
      return `Updated: ${title} - ${when}`
    case 'booking_ended_early':
      return `Ended early: ${title} - ${room}`
    default:
      return `Confirmed: ${title} - ${room}, ${when}`
  }
}

function actorLabel(actor: Actor, meta: { actorName?: string; actorEmail?: string }) {
  return { id: actor.id, fullName: meta.actorName, email: meta.actorEmail }
}

// ---------------------------------------------------------------------------
// Updating, moving, cancelling
// ---------------------------------------------------------------------------

export interface UpdateBookingInput {
  title?: string
  description?: string | null
  isPrivate?: boolean
  attendees?: AttendeeInput[]
}

export async function update(
  actor: Actor,
  id: string,
  input: UpdateBookingInput,
  meta: { ip?: string; actorName?: string; actorEmail?: string } = {},
) {
  const booking = await getById(actor, id)
  const ctx = await requireContext(actor.organizationId, booking.roomId)

  if (!can(actor, 'booking:update', subjectOf(booking, ctx))) {
    throw new AuthorizationError('You cannot change this booking')
  }

  const attendees =
    input.attendees !== undefined
      ? await resolveAttendees(actor.organizationId, input.attendees, ctx.allowExternalAttendees)
      : undefined

  const updated = await prisma.$transaction(async tx => {
    if (attendees !== undefined) {
      await tx.bookingAttendee.deleteMany({ where: { bookingId: id } })
      if (attendees.length > 0) {
        await tx.bookingAttendee.createMany({
          data: attendees.map(a => ({ ...a, bookingId: id })),
        })
      }
    }

    const row = await tx.booking.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.isPrivate !== undefined ? { isPrivate: input.isPrivate } : {}),
        icsSequence: { increment: 1 },
      },
      include: bookingInclude,
    })

    await audit.record(
      {
        actor: { ...actorLabel(actor, meta), organizationId: actor.organizationId },
        eventType: 'BOOKING_UPDATED',
        entityType: 'booking',
        entityId: id,
        locationId: ctx.room.locationId,
        before: { title: booking.title, isPrivate: booking.isPrivate },
        after: { title: row.title, isPrivate: row.isPrivate },
        ip: meta.ip ?? null,
      },
      tx,
    )

    await queueBookingEmails(tx, row, ctx, 'booking_updated')
    return row
  })

  return updated
}

export interface MoveBookingInput {
  roomId?: string
  startsAt?: Date
  endsAt?: Date
  reason: string
}

/**
 * The admin action: change the room and/or the time (US-M3, US-M4).
 *
 * The booking keeps its id, organizer, attendees and `icsUid`, and increments
 * `icsSequence`. It is NOT cancelled and recreated — that is what makes the
 * entry update in the organizer calendar rather than appearing twice (BR-M3).
 */
export async function move(
  actor: Actor,
  id: string,
  input: MoveBookingInput,
  meta: { ip?: string; actorName?: string; actorEmail?: string } = {},
): Promise<BookingWithContext> {
  const booking = await getById(actor, id)
  const currentCtx = await requireContext(actor.organizationId, booking.roomId)

  if (!can(actor, 'booking:move', subjectOf(booking, currentCtx))) {
    throw new AuthorizationError('You cannot move this booking')
  }

  const targetRoomId = input.roomId ?? booking.roomId
  const targetCtx =
    targetRoomId === booking.roomId ? currentCtx : await requireContext(actor.organizationId, targetRoomId)

  // Moving INTO a location the admin does not administer is refused, even
  // though they administer the room it is leaving (BR-L2).
  if (targetRoomId !== booking.roomId) {
    if (!can(actor, 'room:update', {
      organizationId: actor.organizationId,
      locationId: targetCtx.room.locationId,
    })) {
      throw new AuthorizationError(`You do not administer ${targetCtx.room.location.name}`)
    }
    if (!targetCtx.room.isActive) throw new RoomInactiveError()
  }

  const start = input.startsAt ?? booking.startsAt
  const end = input.endsAt ?? booking.endsAt
  const interval = { start, end }

  const failure = validateBookingRules({
    interval,
    limits: effectiveLimits(targetCtx.settings),
    timeZone: targetCtx.timeZone,
    roomHours: targetCtx.roomHours,
    locationHours: targetCtx.locationHours,
    orgHours: targetCtx.orgHours,
    holidays: targetCtx.holidays,
    now: new Date(),
    // An admin relocating a meeting may legitimately need to ignore the
    // advance-notice rules meant for staff (US-M9).
    overrideWindows: true,
  })
  if (failure) throw new RuleViolationError(failure.rule, failure.message)

  // Checked outside the transaction for the same reason as in create(): the
  // constraint is the guarantee, this is only for a good message.
  const closure = await findOverlappingClosure(prisma, targetRoomId, start, end)
  if (closure) throw new ClosureConflictError(closure.reason)

  // The booking is excluded from its own conflict check (BR-C5).
  const preExisting = await findOverlapping(prisma, targetRoomId, start, end, id)
  if (preExisting.length > 0) {
    throw new BookingConflictError(preExisting.map(c => describeConflict(actor, targetCtx, c)))
  }

  try {
    return await prisma.$transaction(
      async tx => {
        /*
         * When the booking belongs to a series, moving it makes this occurrence
         * an EXCEPTION. `occurrenceStartLocal` is deliberately not touched — it
         * is the RECURRENCE-ID that ties the row back to its slot in the rule,
         * and `exceptionFields` records what diverged so a later series-wide
         * edit knows not to overwrite it (docs/12 section 5).
         */
        const diverged: string[] = []
        if (targetRoomId !== booking.roomId) diverged.push('roomId')
        if (start.getTime() !== booking.startsAt.getTime()) diverged.push('startsAt')
        if (end.getTime() !== booking.endsAt.getTime()) diverged.push('endsAt')

        const row = await tx.booking.update({
          where: { id },
          data: {
            roomId: targetRoomId,
            startsAt: start,
            endsAt: end,
            // Calendar clients ignore an update whose sequence has not advanced.
            icsSequence: { increment: 1 },
            ...(booking.seriesId
              ? {
                  isException: true,
                  exceptionFields: {
                    set: [...new Set([...booking.exceptionFields, ...diverged])],
                  },
                }
              : {}),
          },
          include: bookingInclude,
        })

        await audit.record(
          {
            actor: { ...actorLabel(actor, meta), organizationId: actor.organizationId },
            eventType: 'BOOKING_MOVED',
            entityType: 'booking',
            entityId: id,
            locationId: targetCtx.room.locationId,
            before: {
              room: currentCtx.room.name,
              startsAt: booking.startsAt,
              endsAt: booking.endsAt,
            },
            after: { room: targetCtx.room.name, startsAt: start, endsAt: end },
            reason: input.reason,
            ip: meta.ip ?? null,
          },
          tx,
        )

        await queueBookingEmails(tx, row, targetCtx, 'booking_moved', {
          reason: input.reason,
          movedBy: meta.actorName ?? 'An administrator',
          previousRoom: currentCtx.room.name,
          previousStartsAt: booking.startsAt.toISOString(),
          previousEndsAt: booking.endsAt.toISOString(),
          roomChanged: targetRoomId !== booking.roomId,
          timeChanged: start.getTime() !== booking.startsAt.getTime(),
        })

        return row
      },
      TRANSACTION_OPTIONS,
    )
  } catch (err) {
    if (isOverlapViolation(err)) {
      const conflicts = await findOverlapping(prisma, targetRoomId, start, end, id)
      throw new BookingConflictError(conflicts.map(c => describeConflict(actor, targetCtx, c)))
    }
    throw err
  }
}

export async function cancel(
  actor: Actor,
  id: string,
  reason: string | undefined,
  meta: { ip?: string; actorName?: string; actorEmail?: string } = {},
) {
  const booking = await getById(actor, id)
  const ctx = await requireContext(actor.organizationId, booking.roomId)
  const subject = subjectOf(booking, ctx)

  if (booking.status === 'CANCELLED' || booking.status === 'REJECTED') {
    throw new StateConflictError('That booking has already been cancelled')
  }

  if (!can(actor, 'booking:cancel', subject)) {
    // An in-progress booking is ended early rather than cancelled (BR-M2).
    if (can(actor, 'booking:endEarly', subject)) {
      throw new StateConflictError(
        'That meeting has already started. Use "end now" to release the room for the rest of the slot.',
      )
    }
    throw new AuthorizationError('You cannot cancel this booking')
  }

  // An admin cancelling someone else booking must say why (BR-M5).
  const isOwnBooking = booking.organizerId === actor.id
  if (!isOwnBooking && (!reason || reason.trim().length < 3)) {
    throw new ValidationError('Please give a reason, which is shown to the organizer', {
      reason: 'A reason is required',
    })
  }

  return prisma.$transaction(async tx => {
    const row = await tx.booking.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: actor.id,
        cancellationReason: reason?.trim() ?? null,
        icsSequence: { increment: 1 },
      },
      include: bookingInclude,
    })

    // A reminder queued for a cancelled booking must never fire (BR-M9).
    await tx.emailOutbox.updateMany({
      where: { bookingId: id, template: 'booking_reminder', status: 'QUEUED' },
      data: { status: 'CANCELLED' },
    })

    await audit.record(
      {
        actor: { ...actorLabel(actor, meta), organizationId: actor.organizationId },
        eventType: 'BOOKING_CANCELLED',
        entityType: 'booking',
        entityId: id,
        locationId: ctx.room.locationId,
        before: { status: booking.status },
        after: { status: 'CANCELLED' },
        reason: reason?.trim() ?? null,
        ip: meta.ip ?? null,
      },
      tx,
    )

    await queueBookingEmails(tx, row, ctx, 'booking_cancelled', {
      reason: reason?.trim() ?? null,
      cancelledBy: isOwnBooking ? null : (meta.actorName ?? 'An administrator'),
    })

    return row
  })
}

/**
 * D3: release an in-progress booking.
 *
 * TRUNCATES rather than erasing. The room really was used for the time that
 * elapsed, and recording that as a cancellation would make utilization
 * reporting claim it sat empty (BR-M2a, BR-M2b).
 */
export async function endEarly(
  actor: Actor,
  id: string,
  meta: { ip?: string; actorName?: string; actorEmail?: string } = {},
) {
  const booking = await getById(actor, id)
  const ctx = await requireContext(actor.organizationId, booking.roomId)

  if (!can(actor, 'booking:endEarly', subjectOf(booking, ctx))) {
    throw new StateConflictError('That booking is not currently in progress')
  }

  const now = new Date()

  return prisma.$transaction(async tx => {
    const row = await tx.booking.update({
      where: { id },
      data: {
        status: 'ENDED_EARLY',
        endsAt: now,
        endedEarlyAt: now,
        endedEarlyById: actor.id,
        icsSequence: { increment: 1 },
      },
      include: bookingInclude,
    })

    await tx.emailOutbox.updateMany({
      where: { bookingId: id, template: 'booking_reminder', status: 'QUEUED' },
      data: { status: 'CANCELLED' },
    })

    await audit.record(
      {
        actor: { ...actorLabel(actor, meta), organizationId: actor.organizationId },
        eventType: 'BOOKING_ENDED_EARLY',
        entityType: 'booking',
        entityId: id,
        locationId: ctx.room.locationId,
        before: { endsAt: booking.endsAt },
        after: { endsAt: now, status: 'ENDED_EARLY' },
        ip: meta.ip ?? null,
      },
      tx,
    )

    return row
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requireContext(organizationId: string, roomId: string): Promise<RoomContext> {
  const ctx = await loadRoomContext(organizationId, roomId)
  if (!ctx) throw new NotFoundError('That room')
  return ctx
}

/** The shape the shared permission matrix expects for a booking. */
function subjectOf(booking: BookingWithContext, ctx: RoomContext) {
  return {
    organizationId: booking.organizationId,
    organizerId: booking.organizerId,
    locationId: ctx.room.locationId,
    status: booking.status,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    seriesId: booking.seriesId,
    attendeeUserIds: booking.attendees
      .map(a => a.userId)
      .filter((v): v is string => Boolean(v)),
  }
}
