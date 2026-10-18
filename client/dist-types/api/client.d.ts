/**
 * The HTTP client.
 *
 * One place owns CSRF, 401 handling and error parsing, so no component has to
 * think about any of it. Everything goes through `api`.
 *
 * Specification: docs/02-architecture.md section 6, docs/05-api-spec.md section 1.
 */
import type { ApiErrorBody, ErrorCode } from '@roombook/shared';
/** A failed request, with the server's machine-readable code and field errors. */
export declare class ApiError extends Error {
    readonly status: number;
    readonly code: ErrorCode | 'NETWORK';
    readonly fields: Record<string, string>;
    readonly rule?: string;
    readonly requestId?: string;
    readonly details?: unknown;
    constructor(status: number, body: ApiErrorBody | null, fallback?: string);
}
export declare function setCsrfToken(token: string | null): void;
/**
 * Called when any request comes back 401.
 *
 * Registered by the auth provider rather than imported, so this module stays
 * free of React and of the router.
 */
type UnauthorizedHandler = () => void;
export declare function setUnauthorizedHandler(handler: UnauthorizedHandler): void;
interface RequestOptions {
    method?: string;
    body?: unknown;
    /** Suppresses the global 401 redirect, for the initial "am I signed in" probe. */
    allowUnauthenticated?: boolean;
    signal?: AbortSignal;
}
export declare const api: {
    get: <T>(path: string, opts?: Omit<RequestOptions, "method" | "body">) => Promise<T>;
    post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method" | "body">) => Promise<T>;
    patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method" | "body">) => Promise<T>;
    put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method" | "body">) => Promise<T>;
    del: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, "method" | "body">) => Promise<T>;
};
/**
 * Maps a 422 onto a react-hook-form error setter.
 *
 * This is what makes a rule only the server knows about — the room's bookable
 * hours, say — land next to the right input rather than in a toast.
 */
export declare function applyFieldErrors(error: unknown, setError: (name: string, err: {
    type: string;
    message: string;
}) => void): boolean;
export {};
//# sourceMappingURL=client.d.ts.map