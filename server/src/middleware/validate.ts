/**
 * Request validation.
 *
 * Parses body, query or params with a SHARED Zod schema, so a field the server
 * rejects is a field the client already rejected, with the same message.
 * The parsed value replaces the raw one, which means handlers receive typed,
 * trimmed, defaulted input and never touch `req.body` directly.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ZodTypeAny, z } from 'zod'

type Source = 'body' | 'query' | 'params'

/**
 * Errors are passed to `next`, where the shared error handler turns a ZodError
 * into field-keyed messages that map straight onto a form (docs/05 section 1).
 */
export function validate<S extends ZodTypeAny>(schema: S, source: Source = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source])
    if (!result.success) return next(result.error)
    // Query and params are read-only getters in Express 5, so the parsed value
    // is stashed rather than assigned back.
    if (source === 'body') req.body = result.data
    else res_locals(req)[source] = result.data
    next()
  }
}

function res_locals(req: Request): Record<string, unknown> {
  const holder = req as unknown as { validated?: Record<string, unknown> }
  holder.validated ??= {}
  return holder.validated
}

/** Reads what `validate` parsed for query or params. */
export function validated<T>(req: Request, source: Exclude<Source, 'body'>): T {
  const holder = req as unknown as { validated?: Record<string, unknown> }
  return (holder.validated?.[source] ?? {}) as T
}

export type Infer<S extends ZodTypeAny> = z.infer<S>
