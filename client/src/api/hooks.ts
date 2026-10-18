/**
 * TanStack Query hooks.
 *
 * Every screen reads server state through one of these, never a bare `fetch`,
 * so loading, error and empty states come from the hook rather than being
 * remembered per screen.
 *
 * Query keys and what invalidates them: docs/05-api-spec.md section 9.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { Role } from '@roombook/shared'

import { api } from './client.js'

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface MeUser {
  id: string
  email: string
  fullName: string
  role: Role
  status: string
  timezone: string | null
  homeLocationId: string | null
  emailOptOutReminders: boolean
  lastLoginAt: string | null
  organization: { id: string; name: string; defaultTimezone: string }
  homeLocation: { id: string; name: string; timezone: string } | null
  adminLocationIds: string[]
  administersAllLocations: boolean
}

export interface LocationSummary {
  id: string
  name: string
  code: string | null
  address: string | null
  timezone: string
  country: string | null
  isActive: boolean
  sortOrder: number
  roomCount: number
  currentLocalTime: string
  businessHoursStart: string | null
  businessHoursEnd: string | null
  businessDays: number[]
}

export interface Feature {
  id: string
  name: string
  icon: string | null
  sortOrder: number
}

export interface RoomSummary {
  id: string
  name: string
  capacity: number
  floor: string | null
  description: string | null
  colour: string
  isActive: boolean
  requiresApproval: boolean
  location: { id: string; name: string; timezone: string; isActive: boolean }
  features: Feature[]
  hours: Array<{ id: string; weekday: number; startLocal: string; endLocal: string }>
  approver: { id: string; fullName: string; email: string } | null
  limits: {
    minBookingMinutes: number | null
    maxBookingMinutes: number | null
    maxAdvanceDays: number | null
    minNoticeMinutes: number | null
  }
}

export interface UserRow {
  id: string
  email: string
  fullName: string
  role: Role
  status: string
  timezone: string | null
  homeLocationId: string | null
  lastLoginAt: string | null
  lockedUntil: string | null
  createdAt: string
  homeLocation: { id: string; name: string } | null
  locationAccess: Array<{ locationId: string; location: { name: string } }>
}

interface Envelope<T> {
  data: T
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const keys = {
  me: ['auth', 'me'] as const,
  locations: (opts?: { includeInactive?: boolean }) => ['locations', opts ?? {}] as const,
  location: (id: string) => ['location', id] as const,
  rooms: (filters?: Record<string, unknown>) => ['rooms', filters ?? {}] as const,
  room: (id: string) => ['room', id] as const,
  features: ['features'] as const,
  users: (opts?: Record<string, unknown>) => ['users', opts ?? {}] as const,
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function useMe(enabled = true) {
  return useQuery({
    queryKey: keys.me,
    // Allowed to 401 without triggering the global redirect: this IS the
    // "am I signed in?" probe, so a 401 is an answer, not a failure.
    queryFn: () =>
      api.get<{ user: MeUser; csrfToken: string }>('/auth/me', { allowUnauthenticated: true }),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  })
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export function useLocations(opts: { includeInactive?: boolean } = {}) {
  const query = opts.includeInactive ? '?includeInactive=true' : ''
  return useQuery({
    queryKey: keys.locations(opts),
    queryFn: () => api.get<Envelope<LocationSummary[]>>(`/locations${query}`).then(r => r.data),
    // Locations change rarely, and the switcher is on every screen.
    staleTime: 5 * 60_000,
  })
}

export function useLocation(id: string | undefined) {
  return useQuery({
    queryKey: keys.location(id ?? ''),
    queryFn: () => api.get<Envelope<Record<string, unknown>>>(`/locations/${id}`).then(r => r.data),
    enabled: Boolean(id),
  })
}

/**
 * Invalidates everything a location change can affect.
 *
 * Room lists are included because they carry the location name, and a renamed
 * or deactivated location would otherwise keep showing its old details.
 */
function useLocationMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['locations'] })
      void qc.invalidateQueries({ queryKey: ['location'] })
      void qc.invalidateQueries({ queryKey: ['rooms'] })
    },
  })
}

export const useCreateLocation = () =>
  useLocationMutation((body: Record<string, unknown>) =>
    api.post<Envelope<LocationSummary>>('/locations', body),
  )

