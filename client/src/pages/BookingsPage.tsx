/**
 * My bookings (S-09), booking detail (S-08) and the room finder (S-06).
 */

import { ArrowLeft, Clock, MapPin, Search, Users } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { dateInZone, formatForDisplay, timeInZone } from '@roombook/shared'

import {
  useBooking,
  useBookings,
  useEndBookingEarly,
  useFindRooms,
  useCreateBooking,
  type BookingDetail,
} from '../api/hooks.js'
import { useCurrentUser, usePermissions } from '../auth/AuthProvider.js'
import { StatusBadge } from '../components/booking/BookingDialog.js'
import { CancelDialog, MoveDialog } from '../components/booking/MoveDialog.js'
import { useLocationScope } from '../hooks/useLocationScope.js'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '../components/ui/index.js'
import s from './calendar.module.css'

// ---------------------------------------------------------------------------
// My bookings
// ---------------------------------------------------------------------------

export function MyBookingsPage() {
  const [scope, setScope] = useState<'mine' | 'attending'>('mine')
  const { data, isPending, error, refetch } = useBookings({ scope, status: 'all' })

  const now = Date.now()
  const upcoming = (data ?? []).filter(b => new Date(b.endsAt).getTime() >= now)
  const past = (data ?? []).filter(b => new Date(b.endsAt).getTime() < now).reverse()

  if (error) {
    return <ErrorNotice title="Could not load your bookings" error={error} onRetry={() => void refetch()} />
  }

  return (
    <>
      <PageHeader
        title="My bookings"
        actions={
          <Link to="/">
            <Button variant="primary">Book a room</Button>
          </Link>
        }
      />

      <div className={s.tabs} role="tablist">
        <button
          role="tab"
          aria-selected={scope === 'mine'}
          className={scope === 'mine' ? `${s.tab} ${s.tabOn}` : s.tab}
          onClick={() => setScope('mine')}
        >
          Organized by me
        </button>
        <button
          role="tab"
          aria-selected={scope === 'attending'}
          className={scope === 'attending' ? `${s.tab} ${s.tabOn}` : s.tab}
          onClick={() => setScope('attending')}
        >
          I am invited
        </button>
      </div>

      {isPending && <Skeleton rows={4} />}

      {!isPending && upcoming.length === 0 && past.length === 0 && (
        <Card>
          <EmptyState
            title="Nothing here yet"
            description={
              scope === 'mine'
                ? 'Bookings you make will appear here, with everything you need to change or cancel them.'
                : 'Meetings other people invite you to will appear here.'
            }
            action={
              <Link to="/">
                <Button variant="primary">Find a room</Button>
              </Link>
            }
          />
        </Card>
      )}

      {upcoming.length > 0 && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>Upcoming</h2>
          <div className={s.list}>
            {upcoming.map(b => (
              <BookingRow key={b.id} booking={b} />
            ))}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>Past</h2>
          <div className={s.list}>
            {past.slice(0, 25).map(b => (
              <BookingRow key={b.id} booking={b} muted />
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function BookingRow({ booking, muted = false }: { booking: BookingDetail; muted?: boolean }) {
  const tz = booking.room.location.timezone
  return (
    <Link to={`/bookings/${booking.id}`} className={muted ? `${s.row} ${s.rowMuted}` : s.row}>
      <span className={s.rowSwatch} style={{ background: booking.room.colour }} aria-hidden />
      <span className={s.rowMain}>
        <span className={s.rowTitle}>{booking.title}</span>
        <span className={s.rowMeta}>
          {booking.room.name} · {booking.room.location.name}
        </span>
      </span>
      <span className={s.rowWhen}>
        {formatForDisplay(new Date(booking.startsAt), tz, { withDate: true })}
        <span className={s.rowMeta}>
          until {timeInZone(new Date(booking.endsAt), tz)}
        </span>
      </span>
      <StatusBadge status={booking.status} />
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Booking detail
// ---------------------------------------------------------------------------

export function BookingDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const me = useCurrentUser()
  const perms = usePermissions()
  const toast = useToast()

  const { data: booking, isPending, error } = useBooking(id)
  const endEarly = useEndBookingEarly()

  const [moving, setMoving] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  if (isPending) return <Skeleton rows={5} />
  if (error || !booking) return <ErrorNotice title="Could not load that booking" error={error} />

  const tz = booking.room.location.timezone
  const start = new Date(booking.startsAt)
  const end = new Date(booking.endsAt)
  const now = Date.now()

  const isOrganizer = booking.organizer.id === me.id
  const isAdmin = perms.administers(booking.room.location.id)
  const hasEnded = end.getTime() <= now
  const inProgress = start.getTime() <= now && !hasEnded
  const isTerminal = booking.status === 'CANCELLED' || booking.status === 'REJECTED'

  // Mirrors the shared permission matrix. The server enforces all of this
  // independently; this only decides what to render.
  const canCancel = !isTerminal && !hasEnded && !inProgress && (isOrganizer || isAdmin)
  const canEndEarly = !isTerminal && inProgress && (isOrganizer || isAdmin)
  const canMove = !isTerminal && !hasEnded && isAdmin

  // The viewer's own zone, shown alongside the room's when they differ — a
  // time without its zone is how people dial in an hour late.
  const viewerZone = me.timezone ?? me.homeLocation?.timezone ?? tz
  const showBothZones = viewerZone !== tz

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
        <ArrowLeft size={14} aria-hidden /> Back
      </Button>

      <PageHeader
        title={booking.title}
        actions={
          <>
            {canEndEarly && (
              <Button
                onClick={async () => {
                  await endEarly.mutateAsync(booking.id)
                  toast.show('Ended — the room is free for the rest of the slot')
                }}
                loading={endEarly.isPending}
              >
                End now and release the room
              </Button>
            )}
            {canCancel && <Button onClick={() => setCancelling(true)}>Cancel booking</Button>}
            {canMove && (
              <Button variant="primary" onClick={() => setMoving(true)}>
                Move
              </Button>
            )}
          </>
        }
      />

      <Card>
        <div className={s.detailHead}>
          <StatusBadge status={booking.status} />
          {hasEnded && <Badge tone="neutral">Finished</Badge>}
          {inProgress && <Badge tone="warning">In progress</Badge>}
        </div>

        <dl className={s.detailGrid}>
          <div>
            <dt>
              <MapPin size={13} aria-hidden /> Room
            </dt>
            <dd>
              {booking.room.name}
              {booking.room.floor ? `, ${booking.room.floor}` : ''}
              <span className={s.detailSub}>
                {booking.room.location.name}
                {booking.room.location.address ? ` — ${booking.room.location.address}` : ''}
              </span>
            </dd>
          </div>

          <div>
            <dt>
              <Clock size={13} aria-hidden /> When
            </dt>
            <dd>
              {formatForDisplay(start, tz, { withDate: true })} – {timeInZone(end, tz)}
              {showBothZones && (
                <span className={s.detailSub}>
                  {timeInZone(start, viewerZone)} – {timeInZone(end, viewerZone)} your time
                </span>
              )}
            </dd>
          </div>

          <div>
            <dt>
              <Users size={13} aria-hidden /> Organizer
            </dt>
            <dd>
              {booking.organizer.fullName}
              {isOrganizer && <span className={s.detailSub}>That is you</span>}
            </dd>
          </div>

          {booking.attendees.length > 0 && (
            <div>
              <dt>Attendees</dt>
              <dd>{booking.attendees.map(a => a.displayName ?? a.email).join(', ')}</dd>
            </div>
          )}
        </dl>

        {booking.description && <p className={s.description}>{booking.description}</p>}

        {booking.cancellationReason && (
          <div className={s.reason}>
            <strong>Reason given:</strong>
            <blockquote>{booking.cancellationReason}</blockquote>
          </div>
        )}

        {hasEnded && !isTerminal && (
          <p className={s.footnote}>
            This meeting has finished. Past bookings cannot be changed by anyone, which keeps the
            record of what actually happened intact.
          </p>
        )}
      </Card>

      {moving && (
        <MoveDialog booking={booking} onClose={() => setMoving(false)} onMoved={() => setMoving(false)} />
      )}
      {cancelling && (
        <CancelDialog
          booking={booking}
          isOwn={isOrganizer}
          onClose={() => setCancelling(false)}
          onCancelled={() => setCancelling(false)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Room finder
// ---------------------------------------------------------------------------

export function FindRoomPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { selected, locations } = useLocationScope()
  const create = useCreateBooking()

  const tz = selected?.timezone ?? 'UTC'
  const [date, setDate] = useState(() => dateInZone(new Date(), tz))
  const [time, setTime] = useState('09:00')
  const [duration, setDuration] = useState(60)
  const [capacity, setCapacity] = useState(1)
  const [allLocations, setAllLocations] = useState(false)
  const [query, setQuery] = useState<{ startsAt: string; endsAt: string } | null>(null)

  const { data: rooms, isPending } = useFindRooms(
    query
      ? {
          ...query,
          locationId: selected?.id,
          minCapacity: capacity > 1 ? capacity : undefined,
          allLocations,
        }
      : null,
  )

  function search() {
    // Built from a plain local date and time; the server interprets it in the
    // room's own zone, which is the only place that decision belongs.
    const [h, m] = time.split(':').map(Number)
    const base = new Date(`${date}T00:00:00Z`)
    const startsAt = new Date(base.getTime() + (h! * 60 + m!) * 60_000 - tzOffsetMinutes(base, tz) * 60_000)
    setQuery({
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + duration * 60_000).toISOString(),
    })
  }

  return (
    <>
      <PageHeader title="Find a room" description="Search by when you need it and how many people." />

      <Card>
        <div className={s.finder}>
          <Field label="Date">
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </Field>
          <Field label="From">
            <Input type="time" step={900} value={time} onChange={e => setTime(e.target.value)} />
          </Field>
          <Field label="For">
            <Select value={duration} onChange={e => setDuration(Number(e.target.value))}>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={90}>1.5 hours</option>
              <option value={120}>2 hours</option>
              <option value={240}>4 hours</option>
            </Select>
          </Field>
          <Field label="People">
            <Input
              type="number"
              min={1}
              value={capacity}
              onChange={e => setCapacity(Number(e.target.value))}
            />
          </Field>
          <Button variant="primary" onClick={search}>
            <Search size={15} aria-hidden /> Search
          </Button>
        </div>

        {locations.length > 1 && (
          <label className={s.allLocations}>
            <input
              type="checkbox"
              checked={allLocations}
              onChange={e => setAllLocations(e.target.checked)}
            />
            Search every location, not just {selected?.name}
          </label>
        )}
      </Card>

      {query && isPending && <Skeleton rows={3} />}

      {query && !isPending && (rooms ?? []).length === 0 && (
        <Card>
          <EmptyState
            title="Nothing free then"
            description="Every room is either booked or outside its bookable hours at that time. Try a different time, or widen the search to other locations."
          />
        </Card>
      )}

      {(rooms ?? []).length > 0 && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>
            {rooms!.length} {rooms!.length === 1 ? 'room is' : 'rooms are'} free
            <span className={s.sectionHint}>Smallest first, so a pair does not take the boardroom</span>
          </h2>

          <div className={s.list}>
            {rooms!.map(room => (
              <div key={room.roomId} className={s.row}>
                <span className={s.rowSwatch} style={{ background: room.colour }} aria-hidden />
                <span className={s.rowMain}>
                  <span className={s.rowTitle}>
                    {room.name}
                    {room.requiresApproval && (
                      <>
                        {' '}
                        <Badge tone="pending">needs approval</Badge>
                      </>
                    )}
                  </span>
                  <span className={s.rowMeta}>
                    {room.capacity} seats
                    {room.floor ? ` · ${room.floor}` : ''} · {room.locationName}
                    {room.features.length > 0 ? ` · ${room.features.map(f => f.name).join(', ')}` : ''}
                  </span>
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  loading={create.isPending}
                  onClick={async () => {
                    if (!query) return
                    try {
                      const result = await create.mutateAsync({
                        roomId: room.roomId,
                        title: 'Meeting',
                        startsAt: query.startsAt,
                        endsAt: query.endsAt,
                      })
                      toast.show(`${room.name} booked`)
                      navigate(`/bookings/${result.data.id}`)
                    } catch (err) {
                      toast.show(
                        err instanceof Error ? err.message : 'Could not book that room',
                        'error',
                      )
                    }
                  }}
                >
                  Book {time}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

/** Offset of a zone at an instant, in minutes east of UTC. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant)
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? '0')
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'))
  return Math.round((asUtc - instant.getTime()) / 60_000)
}
