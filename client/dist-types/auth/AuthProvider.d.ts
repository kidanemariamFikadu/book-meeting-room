/**
 * Authentication context and route guards.
 *
 * `usePermissions` wraps the SHARED `can()` so the UI and the server agree
 * about who may do what by construction. The client's use of it is cosmetic:
 * it decides what to render. Every endpoint re-checks independently, because a
 * user can edit the bundle in their own browser but not the server.
 */
import { type ReactNode } from 'react';
import { type Action, type Actor, type Role } from '@roombook/shared';
import { type MeUser } from '../api/hooks.js';
interface AuthValue {
    user: MeUser | null;
    isLoading: boolean;
    actor: Actor | null;
    signOut: () => Promise<void>;
    refresh: () => Promise<void>;
}
export declare function AuthProvider({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
export declare function useAuth(): AuthValue;
/** The signed-in user, or a throw. Use inside guarded routes. */
export declare function useCurrentUser(): MeUser;
export declare function usePermissions(): {
    /** Checks an action, optionally against a location. */
    can: (action: Action, locationId?: string) => boolean;
    hasRole: (minimum: Role) => boolean;
    isAdmin: boolean;
    isOwner: boolean;
    /** True when this admin may act on the given location (BR-L1). */
    administers: (locationId: string) => boolean;
};
/**
 * Requires a session. Preserves the attempted path so the user lands where they
 * meant to go rather than on the home page.
 */
export declare function RequireAuth({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
/**
 * Requires a minimum role. Redirects rather than rendering a forbidden screen,
 * because a control the user cannot use should not have been linked to at all.
 */
export declare function RequireRole({ minimum, children }: {
    minimum: Role;
    children: ReactNode;
}): import("react").JSX.Element;
/** For the auth pages: an already-signed-in user has no business there. */
export declare function RedirectIfSignedIn({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
export {};
//# sourceMappingURL=AuthProvider.d.ts.map