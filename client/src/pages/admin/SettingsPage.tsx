/**
 * Admin: organization settings (S-17). Owner only.
 *
 * These are the defaults every location and room inherits from, so the screen
 * says so explicitly — a value changed here moves anything that has not
 * overridden it.
 *
 * The settings endpoint arrives with the booking engine; until then this screen
 * states the active defaults rather than pretending to be editable, which would
 * be a form that silently does nothing.
 */

import { Info } from 'lucide-react'

import { useLocations } from '../../api/hooks.js'
import { Card, InfoNotice, PageHeader, Skeleton } from '../../components/ui/index.js'
import s from './admin.module.css'

/** Mirrors the defaults in prisma/schema.prisma (OrgSettings). */
const DEFAULTS: Array<{ label: string; value: string; note: string }> = [
  { label: 'Working hours', value: '08:00 – 18:00', note: 'Overridable per location and per room' },
  { label: 'Working days', value: 'Monday – Friday', note: 'A Dubai office would override with Sun–Thu' },
  { label: 'Slot size', value: '15 minutes', note: 'The step the calendar grid offers' },
  { label: 'Shortest booking', value: '15 minutes', note: '' },
  { label: 'Longest booking', value: '8 hours', note: '' },
  { label: 'Bookable ahead', value: '90 days', note: 'How far in advance staff may book' },
  { label: 'Minimum notice', value: 'None', note: 'Lead time required before a booking starts' },
  { label: 'Reminder', value: '15 minutes before', note: 'Sent to the organizer' },
  { label: 'Attendee emails', value: 'Organizer only', note: 'Your choice for v1; a single toggle enables attendees later' },
  { label: 'Booking history kept', value: '24 months', note: 'Then archived. Audit records are kept longer' },
  { label: 'Recurring horizon', value: '365 days', note: 'How far ahead a repeating meeting is materialized' },
  { label: 'Approval window', value: '24 hours', note: 'An unanswered request expires and frees the room' },
]

export function SettingsPage() {
  const { data: locations, isPending } = useLocations({ includeInactive: true })

  return (
    <>
      <PageHeader
        title="Organization settings"
        description="The defaults everything inherits from. A location or a room can override most of them."
      />

      <InfoNotice>
        <strong>These are read-only for now.</strong>
        <p>
          The editable form lands with the booking engine, when changing a limit can actually
          affect a booking. Showing an editable form that silently does nothing would be worse than
          showing the real values.
        </p>
      </InfoNotice>

      <div className={s.spacedBottom} />

      <Card>
        <h2 className={s.sectionTitle}>Booking defaults</h2>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">Default</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {DEFAULTS.map(row => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td className={s.mono}>{row.value}</td>
                  <td className={s.muted}>{row.note || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className={s.spacedBottom} />

      <Card>
        <h2 className={s.sectionTitle}>Where these are overridden</h2>
        <p className={s.sectionHint}>
          Resolution order is room, then location, then this page. A blank value inherits; an
          explicit zero is a real value.
        </p>

        {isPending && <Skeleton rows={3} />}

        {!isPending && (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Location</th>
                  <th scope="col">Working days</th>
                  <th scope="col">Hours</th>
                  <th scope="col">Timezone</th>
                </tr>
              </thead>
              <tbody>
                {(locations ?? []).map(l => {
                  const overridesDays = l.businessDays.length > 0
                  const overridesHours = Boolean(l.businessHoursStart)
                  return (
                    <tr key={l.id}>
                      <th scope="row">{l.name}</th>
                      <td className={overridesDays ? undefined : s.muted}>
                        {overridesDays
                          ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                              .filter((_, i) => l.businessDays.includes(i + 1))
                              .join(' ')
                          : 'Inherited'}
                      </td>
                      <td className={overridesHours ? s.mono : s.muted}>
                        {overridesHours
                          ? `${l.businessHoursStart} – ${l.businessHoursEnd}`
                          : 'Inherited'}
                      </td>
                      <td className={s.mono}>{l.timezone}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className={s.footnote}>
        <Info size={13} aria-hidden /> Times are always interpreted in the room location timezone,
        never the browser or the server one.
      </p>
    </>
  )
}
