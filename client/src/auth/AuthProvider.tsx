/**
 * Authentication context and route guards.
 *
 * `usePermissions` wraps the SHARED `can()` so the UI and the server agree
 * about who may do what by construction. The client's use of it is cosmetic:
 * it decides what to render. Every endpoint re-checks independently, because a
 * user can edit the bundle in their own browser but not the server.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Navigate, useLocation } from 'react-router-dom'

import { can, isAtLeast, type Action, type Actor, type Role } from '@roombook/shared'

import { api, setCsrfToken, setUnauthorizedHandler } from '../api/client.js'
import { keys, useMe, type MeUser } from '../api/hooks.js'
import { FullPageSpinner } from '../components/ui/index.js'

interface AuthValue {
  user: MeUser | null
  isLoading: boolean
  actor: Actor | null
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const { data, isPending, isFetched } = useMe()

  const user = data?.user ?? null

  // The token comes back with /auth/me, saving a round trip on boot.
  useEffect(() => {
    if (data?.csrfToken) setCsrfToken(data.csrfToken)
  }, [data?.csrfToken])

  /**
   * A 401 on ANY request clears the cache and sends the user to login. Handled
   * in one place rather than per query, so no screen can forget to do it.
   */
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrfToken(null)
      qc.setQueryData(keys.me, null)
      qc.clear()
    })
  }, [qc])

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout')
    } finally {
      setCsrfToken(null)
      qc.clear()
      // A full reload guarantees no stale component state survives sign-out.
      window.location.assign('/login')
    }
  }, [qc])

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: keys.me })
  }, [qc])

  /** The shape the shared permission matrix expects. */
  const actor = useMemo<Actor | null>(
    () =>
      user
        ? {
            id: user.id,
            organizationId: user.organization.id,
            role: user.role,
            adminLocationIds: user.adminLocationIds,
            administersAllLocations: user.administersAllLocations,
          }
        : null,
    [user],
  )

  const value = useMemo<AuthValue>(
    () => ({ user, isLoading: isPending && !isFetched, actor, signOut, refresh }),
    [user, isPending, isFetched, actor, signOut, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/** The signed-in user, or a throw. Use inside guarded routes. */
export function useCurrentUser(): MeUser {
  const { user } = useAuth()
  if (!user) throw new Error('useCurrentUser used outside a guarded route')
  return user
}

export function usePermissions() {
  const { actor } = useAuth()

  return useMemo(
    () => ({
      /** Checks an action, optionally against a location. */
      can: (action: Action, locationId?: string) =>
        actor
          ? can(
              actor,
              action,
              locationId
                ? { organizationId: actor.organizationId, locationId }
                : { organizationId: actor.organizationId },
            )
          : false,
      hasRole: (minimum: Role) => (actor ? isAtLeast(actor.role, minimum) : false),
      isAdmin: actor ? isAtLeast(actor.role, 'ADMIN') : false,
      isOwner: actor?.role === 'OWNER',
      /** True when this admin may act on the given location (BR-L1). */
      administers: (locationId: string) =>
        actor ? can(actor, 'room:update', { organizationId: actor.organizationId, locationId }) : false,
    }),
    [actor],
  )
}

/**
 * Requires a session. Preserves the attempted path so the user lands where they
 * meant to go rather than on the home page.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) return <FullPageSpinner label="Checking your session" />
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  return <>{children}</>
}

/**
 * Requires a minimum role. Redirects rather than rendering a forbidden screen,
 * because a control the user cannot use should not have been linked to at all.
 */
export function RequireRole({ minimum, children }: { minimum: Role; children: ReactNode }) {
  const { user, isLoading } = useAuth()

  if (isLoading) return <FullPageSpinner label="Checking your access" />
  if (!user) return <Navigate to="/login" replace />
  if (!isAtLeast(user.role, minimum)) return <Navigate to="/" replace />
  return <>{children}</>
}

/** For the auth pages: an already-signed-in user has no business there. */
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth()
  if (isLoading) return <FullPageSpinner label="Loading" />
  if (user) return <Navigate to="/" replace />
  return <>{children}</>
}
