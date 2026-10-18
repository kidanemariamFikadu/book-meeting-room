/**
 * Series detail (S-25).
 *
 * Shows the rule, every occurrence it produced, and which of them have been
 * changed independently. The exception markers matter: without them a series
 * whose third Tuesday sits in a different room looks like a bug.
 */

import { ArrowLeft, CalendarX, MapPin, Repeat } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { timeInZone } from '@roombook/shared'

import { useSeries } from '../api/hooks.js'
import { StatusBadge } from '../components/booking/BookingDialog.js'
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  PageHeader,
  Skeleton,
} from '../components/ui/index.js'
import s from './calendar.module.css'

export function SeriesPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: series, isPending, error } = useSeries(id)

  if (isPending) return <Skeleton rows={6} />
  if (error || !series) return <ErrorNotice title="Could not load that series" error={error} />

  const tz = series.room.location.timezone
  const now = Date.now()

  const upcoming = series.occurrences.filter(o => new Date(o.endsAt).getTime() >= now)
  const past = series.occurrences.filter(o => new Date(o.endsAt).getTime() < now)

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
        <ArrowLeft size={14} aria-hidden /> Back
      </Button>

      <PageHeader
        title={series.title}
        description={series.pattern}
        actions={
          series.status !== 'ACTIVE' && (
            <Badge tone="neutral">{series.status.toLowerCase()}</Badge>
          )
        }
      />

      <Card>
        <dl className={s.detailGrid}>
          <div>
            <dt>
              <Repeat size={13} aria-hidden /> Repeats
            </dt>
            <dd>{series.pattern}</dd>
          </div>
          <div>
            <dt>
              <MapPin size={13} aria-hidden /> Room
            </dt>
            <dd>
              {series.room.name}
              <span className={s.detailSub}>
                {series.room.location.name} · {tz}
              </span>
            </dd>
          </div>
          <div>
            <dt>Organizer</dt>
            <dd>{series.organizer.fullName}</dd>
          </div>
          <div>
            <dt>Meetings</dt>
            <dd>
              {series.counts.upcoming} upcoming
              <span className={s.detailSub}>
                {series.counts.total} in total
                {series.counts.cancelled > 0 ? `, ${series.counts.cancelled} cancelled` : ''}
                {series.counts.exceptions > 0 ? `, ${series.counts.exceptions} changed` : ''}
              </span>
            </dd>
          </div>
        </dl>

        {/*
          Stated plainly, because it is the rule people find surprising: a
          series-wide change deliberately leaves individually-changed dates
          alone, rather than quietly reverting someone's deliberate move.
        */}
        {series.counts.exceptions > 0 && (
          <p className={s.footnote}>
            {series.counts.exceptions === 1 ? 'One date has' : `${series.counts.exceptions} dates have`}{' '}
            been changed on their own. A change to the whole series will leave them as they are.
          </p>
        )}
      </Card>

      {upcoming.length > 0 && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>
            Upcoming
            <span className={s.sectionHint}>Click any date to open it</span>
          </h2>
          <div className={s.list}>
            {upcoming.map(o => (
              <OccurrenceRow key={o.id} occurrence={o} timeZone={tz} seriesRoom={series.room.name} />
            ))}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>Past</h2>
          <div className={s.list}>
            {past.slice(-10).reverse().map(o => (
              <OccurrenceRow
                key={o.id}
                occurrence={o}
                timeZone={tz}
                seriesRoom={series.room.name}
                muted
              />
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function OccurrenceRow({
  occurrence,
  timeZone,
  seriesRoom,
  muted = false,
}: {
  occurrence: {
    id: string
    startsAt: string
    endsAt: string
    status: string
    isException: boolean
    exceptionFields: string[]
    cancellationReason: string | null
    room: { name: string }
  }
  timeZone: string
  seriesRoom: string
  muted?: boolean
}) {
  const start = new Date(occurrence.startsAt)
  const movedRoom = occurrence.room.name !== seriesRoom

  return (
    <Link
      to={`/bookings/${occurrence.id}`}
      className={muted ? `${s.row} ${s.rowMuted}` : s.row}
    >
      <span className={s.rowMain}>
        <span className={s.rowTitle}>
          {new Intl.DateTimeFormat('en-GB', {
            timeZone,
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }).format(start)}
        </span>
        <span className={s.rowMeta}>
          {timeInZone(start, timeZone)}–{timeInZone(new Date(occurrence.endsAt), timeZone)}
          {movedRoom ? ` · ${occurrence.room.name}` : ''}
          {occurrence.cancellationReason ? ` · ${occurrence.cancellationReason}` : ''}
        </span>
      </span>

      {/* A changed date says what changed, not merely that it differs. */}
      {occurrence.isException && occurrence.status !== 'CANCELLED' && (
        <Badge tone="warning">
          changed{occurrence.exceptionFields.length ? `: ${describeFields(occurrence.exceptionFields)}` : ''}
        </Badge>
      )}
      {occurrence.status === 'CANCELLED' && (
        <Badge tone="neutral">
          <CalendarX size={11} aria-hidden /> skipped
        </Badge>
      )}
      {occurrence.status !== 'CANCELLED' && !occurrence.isException && (
        <StatusBadge status={occurrence.status} />
      )}
    </Link>
  )
}

function describeFields(fields: string[]): string {
  const names: Record<string, string> = {
    roomId: 'room',
    startsAt: 'time',
    endsAt: 'time',
  }
  return [...new Set(fields.map(f => names[f] ?? f))].join(', ')
}
