/**
 * Booking request schemas.
 *
 * These are imported by BOTH sides: the Express handler parses the request body
 * with them, and the React form validates against the same object via
 * `zodResolver`. Change a field here and TypeScript fails the build everywhere
 * that needs updating — which is the main reason this is a monorepo.
 *
 * Specification: docs/05-api-spec.md section 5.
 */

import { z } from 'zod'
import {
  CONFLICT_STRATEGIES,
  EDIT_SCOPES,
  RECURRENCE_FREQUENCIES,
  WEEKDAYS,
} from '../enums.js'

/** ISO-8601 with an explicit offset. The API never accepts a naive timestamp. */
export const isoInstant = z
  .string()
  .datetime({ offset: true })
  .describe('ISO-8601 with explicit offset, e.g. 2026-11-04T09:00:00+03:00')

/** Local wall clock, `YYYY-MM-DDTHH:mm` — what a recurrence rule starts from. */
export const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Expected YYYY-MM-DDTHH:mm')

export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

export const uuid = z.string().uuid()

/**
 * An admin's stated reason. Required for a move or a cancellation of someone
 * else's booking, and quoted verbatim to the organizer (BR-M5).
 */
export const reason = z
  .string()
  .trim()
  .min(3, 'Please give a reason of at least 3 characters')
  .max(500, 'Reason must be 500 characters or fewer')

export const attendeeInput = z
  .object({
    userId: uuid.optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    displayName: z.string().trim().max(120).optional(),
  })
  .strict()
  .refine(a => a.userId !== undefined || a.email !== undefined, {
    message: 'An attendee needs either a userId or an email address',
  })

export const recurrenceInput = z
  .object({
    freq: z.enum(RECURRENCE_FREQUENCIES),
    interval: z.number().int().min(1).max(52).default(1),
    /** Required for WEEKLY; for MONTHLY it selects "first Monday"-style rules. */
    byDay: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional(),
    byMonthDay: z.number().int().min(1).max(31).optional(),
    /** Which occurrence of the weekday in the month, e.g. 1 = first, -1 = last. */
    bySetPos: z.number().int().min(-1).max(5).optional(),
    count: z.number().int().min(2).max(500).optional(),
    until: localDate.optional(),
  })
  .strict()
  .refine(r => !(r.count !== undefined && r.until !== undefined), {
    message: 'Give either an occurrence count or an end date, not both',
    path: ['until'],
  })
  .refine(r => r.freq !== 'WEEKLY' || (r.byDay?.length ?? 0) > 0, {
    message: 'Choose at least one weekday',
    path: ['byDay'],
  })

const bookingCore = {
  roomId: uuid,
  title: z.string().trim().min(1, 'A title is required').max(200),
  description: z.string().trim().max(5000).optional(),
  isPrivate: z.boolean().default(false),
  attendees: z.array(attendeeInput).max(100).default([]),
  /** Admin only — books on behalf of another employee (US-M7). */
  organizerId: uuid.optional(),
  /** Gated by org_settings.notifyAttendees in v1 (D6). */
  notifyAttendees: z.boolean().optional(),
  /** Shown to the approver for rooms that require approval (docs/15). */
  approvalNote: z.string().trim().max(500).optional(),
}

/**
 * Create a single booking.
 *
 * `.strict()` is deliberate: unknown keys are rejected rather than ignored, so
 * a client cannot smuggle a field the server does not expect (mass assignment).
 */
export const createBookingSchema = z
  .object({
    ...bookingCore,
    startsAt: isoInstant,
    endsAt: isoInstant,
    recurrence: recurrenceInput.optional(),
    conflictStrategy: z.enum(CONFLICT_STRATEGIES).default('SKIP'),
  })
  .strict()
  .refine(b => new Date(b.startsAt).getTime() < new Date(b.endsAt).getTime(), {
    message: 'The end time must be after the start time',
    path: ['endsAt'],
  })

export type CreateBookingInput = z.infer<typeof createBookingSchema>

