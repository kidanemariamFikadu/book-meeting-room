/**
 * The day calendar (S-05) — the landing page and the most-used screen.
 *
 * Specification: docs/07-ui-screens.md.
 */

import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { addLocalDays, dateInZone } from '@roombook/shared'

import { useDayAvailability } from '../api/hooks.js'
import { usePermissions } from '../auth/AuthProvider.js'
import { BookingDialog, type DraftBooking } from '../components/booking/BookingDialog.js'
import { CalendarGrid, type SlotSelection } from '../components/calendar/CalendarGrid.js'
import { useLocationScope } from '../hooks/useLocationScope.js'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  PageHeader,
  Skeleton,
} from '../components/ui/index.js'
import s from './calendar.module.css'

export function CalendarPage() {
  const navigate = useNavigate()
  const perms = usePermissions()
  const { selected, isLoading: locationsLoading } = useLocationScope()
  const [params, setParams] = useSearchParams()

  const timezone = selected?.timezone ?? 'UTC'
  const today = dateInZone(new Date(), timezone)
  const date = params.get('date') ?? today

  const { data, isPending, error, refetch } = useDayAvailability(date, selected?.id)
  const [draft, setDraft] = useState<DraftBooking | null>(null)

  const setDate = (next: string) => {
    const p = new URLSearchParams(params)
    p.set('date', next)
    setParams(p, { replace: true })
  }

  const onSelect = (sel: SlotSelection) => {
    const room = data?.rooms.find(r => r.roomId === sel.roomId)
    if (!room) return
    setDraft({
      roomId: sel.roomId,
      roomName: room.name,
      start: sel.start,
      end: sel.end,
      timezone: data!.timezone,
    })
  }

  if (locationsLoading) return <Skeleton rows={6} />

  if (!selected) {
    return (
      <Card>
        <EmptyState
          title="No locations yet"
          description={
            perms.isOwner
              ? 'Add a location and its rooms, and the calendar will fill in.'
              : 'Ask your office admin to set up the locations and rooms.'
          }
          action={
            perms.isOwner && (
              <Link to="/admin/locations">
                <Button variant="primary">Add a location</Button>
              </Link>
            )
          }
        />
      </Card>
    )
  }

  return (
    <>
      <PageHeader
        title={friendlyDate(date, today)}
        description={`${selected.name} · all times ${selected.timezone}`}
        actions={
          <Link to="/find">
            <Button>
              <Search size={15} aria-hidden /> Find a room
            </Button>
          </Link>
        }
      />

      <div className={s.toolbar}>
        <div className={s.nav}>
          <Button size="sm" onClick={() => setDate(addLocalDays(date, -1))} aria-label="Previous day">
            <ChevronLeft size={15} aria-hidden />
          </Button>
          <Button size="sm" onClick={() => setDate(today)} disabled={date === today}>
            Today
          </Button>
          <Button size="sm" onClick={() => setDate(addLocalDays(date, 1))} aria-label="Next day">
            <ChevronRight size={15} aria-hidden />
          </Button>
        </div>

        <input
          type="date"
          className={s.datePicker}
          value={date}
          onChange={e => e.target.value && setDate(e.target.value)}
          aria-label="Choose a date"
        />
      </div>

      {error && (
        <ErrorNotice title="Could not load the calendar" error={error} onRetry={() => void refetch()} />
      )}

      {isPending && <Skeleton rows={6} />}

      {data && data.rooms.length === 0 && !isPending && (
        <Card>
          <EmptyState
            title="No rooms at this location"
            description={
              perms.isAdmin
                ? 'Add a room and it will appear on this grid straight away.'
                : 'Ask your office admin to add the meeting rooms here.'
            }
            action={
              perms.isAdmin && (
                <Link to="/admin/rooms/new">
                  <Button variant="primary">Add a room</Button>
                </Link>
              )
            }
          />
        </Card>
      )}

      {data && data.rooms.length > 0 && (
        <CalendarGrid
          data={data}
          onSelect={onSelect}
          onOpenBooking={id => navigate(`/bookings/${id}`)}
        />
      )}

      {draft && data && (
        <BookingDialog
          draft={draft}
          rooms={data.rooms.map(r => ({ roomId: r.roomId, name: r.name }))}
          onClose={() => setDraft(null)}
          onBooked={id => {
            setDraft(null)
            navigate(`/bookings/${id}`)
          }}
          onSeriesCreated={seriesId => {
            setDraft(null)
            navigate(`/series/${seriesId}`)
          }}
        />
      )}
    </>
  )
}

/** "Today", "Tomorrow", or a full date — friendlier than a bare ISO string. */
function friendlyDate(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === addLocalDays(today, 1)) return 'Tomorrow'
  if (date === addLocalDays(today, -1)) return 'Yesterday'
  const [y, m, d] = date.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y!, m! - 1, d!)))
}
