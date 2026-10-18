/**
 * Recurring meetings.
 *
 * Occurrences are MATERIALIZED as ordinary booking rows rather than computed
 * on demand. That is the decision the rest of this file follows from: the
 * exclusion constraint protects a recurring booking exactly as it protects a
 * single one, conflict detection and the calendar grid need no special cases,
 * and moving one occurrence is just updating one row.
 *
 * The cost is a horizon, rolled forward nightly.
 *
 * Specification: docs/12-recurrence.md.
 */

import { Prisma, type BookingStatus } from '@prisma/client'
import {
  OCCUPYING_BOOKING_STATUSES,
  can,
  describeRule,
  expand,
  parseRruleText,
  toRruleText,
  type Actor,
  type EditScope,
  type Occurrence,
  type RecurrenceRule,
} from '@roombook/shared'

import { randomUUID } from 'node:crypto'

import { config } from '../config.js'
import { prisma } from '../db.js'
import {
  AuthorizationError,
  NotFoundError,
  RecurrenceLimitError,
  RoomInactiveError,
  RuleViolationError,
  SeriesConflictError,
  StateConflictError,
  ValidationError,
} from '../domain/errors.js'
import { effectiveLimits, validateBookingRules } from '../domain/rules.js'
import * as audit from './AuditService.js'
import { loadRoomContext, type RoomContext } from './AvailabilityService.js'

export interface SeriesInput {
  roomId: string
  title: string
  description?: string
  isPrivate?: boolean
  /** Local wall clock, `YYYY-MM-DDTHH:mm`, in the room's timezone. */
  startsAtLocal: string
  durationMinutes: number
  recurrence: RecurrenceRule
  organizerId?: string
}

export type ConflictReason =
  | 'BOOKING_CONFLICT'
  | 'CLOSURE_CONFLICT'
  | 'HOLIDAY'
  | 'NON_EXISTENT_LOCAL_TIME'
  | 'RULE_VIOLATION'

export interface OccurrenceConflict {
  occurrenceStartLocal: string
  reason: ConflictReason
  detail?: string
  conflictingTitle?: string
}

