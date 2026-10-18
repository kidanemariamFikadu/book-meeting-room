/**
 * The single place errors become responses.
 *
 * Content-negotiates: a JSON envelope for the API, an HTML page for a display
 * view. Unexpected errors are logged with their stack and the request ID, while
 * the user sees a generic message plus that ID — never a stack trace.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express'
import { ZodError } from 'zod'

import { config } from '../config.js'
import { AppError, InternalError, NotFoundError, RateLimitError, ValidationError } from '../domain/errors.js'

const wantsJson = (path: string) => path.startsWith('/api/')

/** Turns a Zod failure into field-keyed messages a form can display directly. */
function fromZod(error: ZodError): ValidationError {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_'
    // Keep the first message per field: a stack of messages on one input is
    // noise, and the first is the most specific.
    fields[key] ??= issue.message
  }
  return new ValidationError('Some of the information provided is not valid', fields)
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(wantsJson(req.path) ? 'That endpoint' : 'That page'))
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    // The response is already on the wire; let Express tear down the socket
    // rather than attempting to write a second set of headers.
    next(err)
    return
  }

  const appError =
    err instanceof AppError
      ? err
      : err instanceof ZodError
        ? fromZod(err)
        : new InternalError()

  const requestId = req.id

  if (!appError.expected) {
    req.log?.error({ err, requestId }, 'Unhandled error')
  } else if (appError.status >= 500) {
    req.log?.error({ err, requestId, code: appError.code }, appError.message)
  } else {
    req.log?.warn({ requestId, code: appError.code, status: appError.status }, appError.message)
  }

  if (appError instanceof RateLimitError) {
    res.setHeader('Retry-After', String(appError.retryAfterSeconds))
  }

  res.status(appError.status)

  if (wantsJson(req.path)) {
    res.json(appError.toBody(requestId))
    return
  }

  // Display views and any non-API path get plain HTML. Deliberately minimal
  // and dependency-free: an error page that needs the app to work is useless.
  const detail = config.isProduction ? '' : `<p class="id">${escapeHtml(appError.message)}</p>`
  res.type('html').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${appError.status} - RoomBook</title><style>` +
      `body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;` +
      `background:#0f172a;color:#e8eaf0;text-align:center;padding:24px}h1{font-size:48px;margin:0}` +
      `p{color:#9aa3b2;max-width:40ch}.id{font-family:ui-monospace,monospace;font-size:12px}` +
      `</style></head><body><div><h1>${appError.status}</h1>` +
      `<p>${escapeHtml(genericMessage(appError.status))}</p>${detail}` +
      `<p class="id">Reference: ${escapeHtml(requestId ?? 'unknown')}</p></div></body></html>`,
  )
}

function genericMessage(status: number): string {
  if (status === 404) return 'That page could not be found.'
  if (status === 403) return 'You do not have access to that.'
  if (status === 429) return 'Too many requests. Please wait a moment.'
  return 'Something went wrong. Please try again.'
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