export const useUpdateLocation = () =>
  useLocationMutation(({ id, ...body }: { id: string } & Record<string, unknown>) =>
    api.patch<Envelope<LocationSummary>>(`/locations/${id}`, body),
  )

export const useDeleteLocation = () =>
  useLocationMutation((id: string) => api.del<{ deleted: boolean; name: string }>(`/locations/${id}`))

export const useSetLocationActive = () =>
  useLocationMutation(({ id, isActive }: { id: string; isActive: boolean }) =>
    api.post<Envelope<LocationSummary>>(`/locations/${id}/${isActive ? 'activate' : 'deactivate'}`),
  )

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export interface RoomFilters {
  locationId?: string
  minCapacity?: number
  features?: string[]
  includeInactive?: boolean
  q?: string
}

function roomQueryString(f: RoomFilters): string {
  const p = new URLSearchParams()
  if (f.locationId) p.set('locationId', f.locationId)
  if (f.minCapacity) p.set('minCapacity', String(f.minCapacity))
  if (f.features?.length) p.set('features', f.features.join(','))
  if (f.includeInactive) p.set('includeInactive', 'true')
  if (f.q) p.set('q', f.q)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export function useRooms(filters: RoomFilters = {}) {
  return useQuery({
    queryKey: keys.rooms(filters as Record<string, unknown>),
    queryFn: () =>
      api.get<Envelope<RoomSummary[]>>(`/rooms${roomQueryString(filters)}`).then(r => r.data),
    staleTime: 60_000,
  })
}

export function useRoom(id: string | undefined) {
  return useQuery({
    queryKey: keys.room(id ?? ''),
    queryFn: () => api.get<Envelope<RoomSummary>>(`/rooms/${id}`).then(r => r.data),
    enabled: Boolean(id),
  })
}

function useRoomMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rooms'] })
      void qc.invalidateQueries({ queryKey: ['room'] })
      // A room change alters the room count shown in the location switcher.
      void qc.invalidateQueries({ queryKey: ['locations'] })
      // And availability, once M3 exists.
      void qc.invalidateQueries({ queryKey: ['availability'] })
    },
  })
}

export const useCreateRoom = () =>
  useRoomMutation((body: Record<string, unknown>) => api.post<Envelope<RoomSummary>>('/rooms', body))

export const useUpdateRoom = () =>
  useRoomMutation(({ id, ...body }: { id: string } & Record<string, unknown>) =>
    api.patch<Envelope<RoomSummary>>(`/rooms/${id}`, body),
  )

export const useSetRoomActive = () =>
  useRoomMutation(({ id, isActive, force }: { id: string; isActive: boolean; force?: boolean }) =>
    isActive
      ? api.post<Envelope<RoomSummary>>(`/rooms/${id}/activate`)
      : api.post<Envelope<RoomSummary>>(`/rooms/${id}/deactivate`, { force: force ?? false }),
  )

export const useDeleteRoom = () =>
  useRoomMutation((id: string) => api.del<{ deleted: boolean; name: string }>(`/rooms/${id}`))

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export function useFeatures() {
  return useQuery({
    queryKey: keys.features,
    queryFn: () =>
      api.get<Envelope<Array<Feature & { _count: { rooms: number } }>>>('/rooms/features').then(r => r.data),
    staleTime: 5 * 60_000,
  })
}

function useFeatureMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.features })
      // Deleting a feature untags rooms, so their listings change too.
      void qc.invalidateQueries({ queryKey: ['rooms'] })
    },
  })
}

export const useCreateFeature = () =>
  useFeatureMutation((body: { name: string; icon?: string }) =>
    api.post<Envelope<Feature>>('/rooms/features', body),
  )

export const useDeleteFeature = () =>
  useFeatureMutation((id: string) => api.del<{ deleted: boolean }>(`/rooms/features/${id}`))

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function useUsers(opts: { includeDisabled?: boolean } = {}) {
  const query = opts.includeDisabled ? '?includeDisabled=true' : ''
  return useQuery({
    queryKey: keys.users(opts),
    queryFn: () => api.get<Envelope<UserRow[]>>(`/users${query}`).then(r => r.data),
    staleTime: 60_000,
  })
}

function useUserMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] })
      void qc.invalidateQueries({ queryKey: keys.me })
    },
  })
}

export const useInviteUser = () =>
  useUserMutation((body: Record<string, unknown>) => api.post<Envelope<UserRow>>('/users/invite', body))