export interface SeriesPreview {
  description: string
  totalOccurrences: number
  available: number
  firstOccurrence: string | null
  lastOccurrence: string | null
  conflicts: OccurrenceConflict[]
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * A dry run.
 *
 * Read-only and deliberately separate from creation, because a series that
 * silently skipped three weeks is a meeting people miss. The user is shown
 * exactly which dates are unavailable and decides what to do (docs/12 §4).
 */
export async function preview(actor: Actor, input: SeriesInput): Promise<SeriesPreview> {
  const ctx = await requireRoom(actor.organizationId, input.roomId)
  const settings = await orgLimits(actor.organizationId)

  const expansion = expandFor(input, ctx, settings)

  const conflicts: OccurrenceConflict[] = expansion.skipped.map(s => ({
    occurrenceStartLocal: s.occurrenceStartLocal,
    reason: 'NON_EXISTENT_LOCAL_TIME' as const,
    detail: 'The clocks change, so this time does not exist on that date',
  }))

  const { available } = await classifyOccurrences(ctx, expansion.occurrences, conflicts)

  const locals = expansion.occurrences.map(o => o.occurrenceStartLocal)

  return {
    description: describeRule(input.recurrence, input.startsAtLocal),
    totalOccurrences: expansion.occurrences.length + expansion.skipped.length,
    available: available.length,
    firstOccurrence: locals[0] ?? null,
    lastOccurrence: locals.at(-1) ?? null,
    conflicts: conflicts.sort((a, b) =>
      a.occurrenceStartLocal.localeCompare(b.occurrenceStartLocal),
    ),
    truncated: expansion.truncated,
  }
}

/**
 * Splits occurrences into those that can be booked and those that cannot,
 * appending a reason for each refusal.
 *
 * All existing bookings and closures for the room across the whole span are
 * fetched ONCE and compared in memory. Querying per occurrence would be 52
 * round trips to preview a yearly series.
 */
async function classifyOccurrences(
  ctx: RoomContext,
  occurrences: Occurrence[],
  conflicts: OccurrenceConflict[],
): Promise<{ available: Occurrence[] }> {
  if (occurrences.length === 0) return { available: [] }

  const first = occurrences[0]!.start
  const last = occurrences.at(-1)!.end

  const [existing, closures] = await Promise.all([
    prisma.booking.findMany({
      where: {
        roomId: ctx.room.id,
        status: { in: [...OCCUPYING_BOOKING_STATUSES] },
        startsAt: { lt: last },
        endsAt: { gt: first },
      },
      select: { title: true, startsAt: true, endsAt: true, isPrivate: true },
    }),
    prisma.roomClosure.findMany({
      where: { roomId: ctx.room.id, startsAt: { lt: last }, endsAt: { gt: first } },
      select: { reason: true, startsAt: true, endsAt: true },
    }),
  ])

  const limits = effectiveLimits(ctx.settings)
  const available: Occurrence[] = []

  for (const occurrence of occurrences) {
    // The same rule set a single booking goes through: hours, duration,
    // holidays. An occurrence inside a closed building is not bookable even
    // though no booking occupies it.
    const failure = validateBookingRules({
      interval: { start: occurrence.start, end: occurrence.end },
      limits,
      timeZone: ctx.timeZone,
      roomHours: ctx.roomHours,
      locationHours: ctx.locationHours,
      orgHours: ctx.orgHours,
      holidays: ctx.holidays,
      now: new Date(),
      // The advance window is checked against the series as a whole, not each
      // occurrence: a year-long series is the point, not a violation.
      overrideWindows: true,
    })

    if (failure) {
      conflicts.push({
        occurrenceStartLocal: occurrence.occurrenceStartLocal,
        reason: failure.rule === 'BR-V8' && ctx.holidays.size > 0 ? 'HOLIDAY' : 'RULE_VIOLATION',
        detail: failure.message,
      })
      continue
    }

    const closure = closures.find(
      c => c.startsAt < occurrence.end && c.endsAt > occurrence.start,
    )
    if (closure) {
      conflicts.push({
        occurrenceStartLocal: occurrence.occurrenceStartLocal,
        reason: 'CLOSURE_CONFLICT',
        detail: closure.reason,
      })
      continue
    }

    const clash = existing.find(b => b.startsAt < occurrence.end && b.endsAt > occurrence.start)
    if (clash) {
      conflicts.push({
        occurrenceStartLocal: occurrence.occurrenceStartLocal,
        reason: 'BOOKING_CONFLICT',
        // A private booking is not named, even here (BR-P3).
        conflictingTitle: clash.isPrivate ? 'Busy' : clash.title,
      })
      continue
    }

    available.push(occurrence)
  }

  return { available }
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export type ConflictStrategy = 'SKIP' | 'FAIL'

export interface CreateSeriesResult {
  seriesId: string
  created: number
  skipped: OccurrenceConflict[]
  description: string
}

export async function createSeries(
  actor: Actor,
  input: SeriesInput,
  strategy: ConflictStrategy,
  meta: { ip?: string; actorName?: string; actorEmail?: string } = {},
): Promise<CreateSeriesResult> {
  const ctx = await requireRoom(actor.organizationId, input.roomId)
  if (!ctx.room.isActive) throw new RoomInactiveError()

  // An approval-required room and a recurring series together would mean one
  // decision admitting a year of bookings. Supported, but out of scope for
  // this milestone, so it is refused rather than half-working (BR-A12).
  if (ctx.room.requiresApproval) {
    throw new RuleViolationError(
      'BR-A12',
      'That room needs approval, which is not yet supported for recurring meetings. Book the occurrences individually, or choose another room.',
    )
  }

  let organizerId = actor.id
  if (input.organizerId && input.organizerId !== actor.id) {
    if (
      !can(actor, 'booking:createForOther', {
        organizationId: actor.organizationId,
        locationId: ctx.room.locationId,
      })
    ) {
      throw new AuthorizationError('Only an admin can book on behalf of someone else')
    }
    organizerId = input.organizerId
  }

  const settings = await orgLimits(actor.organizationId)
  const expansion = expandFor(input, ctx, settings)

  if (expansion.occurrences.length === 0) {
    throw new ValidationError('That rule produces no bookable dates', {
      recurrence: 'No occurrences',
    })
  }
  if (expansion.truncated && expansion.occurrences.length >= settings.maxOccurrences) {
    throw new RecurrenceLimitError(
      `A series may contain at most ${settings.maxOccurrences} meetings. Set an end date or a count.`,
    )
  }

  const conflicts: OccurrenceConflict[] = expansion.skipped.map(s => ({
    occurrenceStartLocal: s.occurrenceStartLocal,
    reason: 'NON_EXISTENT_LOCAL_TIME' as const,
  }))
  const { available } = await classifyOccurrences(ctx, expansion.occurrences, conflicts)

  // FAIL is all-or-nothing; SKIP creates what it can and reports the rest.
  if (strategy === 'FAIL' && conflicts.length > 0) {
    throw new SeriesConflictError(conflicts)
  }
  if (available.length === 0) {
    throw new SeriesConflictError(conflicts)
  }

  const rruleText = toRruleText(input.recurrence)
  const horizonUntil = available.at(-1)!.start

  const seriesId = await prisma.$transaction(async tx => {
    const series = await tx.bookingSeries.create({
      data: {
        organizationId: actor.organizationId,
        roomId: ctx.room.id,
        organizerId,
        title: input.title.trim(),
        description: input.description?.trim() ?? null,
        isPrivate: input.isPrivate ?? false,
        rrule: rruleText,
        dtstartLocal: input.startsAtLocal,
        durationMinutes: input.durationMinutes,
        timezone: ctx.timeZone,
        horizonUntil,
        status: 'ACTIVE',
      },
    })

    await tx.booking.createMany({
      data: available.map(o => ({
        organizationId: actor.organizationId,
        roomId: ctx.room.id,
        organizerId,
        createdById: actor.id,
        title: input.title.trim(),
        description: input.description?.trim() ?? null,
        startsAt: o.start,
        endsAt: o.end,
        status: 'CONFIRMED' as BookingStatus,
        isPrivate: input.isPrivate ?? false,
        seriesId: series.id,
        // The RECURRENCE-ID. Never changes, even when the occurrence moves.
        occurrenceStartLocal: o.occurrenceStartLocal,
        isException: false,
        exceptionFields: [],
        /*
         * Each ROW needs its own uid, because the column is unique — sharing
         * one silently dropped every occurrence but the first, since
         * createMany treats them as duplicates.
         *
         * The uid a calendar client sees is the SERIES uid, derived from the
         * series id when the invitation is built. That is what makes a client
         * treat the occurrences as one recurring event, and it is also what
         * RECURRENCE-ID anchors against.
         */
        icsUid: `${randomUUID()}@roombook`,
      })),
      // A race on one occurrence must not lose the whole series; the
      // constraint rejects just that row.
      skipDuplicates: true,
    })

    await audit.record(
      {
        actor: {
          id: actor.id,
          fullName: meta.actorName,
          email: meta.actorEmail,
          organizationId: actor.organizationId,
        },
        eventType: 'SERIES_CREATED',
        entityType: 'series',
        entityId: series.id,
        locationId: ctx.room.locationId,
        after: {
          title: input.title,
          rrule: rruleText,
          occurrences: available.length,
          skipped: conflicts.length,
        },
        ip: meta.ip ?? null,
      },
      tx,
    )

    await queueSeriesEmail(tx, {
      organizationId: actor.organizationId,
      seriesId: series.id,
      template: 'series_confirmed',
      organizerId,
      payload: {
        title: input.title.trim(),
        room: ctx.room.name,
        location: ctx.room.location.name,
        timeZone: ctx.timeZone,
        pattern: describeRule(input.recurrence, input.startsAtLocal),
        firstOccurrence: available[0]!.start.toISOString(),
        lastOccurrence: available.at(-1)!.start.toISOString(),
        occurrenceCount: available.length,
        skipped: conflicts.map(c => ({
          date: c.occurrenceStartLocal.slice(0, 10),
          reason: c.conflictingTitle ?? c.detail ?? c.reason,
        })),
        url: `${config.APP_URL}/series/${series.id}`,
      },
    })

    return series.id
  })

  return {
    seriesId,
    created: available.length,
    skipped: conflicts,
    description: describeRule(input.recurrence, input.startsAtLocal),
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getSeries(actor: Actor, id: string) {
  const series = await prisma.bookingSeries.findFirst({
    where: { id, organizationId: actor.organizationId },
    include: {
      room: {
        select: {
          id: true,
          name: true,
          colour: true,
          locationId: true,
          location: { select: { id: true, name: true, timezone: true } },
        },
      },
      organizer: { select: { id: true, fullName: true, email: true } },
    },
  })
  if (!series) throw new NotFoundError('That series')

  const occurrences = await prisma.booking.findMany({
    where: { seriesId: id },
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      status: true,
      isException: true,
      exceptionFields: true,
      occurrenceStartLocal: true,
      cancellationReason: true,
      room: { select: { id: true, name: true } },
    },
    orderBy: { startsAt: 'asc' },
  })

  const now = Date.now()

  return {
    ...series,
    pattern: describeRule(parseRruleText(series.rrule), series.dtstartLocal),
    occurrences,
    counts: {
      total: occurrences.length,
      upcoming: occurrences.filter(
        o => o.startsAt.getTime() > now && o.status === 'CONFIRMED',
      ).length,
      cancelled: occurrences.filter(o => o.status === 'CANCELLED').length,
      exceptions: occurrences.filter(o => o.isException).length,
    },
  }
}

// ---------------------------------------------------------------------------
// Cancelling
// ---------------------------------------------------------------------------

export interface ScopedResult {
  scope: EditScope
  affected: number
}

/**
 * Cancels part or all of a series.
 *
 * Past occurrences are never touched, whatever the scope: they record what
 * actually happened (BR-M1).
 */
export async function cancelScoped(
  actor: Actor,
  bookingId: string,
  scope: EditScope,
  reason: string | undefined,
  meta: { ip?: string; actorName?: string; actorEmail?: string } = {},
): Promise<ScopedResult> {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, organizationId: actor.organizationId },
    include: {
      series: true,
      room: {
        select: {
          name: true,
          locationId: true,
          location: { select: { name: true, timezone: true } },
        },
      },
      organizer: { select: { id: true, email: true, fullName: true } },
    },
  })
  if (!booking) throw new NotFoundError('That booking')
  if (!booking.seriesId || !booking.series) {
    throw new ValidationError('That booking is not part of a series')
  }

