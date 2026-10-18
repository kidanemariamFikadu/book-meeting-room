/**
 * The error envelope, shared so the client parses exactly what the server sends.
 *
 * Specification: docs/05-api-spec.md section 1.
 */

import type { ErrorCode } from './enums.js'

export interface ConflictDetail {
  id: string
  startsAt: string
  endsAt: string
  /** Omitted or "Busy" when the viewer may not see the title (BR-P3). */
  title?: string
  organizer?: string
}

/** One date in a recurring series that could not be booked (docs/12 §4). */
export interface SeriesConflictDetail {
  occurrenceStartLocal: string
  reason: 'BOOKING_CONFLICT' | 'CLOSURE_CONFLICT' | 'HOLIDAY' | 'NON_EXISTENT_LOCAL_TIME' | 'RULE_VIOLATION'
  detail?: string
  conflictingTitle?: string
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode
    message: string
    details?: {
      /** Field path to message, for a 422 — maps straight onto a form. */
      fields?: Record<string, string>
      /** Which business rule was violated, e.g. "BR-V8". */
      rule?: string
      conflicts?: ConflictDetail[]
      seriesConflicts?: SeriesConflictDetail[]
      suggestions?: unknown
      /** Bookings blocking a room or user deactivation (BR-R4, BR-U5). */
      futureBookings?: ConflictDetail[]
      requestId?: string
    }
  }
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false
  const err = (value as { error?: unknown }).error
  if (typeof err !== 'object' || err === null) return false
  const { code, message } = err as { code?: unknown; message?: unknown }
  return typeof code === 'string' && typeof message === 'string'
}

/** The HTTP status each code is returned with. Single source of truth. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  RULE_VIOLATION: 422,
  SERIES_SCOPE_REQUIRED: 422,
  RECURRENCE_LIMIT: 422,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  LOCATION_FORBIDDEN: 403,
  CSRF_FAILED: 403,
  NOT_FOUND: 404,
  BOOKING_CONFLICT: 409,
  CLOSURE_CONFLICT: 409,
  ROOM_INACTIVE: 409,
  STATE_CONFLICT: 409,
  SERIES_CONFLICT: 409,
  ROOM_NAME_TAKEN: 409,
  CALENDAR_NEEDS_REAUTH: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
}