/** Dry run for a recurring series — returns which dates clash (docs/12 §4). */
export const previewSeriesSchema = z
  .object({
    roomId: uuid,
    startsAtLocal: localDateTime,
    durationMinutes: z.number().int().min(5).max(1440),
    timezone: z.string().min(1),
    recurrence: recurrenceInput,
  })
  .strict()

export type PreviewSeriesInput = z.infer<typeof previewSeriesSchema>

/** Edit title, description, attendees or privacy. Not the room or the time. */
export const updateBookingSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    isPrivate: z.boolean().optional(),
    attendees: z.array(attendeeInput).max(100).optional(),
    notifyAttendees: z.boolean().optional(),
    /** Required when the actor is not the organizer. */
    reason: reason.optional(),
    /** Required when the booking belongs to a series (docs/12 §5). */
    scope: z.enum(EDIT_SCOPES).optional(),
  })
  .strict()
  .refine(b => Object.keys(b).length > 0, { message: 'Nothing to change' })

export type UpdateBookingInput = z.infer<typeof updateBookingSchema>

/**
 * The admin action: change the room and/or the time (US-M3, US-M4).
 * A reason is mandatory and is emailed to the organizer verbatim.
 */
export const moveBookingSchema = z
  .object({
    roomId: uuid.optional(),
    startsAt: isoInstant.optional(),
    endsAt: isoInstant.optional(),
    reason,
    notifyAttendees: z.boolean().optional(),
    scope: z.enum(EDIT_SCOPES).optional(),
    conflictStrategy: z.enum(CONFLICT_STRATEGIES).optional(),
  })
  .strict()
  .refine(m => m.roomId !== undefined || m.startsAt !== undefined || m.endsAt !== undefined, {
    message: 'A move must change the room, the time, or both',
  })
  .refine(m => (m.startsAt === undefined) === (m.endsAt === undefined), {
    message: 'Give both a start and an end time, or neither',
    path: ['endsAt'],
  })
  .refine(
    m =>
      m.startsAt === undefined ||
      m.endsAt === undefined ||
      new Date(m.startsAt).getTime() < new Date(m.endsAt).getTime(),
    { message: 'The end time must be after the start time', path: ['endsAt'] },
  )

export type MoveBookingInput = z.infer<typeof moveBookingSchema>

export const cancelBookingSchema = z
  .object({
    /** Mandatory for an admin cancelling someone else's booking (BR-M5). */
    reason: reason.optional(),
    notifyAttendees: z.boolean().optional(),
    scope: z.enum(EDIT_SCOPES).optional(),
  })
  .strict()

export type CancelBookingInput = z.infer<typeof cancelBookingSchema>

/** D3 — release an in-progress booking. Truncates rather than erases (BR-M2a). */
export const endEarlySchema = z.object({ reason: reason.optional() }).strict()

export const transferBookingSchema = z.object({ organizerId: uuid, reason }).strict()

export const approveBookingSchema = z
  .object({
    /** Approve and move in one action — the common real outcome (BR-A14). */
    moveToRoomId: uuid.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict()

export const rejectBookingSchema = z.object({ reason }).strict()

/** Availability and calendar-grid query (docs/05 §4). */
export const availabilityQuerySchema = z
  .object({
    date: localDate.optional(),
    from: isoInstant.optional(),
    to: isoInstant.optional(),
    locationId: uuid.optional(),
    roomIds: z.array(uuid).max(200).optional(),
    minCapacity: z.coerce.number().int().min(1).max(1000).optional(),
    features: z.array(uuid).max(20).optional(),
  })
  .strict()
  .refine(q => q.date !== undefined || (q.from !== undefined && q.to !== undefined), {
    message: 'Give either a date or a from/to range',
  })
  .refine(
    q =>
      q.from === undefined ||
      q.to === undefined ||
      // A 31-day cap keeps an unbounded range from scanning the whole table.
      new Date(q.to).getTime() - new Date(q.from).getTime() <= 31 * 24 * 3600 * 1000,
    { message: 'A range may span at most 31 days', path: ['to'] },
  )

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>
