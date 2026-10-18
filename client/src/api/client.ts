/**
 * The HTTP client.
 *
 * One place owns CSRF, 401 handling and error parsing, so no component has to
 * think about any of it. Everything goes through `api`.
 *
 * Specification: docs/02-architecture.md section 6, docs/05-api-spec.md section 1.
 */

import type { ApiErrorBody, ErrorCode } from '@roombook/shared'

const BASE = '/api/v1'

/** A failed request, with the server's machine-readable code and field errors. */
export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode | 'NETWORK'
  readonly fields: Record<string, string>
  readonly rule?: string
  readonly requestId?: string
  readonly details?: unknown

  constructor(status: number, body: ApiErrorBody | null, fallback?: string) {
    const err = body?.error
    super(err?.message ?? fallback ?? 'Something went wrong')
    this.name = 'ApiError'
    this.status = status
    this.code = err?.code ?? 'NETWORK'
    this.fields = err?.details?.fields ?? {}
    this.rule = err?.details?.rule
    this.requestId = err?.details?.requestId
    this.details = err?.details
  }
}

/**
 * The CSRF token, fetched once and reused.
 *
 * Held in a module variable rather than React state because the interceptor
 * below needs it outside any component, and it is not secret — it is useless
 * without the session cookie that accompanies it.
 */
let csrfToken: string | null = null
let csrfInFlight: Promise<string> | null = null

async function getCsrfToken(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken
  csrfInFlight ??= fetch(`${BASE}/auth/csrf`, { credentials: 'same-origin' })
    .then(r => r.json())
    .then((d: { csrfToken: string }) => {
      csrfToken = d.csrfToken
      return d.csrfToken
    })
    .finally(() => {
      csrfInFlight = null
    })
  return csrfInFlight
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

/**
 * Called when any request comes back 401.
 *
 * Registered by the auth provider rather than imported, so this module stays
 * free of React and of the router.
 */
type UnauthorizedHandler = () => void
let onUnauthorized: UnauthorizedHandler = () => undefined

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

interface RequestOptions {
  method?: string
  body?: unknown
  /** Suppresses the global 401 redirect, for the initial "am I signed in" probe. */
  allowUnauthenticated?: boolean
  signal?: AbortSignal
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = {}

  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (MUTATING.has(method)) headers['x-csrf-token'] = await getCsrfToken()

  const send = (): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method,
      headers,
      // Same-origin, so the HttpOnly session cookie rides along and no token is
      // ever stored where script can reach it.
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })

  let res: Response
  try {
    res = await send()
  } catch (cause) {
    throw new ApiError(0, null, 'Could not reach the server. Your changes were not saved.')
  }

  // A stale CSRF token is recoverable: fetch a fresh one and retry once. This
  // happens after the session is regenerated, which is routine.
  if (res.status === 403 && MUTATING.has(method)) {
    const peek = (await res.clone().json().catch(() => null)) as ApiErrorBody | null
    if (peek?.error?.code === 'CSRF_FAILED') {
      headers['x-csrf-token'] = await getCsrfToken(true)
      res = await send()
    }
  }

  if (res.status === 204) return undefined as T

  const payload = (await res.json().catch(() => null)) as unknown

  if (!res.ok) {
    if (res.status === 401 && !options.allowUnauthenticated) {
      csrfToken = null
      onUnauthorized()
    }
    throw new ApiError(res.status, payload as ApiErrorBody | null)
  }

  return payload as T
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'PUT', body }),
  del: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...opts, method: 'DELETE', body }),
}

/**
 * Maps a 422 onto a react-hook-form error setter.
 *
 * This is what makes a rule only the server knows about — the room's bookable
 * hours, say — land next to the right input rather than in a toast.
 */
export function applyFieldErrors(
  error: unknown,
  setError: (name: string, err: { type: string; message: string }) => void,
): boolean {
  if (!(error instanceof ApiError)) return false
  const entries = Object.entries(error.fields)
  if (entries.length === 0) return false
  for (const [field, message] of entries) {
    setError(field, { type: 'server', message })
  }
  return true
}