export const useUpdateUser = () =>
  useUserMutation(({ id, ...body }: { id: string } & Record<string, unknown>) =>
    api.patch<Envelope<UserRow>>(`/users/${id}`, body),
  )

export const useResendInvite = () =>
  useUserMutation((id: string) => api.post<{ sent: boolean }>(`/users/${id}/resend-invite`))

export const useSetUserStatus = () =>
  useUserMutation(({ id, active, force }: { id: string; active: boolean; force?: boolean }) =>
    active
      ? api.post<Envelope<UserRow>>(`/users/${id}/activate`)
      : api.post<Envelope<UserRow>>(`/users/${id}/deactivate`, { force: force ?? false }),
  )

// ---------------------------------------------------------------------------
// Own account
// ---------------------------------------------------------------------------

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api.patch<void>('/account/password', body),
  })
}

export function useUpdateProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Envelope<UserRow>>('/account', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.me })
      void qc.invalidateQueries({ queryKey: ['users'] })
    },
  })
}

// ---------------------------------------------------------------------------
// Availability and bookings (M3)
// ---------------------------------------------------------------------------

export interface BusySlot {
  bookingId: string
  startsAt: string
  endsAt: string
  title: string
  organizer: { id: string; fullName: string } | null
  status: string
  isPrivate: boolean
  isMine: boolean
  canAdminister: boolean
}

export interface RoomAvailability {
  roomId: string
  name: string
  capacity: number
  floor: string | null
  colour: string
  features: Array<{ id: string; name: string }>
  bookableWindows: Array<{ startsAt: string; endsAt: string }>
  busy: BusySlot[]
  closures: Array<{ id: string; startsAt: string; endsAt: string; reason: string }>
  freeSlots: Array<{ startsAt: string; endsAt: string }>
}

export interface DayAvailability {
  date: string
  timezone: string
  locationId: string
  locationName: string
  rooms: RoomAvailability[]
}

export interface FreeRoom {
  roomId: string
  name: string
  capacity: number
  floor: string | null
  colour: string
  locationId: string
  locationName: string
  timezone: string
  features: Array<{ id: string; name: string }>
  requiresApproval: boolean
}

export interface BookingDetail {
  id: string
  title: string
  description: string | null
  startsAt: string
  endsAt: string
  status: string
  isPrivate: boolean
  cancellationReason: string | null
  /** Present when this booking is one occurrence of a recurring series. */
  seriesId: string | null
  isException: boolean
  occurrenceStartLocal: string | null
  room: {
    id: string
    name: string
    capacity: number
    floor: string | null
    colour: string
    requiresApproval: boolean
    location: { id: string; name: string; timezone: string; address: string | null }
  }
  organizer: { id: string; fullName: string; email: string }
  attendees: Array<{ id: string; email: string; displayName: string | null; response: string }>
}

export function useDayAvailability(date: string, locationId: string | null | undefined) {
  return useQuery({
    queryKey: ['availability', date, locationId ?? ''],
    queryFn: () =>
      api.get<DayAvailability>(
        `/availability?date=${date}${locationId ? `&locationId=${locationId}` : ''}`,
      ),
    enabled: Boolean(date),
    // Several people change this calendar at once, so it refreshes in the
    // background while the tab is focused (docs/02 section 8).
    staleTime: 20_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })
}

export function useFindRooms(
  params: { startsAt: string; endsAt: string; locationId?: string; minCapacity?: number; features?: string[]; allLocations?: boolean } | null,
) {
  return useQuery({
    queryKey: ['find-rooms', params],
    queryFn: () => {
      const p = new URLSearchParams({ startsAt: params!.startsAt, endsAt: params!.endsAt })
      if (params!.locationId && !params!.allLocations) p.set('locationId', params!.locationId)
      if (params!.allLocations) p.set('allLocations', 'true')
      if (params!.minCapacity) p.set('minCapacity', String(params!.minCapacity))
      if (params!.features?.length) p.set('features', params!.features.join(','))
      return api.get<{ data: FreeRoom[] }>(`/availability/find?${p}`).then(r => r.data)
    },
    enabled: params !== null,
  })
}

export function useBookings(filters: Record<string, string | undefined> = {}) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v)
  const qs = p.toString()
  return useQuery({
    queryKey: ['bookings', filters],
    queryFn: () => api.get<{ data: BookingDetail[] }>(`/bookings${qs ? `?${qs}` : ''}`).then(r => r.data),
  })
}