  const subject = {
    organizationId: booking.organizationId,
    organizerId: booking.organizerId,
    locationId: booking.room.locationId,
    status: booking.status,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    seriesId: booking.seriesId,
  }

  if (!can(actor, 'series:cancel', subject)) {
    throw new AuthorizationError('You cannot change this series')
  }

  const isOwn = booking.organizerId === actor.id
  if (!isOwn && (!reason || reason.trim().length < 3)) {
    throw new ValidationError('Please give a reason, which is shown to the organizer', {
      reason: 'A reason is required',
    })
  }

  const now = new Date()

  // Which rows the scope covers. Past occurrences are excluded in every case.
  const where: Prisma.BookingWhereInput =
    scope === 'THIS_OCCURRENCE'
      ? { id: bookingId }
      : {
          seriesId: booking.seriesId,
          status: { in: ['CONFIRMED', 'PENDING_APPROVAL'] },
          startsAt:
            scope === 'THIS_AND_FOLLOWING' ? { gte: booking.startsAt } : { gt: now },
        }

  if (scope === 'THIS_OCCURRENCE' && booking.endsAt.getTime() <= now.getTime()) {
    throw new StateConflictError('That meeting has already finished')
  }

  const result = await prisma.$transaction(async tx => {
    const targets = await tx.booking.findMany({ where, select: { id: true } })

    const { count } = await tx.booking.updateMany({
      where: { id: { in: targets.map(t => t.id) } },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancelledById: actor.id,
        cancellationReason: reason?.trim() ?? null,
        icsSequence: { increment: 1 },
        // A cancelled single occurrence is itself the exception record.
        ...(scope === 'THIS_OCCURRENCE' ? { isException: true } : {}),
      },
    })

    // No reminder may fire for a meeting that will not happen (BR-M9).
    await tx.emailOutbox.updateMany({
      where: {
        bookingId: { in: targets.map(t => t.id) },
        template: 'booking_reminder',
        status: 'QUEUED',
      },
      data: { status: 'CANCELLED' },
    })

    // THIS_AND_FOLLOWING ends the rule here, so the nightly horizon roll does
    // not recreate what was just cancelled.
    if (scope === 'THIS_AND_FOLLOWING') {
      const untilDate = new Date(booking.startsAt.getTime() - 86_400_000)
      await tx.bookingSeries.update({
        where: { id: booking.seriesId! },
        data: {
          rrule: withUntil(booking.series!.rrule, untilDate),
          horizonUntil: untilDate,
          status: 'ENDED',
        },
      })
    } else if (scope === 'ENTIRE_SERIES') {
      await tx.bookingSeries.update({
        where: { id: booking.seriesId! },
        data: { status: 'CANCELLED' },
      })
    }

    await audit.record(
      {
        actor: {
          id: actor.id,
          fullName: meta.actorName,
          email: meta.actorEmail,
          organizationId: actor.organizationId,
        },
        eventType: scope === 'THIS_OCCURRENCE' ? 'BOOKING_CANCELLED' : 'SERIES_CANCELLED',
        entityType: scope === 'THIS_OCCURRENCE' ? 'booking' : 'series',
        entityId: scope === 'THIS_OCCURRENCE' ? bookingId : booking.seriesId!,
        locationId: booking.room.locationId,
        after: { scope, cancelled: count },
        reason: reason?.trim() ?? null,
        ip: meta.ip ?? null,
      },
      tx,
    )

    /*
     * ONE email, not one per occurrence.
     *
     * A 52-week series cancelled wholesale must not produce 52 messages;
     * nobody would use a system that did that (docs/12 §7).
     */
    await queueSeriesEmail(tx, {
      organizationId: booking.organizationId,
      seriesId: booking.seriesId!,
      bookingId: scope === 'THIS_OCCURRENCE' ? bookingId : null,
      template: scope === 'THIS_OCCURRENCE' ? 'occurrence_cancelled' : 'series_cancelled',
      organizerId: booking.organizerId,
      payload: {
        title: booking.title,
        room: booking.room.name,
        location: booking.room.location.name,
        timeZone: booking.room.location.timezone,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        organizer: booking.organizer.fullName,
        scope,
        occurrenceCount: count,
        reason: reason?.trim() ?? null,
        cancelledBy: isOwn ? null : (meta.actorName ?? 'An administrator'),
        url: `${config.APP_URL}/series/${booking.seriesId}`,
      },
    })

    return count
  })

  return { scope, affected: result }
}

