/**
 * The error hierarchy.
 *
 * Services throw these; one middleware turns them into responses. That is what
 * keeps route handlers free of error-shaping code and lets services be reused
 * by the background workers, which have no `res` to write to.
 *
 * Specification: docs/02-architecture.md section 5.
 */

import { ERROR_STATUS, type ApiErrorBody, type ErrorCode } from '@roombook/shared'

type Details = NonNullable<ApiErrorBody['error']['details']>

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: Details
  /** True for errors that are part of normal operation and need no alert. */
  readonly expected: boolean

  constructor(code: ErrorCode, message: string, details?: Details, expected = true) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.status = ERROR_STATUS[code]
    this.details = details
    this.expected = expected
    Error.captureStackTrace?.(this, new.target)
  }

  toBody(requestId?: string): ApiErrorBody {
    const details = requestId ? { ...this.details, requestId } : this.details
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(details && Object.keys(details).length > 0 ? { details } : {}),
      },
    }
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Some of the information provided is not valid', fields?: Record<string, string>) {
    super('VALIDATION_FAILED', message, fields ? { fields } : undefined)
  }
}

/** Valid input that breaks a business rule. `rule` names the ID, e.g. BR-V8. */
export class RuleViolationError extends AppError {
  constructor(rule: string, message: string) {
    super('RULE_VIOLATION', message, { rule })
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Please sign in to continue') {
    super('UNAUTHENTICATED', message)
  }
}

/**
 * Deliberately identical for a wrong password, an unknown address and a
 * disabled account, so the endpoint cannot be used to enumerate users
 * (docs/08-security.md section 2).
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('INVALID_CREDENTIALS', 'That email address and password do not match')
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'You do not have permission to do that') {
    super('FORBIDDEN', message)
  }
}

/** A location-scoped admin acting outside their locations (BR-L1, BR-L2). */
export class LocationForbiddenError extends AppError {
  constructor(message = 'You do not administer that location') {
    super('LOCATION_FORBIDDEN', message)
  }
}

/**
 * Also used when a record exists but belongs to another organization: existence
 * itself is not disclosed, so that returns 404 rather than 403.
 */
export class NotFoundError extends AppError {
  constructor(what = 'That item') {
    super('NOT_FOUND', `${what} could not be found`)
  }
}

export class BookingConflictError extends AppError {
  constructor(conflicts: Details['conflicts'], suggestions?: unknown) {
    super('BOOKING_CONFLICT', 'That room is already booked for part of this time', {
      conflicts,
      ...(suggestions ? { suggestions } : {}),
    })
  }
}

export class ClosureConflictError extends AppError {
  constructor(reason: string) {
    super('CLOSURE_CONFLICT', `That room is closed during this time: ${reason}`)
  }
}

export class RoomInactiveError extends AppError {
  constructor() {
    super('ROOM_INACTIVE', 'That room is no longer available for booking')
  }
}

export class StateConflictError extends AppError {
  constructor(message: string) {
    super('STATE_CONFLICT', message)
  }
}

/** Some occurrences of a series clash; each date is listed (docs/12 §4). */
export class SeriesConflictError extends AppError {
  constructor(seriesConflicts: Details['seriesConflicts']) {
    super('SERIES_CONFLICT', 'Some dates in this series are not available', { seriesConflicts })
  }
}

export class SeriesScopeRequiredError extends AppError {
  constructor() {
    super(
      'SERIES_SCOPE_REQUIRED',
      'This is a repeating meeting - say whether the change applies to this occurrence, this and all following, or the entire series',
    )
  }
}

export class RecurrenceLimitError extends AppError {
  constructor(message: string) {
    super('RECURRENCE_LIMIT', message)
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number, message = 'Too many attempts - please wait and try again') {
    super('RATE_LIMITED', message)
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export class CsrfError extends AppError {
  constructor() {
    super('CSRF_FAILED', 'Your session has expired - please refresh the page and try again')
  }
}

export class InternalError extends AppError {
  constructor(message = 'Something went wrong on our side') {
    super('INTERNAL_ERROR', message, undefined, false)
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError
}