export function useBooking(id: string | undefined) {
  return useQuery({
    queryKey: ['booking', id ?? ''],
    queryFn: () => api.get<{ data: BookingDetail }>(`/bookings/${id}`).then(r => r.data),
    enabled: Boolean(id),
  })
}

/**
 * Any booking change invalidates availability, so the grid updates itself
 * rather than needing a manual refresh (docs/05 section 9).
 */
function useBookingMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['availability'] })
      void qc.invalidateQueries({ queryKey: ['bookings'] })
      void qc.invalidateQueries({ queryKey: ['booking'] })
      void qc.invalidateQueries({ queryKey: ['find-rooms'] })
    },
  })
}

export const useCreateBooking = () =>
  useBookingMutation((body: Record<string, unknown>) =>
    api.post<{ data: BookingDetail }>('/bookings', body),
  )

export const useUpdateBooking = () =>
  useBookingMutation(({ id, ...body }: { id: string } & Record<string, unknown>) =>
    api.patch<{ data: BookingDetail }>(`/bookings/${id}`, body),
  )

export const useMoveBooking = () =>
  useBookingMutation(({ id, ...body }: { id: string } & Record<string, unknown>) =>
    api.post<{ data: BookingDetail }>(`/bookings/${id}/move`, body),
  )

export const useCancelBooking = () =>
  useBookingMutation(({ id, reason }: { id: string; reason?: string }) =>
    api.post<{ data: BookingDetail }>(`/bookings/${id}/cancel`, reason ? { reason } : {}),
  )

export const useEndBookingEarly = () =>
  useBookingMutation((id: string) => api.post<{ data: BookingDetail }>(`/bookings/${id}/end-early`, {}))

// ---------------------------------------------------------------------------
// Recurring series (M4b)
// ---------------------------------------------------------------------------

export interface SeriesPreviewResponse {
  description: string
  totalOccurrences: number
  available: number
  firstOccurrence: string | null
  lastOccurrence: string | null
  conflicts: Array<{
    occurrenceStartLocal: string
    reason: string
    detail?: string
    conflictingTitle?: string
  }>
  truncated: boolean
}

export interface SeriesDetail {
  id: string
  title: string
  description: string | null
  rrule: string
  dtstartLocal: string
  durationMinutes: number
  timezone: string
  status: string
  pattern: string
  room: {
    id: string
    name: string
    colour: string
    location: { id: string; name: string; timezone: string }
  }
  organizer: { id: string; fullName: string; email: string }
  occurrences: Array<{
    id: string
    title: string
    startsAt: string
    endsAt: string
    status: string
    isException: boolean
    exceptionFields: string[]
    occurrenceStartLocal: string | null
    cancellationReason: string | null
    room: { id: string; name: string }
  }>
  counts: { total: number; upcoming: number; cancelled: number; exceptions: number }
}

/** The dry run. Read-only, so it is safe to call as the form changes. */
export function usePreviewSeries() {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ data: SeriesPreviewResponse }>('/series/preview', body).then(r => r.data),
  })
}

export function useCreateSeries() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api
        .post<{
          data: { seriesId: string; created: number; skipped: unknown[]; description: string }
        }>('/series', body)
        .then(r => r.data),
    onSuccess: () => {
      // A series writes many booking rows, so everything that shows bookings
      // has to refetch.
      void qc.invalidateQueries({ queryKey: ['availability'] })
      void qc.invalidateQueries({ queryKey: ['bookings'] })
      void qc.invalidateQueries({ queryKey: ['find-rooms'] })
    },
  })
}

export function useSeries(id: string | undefined) {
  return useQuery({
    queryKey: ['series', id ?? ''],
    queryFn: () => api.get<{ data: SeriesDetail }>(`/series/${id}`).then(r => r.data),
    enabled: Boolean(id),
  })
}

export function useCancelOccurrence() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      bookingId,
      scope,
      reason,
    }: {
      bookingId: string
      scope: string
      reason?: string
    }) =>
      api.post<{ data: { scope: string; affected: number } }>(
        `/series/occurrences/${bookingId}/cancel`,
        reason ? { scope, reason } : { scope },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['availability'] })
      void qc.invalidateQueries({ queryKey: ['bookings'] })
      void qc.invalidateQueries({ queryKey: ['booking'] })
      void qc.invalidateQueries({ queryKey: ['series'] })
    },
  })
}