// ---------------------------------------------------------------------------
// Horizon
// ---------------------------------------------------------------------------

export interface HorizonResult {
  seriesExtended: number
  occurrencesAdded: number
}

/**
 * Rolls open-ended series forward.
 *
 * Materializing occurrences means they exist only so far ahead; this keeps the
 * window full. Only series whose horizon is within 30 days are touched, so the
 * nightly pass is cheap however many series exist.
 */
export async function rollHorizon(now = new Date()): Promise<HorizonResult> {
  const settings = await prisma.orgSettings.findMany({
    select: { organizationId: true, recurrenceHorizonDays: true, maxOccurrencesPerSeries: true },
  })

  let seriesExtended = 0
  let occurrencesAdded = 0

  for (const org of settings) {
    const target = new Date(now.getTime() + org.recurrenceHorizonDays * 86_400_000)

    const due = await prisma.bookingSeries.findMany({
      where: {
        organizationId: org.organizationId,
        status: 'ACTIVE',
        horizonUntil: { lt: new Date(target.getTime() - 30 * 86_400_000) },
      },
      include: { room: true },
      take: 50,
    })

    for (const series of due) {
      const ctx = await loadRoomContext(org.organizationId, series.roomId)
      if (!ctx || !ctx.room.isActive) continue

      const existing = await prisma.booking.count({ where: { seriesId: series.id } })
      if (existing >= org.maxOccurrencesPerSeries) continue

      const expansion = expand(parseRruleText(series.rrule), {
        dtstartLocal: series.dtstartLocal,
        durationMinutes: series.durationMinutes,
        timeZone: series.timezone,
        horizonUntil: target,
        maxOccurrences: org.maxOccurrencesPerSeries,
      })

      // Only occurrences beyond the current horizon, and only those not
      // already present — a cancelled occurrence must not be resurrected.
      const alreadyThere = new Set(
        (
          await prisma.booking.findMany({
            where: { seriesId: series.id },
            select: { occurrenceStartLocal: true },
          })
        ).map(r => r.occurrenceStartLocal),
      )

      const fresh = expansion.occurrences.filter(
        o => !alreadyThere.has(o.occurrenceStartLocal) && o.start > series.horizonUntil,
      )

      const conflicts: OccurrenceConflict[] = []
      const { available } = await classifyOccurrences(ctx, fresh, conflicts)

      if (available.length > 0) {
        await prisma.booking.createMany({
          data: available.map(o => ({
            organizationId: series.organizationId,
            roomId: series.roomId,
            organizerId: series.organizerId,
            createdById: series.organizerId,
            title: series.title,
            description: series.description,
            startsAt: o.start,
            endsAt: o.end,
            status: 'CONFIRMED' as BookingStatus,
            isPrivate: series.isPrivate,
            seriesId: series.id,
            occurrenceStartLocal: o.occurrenceStartLocal,
            isException: false,
            exceptionFields: [],
            icsUid: `${randomUUID()}@roombook`,
          })),
          skipDuplicates: true,
        })
        occurrencesAdded += available.length
      }

      const newHorizon = available.at(-1)?.start ?? target
      await prisma.bookingSeries.update({
        where: { id: series.id },
        data: {
          horizonUntil: newHorizon,
          // A rule that has run out stops being rolled.
          ...(expansion.occurrences.length === 0 || !expansion.truncated
            ? { status: expansion.occurrences.length === 0 ? 'ENDED' : 'ACTIVE' }
            : {}),
        },
      })
      seriesExtended++
    }
  }

  return { seriesExtended, occurrencesAdded }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requireRoom(organizationId: string, roomId: string): Promise<RoomContext> {
  const ctx = await loadRoomContext(organizationId, roomId)
  if (!ctx) throw new NotFoundError('That room')
  return ctx
}

async function orgLimits(organizationId: string) {
  const settings = await prisma.orgSettings.findUnique({ where: { organizationId } })
  return {
    horizonDays: settings?.recurrenceHorizonDays ?? config.RECURRENCE_HORIZON_DAYS,
    maxOccurrences: settings?.maxOccurrencesPerSeries ?? config.RECURRENCE_MAX_OCCURRENCES,
  }
}

function expandFor(
  input: SeriesInput,
  ctx: RoomContext,
  settings: { horizonDays: number; maxOccurrences: number },
) {
  if (input.durationMinutes < 5 || input.durationMinutes > 1440) {
    throw new ValidationError('A meeting must be between 5 minutes and 24 hours', {
      durationMinutes: 'Out of range',
    })
  }

  return expand(input.recurrence, {
    dtstartLocal: input.startsAtLocal,
    durationMinutes: input.durationMinutes,
    timeZone: ctx.timeZone,
    horizonUntil: new Date(Date.now() + settings.horizonDays * 86_400_000),
    maxOccurrences: settings.maxOccurrences,
  })
}

/** Appends or replaces UNTIL on an RRULE, for splitting a series. */
function withUntil(rrule: string, until: Date): string {
  const stamp = `${until.toISOString().slice(0, 10).replace(/-/g, '')}T235959Z`
  const parts = rrule.split(';').filter(p => !p.startsWith('UNTIL=') && !p.startsWith('COUNT='))
  return [...parts, `UNTIL=${stamp}`].join(';')
}

/**
 * Queues exactly one email per recipient per action.
 *
 * Attendee delivery stays gated by D6, like every other notification.
 */
async function queueSeriesEmail(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string
    seriesId: string
    bookingId?: string | null
    template: string
    organizerId: string
    payload: Record<string, unknown>
  },
): Promise<void> {
  const organizer = await tx.user.findUnique({
    where: { id: input.organizerId },
    select: { email: true, fullName: true },
  })
  if (!organizer) return

  const subject = seriesSubject(input.template, input.payload)

  await tx.emailOutbox.create({
    data: {
      organizationId: input.organizationId,
      seriesId: input.seriesId,
      bookingId: input.bookingId ?? null,
      template: input.template,
      toEmail: organizer.email,
      toName: organizer.fullName,
      subject,
      payload: input.payload as Prisma.InputJsonValue,
      // A series invitation carries an RRULE; a single-occurrence change
      // carries a RECURRENCE-ID. Both are built by the outbox worker.
      icsMethod: input.template === 'series_cancelled' ? 'CANCEL' : 'REQUEST',
    },
  })
}

function seriesSubject(template: string, payload: Record<string, unknown>): string {
  const title = String(payload.title ?? 'Meeting')
  const room = String(payload.room ?? '')
  const pattern = String(payload.pattern ?? '')

  switch (template) {
    case 'series_confirmed':
      return `Confirmed: ${title} - ${pattern}`
    case 'series_cancelled':
      return `Cancelled: all remaining ${title} meetings`
    case 'occurrence_cancelled':
      return `Cancelled: ${title} on one date only`
    case 'occurrence_moved':
      return `Moved: ${title} on one date only`
    default:
      return `${title} - ${room}`
  }
}
