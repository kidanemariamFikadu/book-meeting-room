/**
 * The selected location.
 *
 * Persisted in the URL and in localStorage so a shared link opens on the right
 * site, and a returning user does not have to pick again. The URL wins, since
 * an explicit link should beat a remembered preference.
 *
 * Specification: docs/14-multi-location.md section 7.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useLocations, type LocationSummary } from '../api/hooks.js'
import { useAuth } from '../auth/AuthProvider.js'

const STORAGE_KEY = 'roombook.locationId'

/** localStorage throws in a private window and returns null with site data cleared. */
function readStored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id)
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // A per-viewer convenience only; losing it changes nothing important.
  }
}

export interface LocationScope {
  locations: LocationSummary[]
  selected: LocationSummary | null
  selectedId: string | null
  select: (id: string) => void
  isLoading: boolean
  isMultiSite: boolean
}

export function useLocationScope(): LocationScope {
  const { user } = useAuth()
  const { data, isPending } = useLocations()
  const [params, setParams] = useSearchParams()

  const locations = useMemo(() => data ?? [], [data])
  const fromUrl = params.get('location')

  /**
   * Resolution order: the URL, then the remembered choice, then the user's home
   * location, then the first site. Each falls through only if the previous one
   * names a location that no longer exists.
   */
  const selectedId = useMemo(() => {
    const exists = (id: string | null | undefined) =>
      id && locations.some(l => l.id === id) ? id : null

    return (
      exists(fromUrl) ??
      exists(readStored()) ??
      exists(user?.homeLocationId) ??
      locations[0]?.id ??
      null
    )
  }, [fromUrl, locations, user?.homeLocationId])

  // Keep the remembered value in step, so the next visit opens in the same place.
  useEffect(() => {
    if (selectedId) writeStored(selectedId)
  }, [selectedId])

  const select = useCallback(
    (id: string) => {
      writeStored(id)
      const next = new URLSearchParams(params)
      next.set('location', id)
      // replace: switching location is not a navigation step the back button
      // should have to walk through.
      setParams(next, { replace: true })
    },
    [params, setParams],
  )

  return {
    locations,
    selected: locations.find(l => l.id === selectedId) ?? null,
    selectedId,
    select,
    isLoading: isPending,
    isMultiSite: locations.length > 1,
  }
}
