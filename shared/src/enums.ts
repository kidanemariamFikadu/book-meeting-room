/**
 * Enumerations, mirrored from prisma/schema.prisma.
 *
 * Declared here rather than imported from `@prisma/client` so that the client
 * bundle never pulls in Prisma, and so the browser and server share one
 * definition. The `satisfies` checks at the bottom are what keep this file
 * honest: if the Prisma enum changes without this one, the server build fails.
 */

export const ROLES = ['EMPLOYEE', 'ADMIN', 'OWNER'] as const
export type Role = (typeof ROLES)[number]

/** Cumulative: OWNER ⊃ ADMIN ⊃ EMPLOYEE. Used for ordered comparisons. */
export const ROLE_RANK: Record<Role, number> = {
  EMPLOYEE: 0,
  ADMIN: 1,
  OWNER: 2,
}

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'DISABLED'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

export const BOOKING_STATUSES = [
  'PENDING_APPROVAL',
  'CONFIRMED',
  'ENDED_EARLY',
  'REJECTED',
  'CANCELLED',
] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

/**
 * The statuses that OCCUPY a room and therefore take part in conflict
 * detection. This list is the single source of truth for that question, and it
 * must stay identical to the predicate on the `bookings_no_overlap` exclusion
 * constraint in the migration. If the two ever disagree, the database and the
 * application will disagree about whether a room is free.
 *
 * PENDING_APPROVAL is included because an approval request holds its slot
 * (BR-A2). ENDED_EARLY is included because the booking really did use the room
 * up to its truncated end (BR-M2b).
 */
export const OCCUPYING_BOOKING_STATUSES = [
  'PENDING_APPROVAL',
  'CONFIRMED',
  'ENDED_EARLY',
] as const satisfies readonly BookingStatus[]

export type OccupyingBookingStatus = (typeof OCCUPYING_BOOKING_STATUSES)[number]

export function occupiesRoom(status: BookingStatus): boolean {
  return (OCCUPYING_BOOKING_STATUSES as readonly BookingStatus[]).includes(status)
}

/** A booking in a terminal state cannot be acted on further. */
export const TERMINAL_BOOKING_STATUSES = [
  'REJECTED',
  'CANCELLED',
] as const satisfies readonly BookingStatus[]

export const SERIES_STATUSES = ['ACTIVE', 'ENDED', 'CANCELLED'] as const
export type SeriesStatus = (typeof SERIES_STATUSES)[number]

/** How a change to one occurrence of a series should be applied (docs/12 §5). */
export const EDIT_SCOPES = ['THIS_OCCURRENCE', 'THIS_AND_FOLLOWING', 'ENTIRE_SERIES'] as const
export type EditScope = (typeof EDIT_SCOPES)[number]

export const RECURRENCE_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number]

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** What to do about occurrences of a new series that clash (docs/12 §4). */
export const CONFLICT_STRATEGIES = ['SKIP', 'ALTERNATIVE', 'FAIL'] as const
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number]

export const ATTENDEE_RESPONSES = ['NEEDS_ACTION', 'ACCEPTED', 'DECLINED', 'TENTATIVE'] as const
export type AttendeeResponse = (typeof ATTENDEE_RESPONSES)[number]

export const OUTBOX_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'] as const
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number]

export const CALENDAR_PROVIDERS = ['GOOGLE', 'MICROSOFT'] as const
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number]

export const CONNECTION_STATUSES = ['ACTIVE', 'NEEDS_REAUTH', 'REVOKED', 'ERROR'] as const
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]

export const TOKEN_PURPOSES = ['INVITE', 'PASSWORD_RESET', 'EMAIL_CHANGE'] as const
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number]

/** Machine-readable error codes returned by the API (docs/05-api-spec.md §1). */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'RULE_VIOLATION',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'BOOKING_CONFLICT',
  'CLOSURE_CONFLICT',
  'ROOM_INACTIVE',
  'STATE_CONFLICT',
  'SERIES_CONFLICT',
  'SERIES_SCOPE_REQUIRED',
  'RECURRENCE_LIMIT',
  'LOCATION_FORBIDDEN',
  'CALENDAR_NEEDS_REAUTH',
  'ROOM_NAME_TAKEN',
  'INVALID_CREDENTIALS',
  'RATE_LIMITED',
  'CSRF_FAILED',
  'INTERNAL_ERROR',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]
