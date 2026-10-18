/**
 * Admin: one location in detail (S-23) — holidays and effective settings.
 *
 * The settings table is the point: every value says where it came from, so an
 * owner can tell at a glance what this site has decided for itself and what it
 * is merely inheriting. Without that, changing an organization default has
 * unpredictable effects (docs/14-multi-location.md section 4).
 */

import { ArrowLeft, CalendarOff, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'

import { ApiError, api } from '../../api/client.js'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  InfoNotice,
  Input,
  PageHeader,
  Skeleton,
  useToast,
} from '../../components/ui/index.js'
import s from './admin.module.css'

interface Resolved<T> {
  value: T
  source: 'room' | 'location' | 'organization' | 'default'
  inheritedValue: T | null
}

interface EffectiveSettings {
  locationId: string
  locationName: string
  timezone: string
  country: string | null
  businessHoursStart: Resolved<string>
  businessHoursEnd: Resolved<string>
  businessDays: Resolved<number[]>
  minBookingMinutes: Resolved<number>
  maxBookingMinutes: Resolved<number>
  maxAdvanceDays: Resolved<number>
  minNoticeMinutes: Resolved<number>
  reminderLeadMinutes: Resolved<number>
}

interface Holiday {
  id: string
  date: string
  name: string
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function LocationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()

  const settings = useQuery({
    queryKey: ['location-settings', id],
    queryFn: () =>
      api.get<{ data: EffectiveSettings }>(`/locations/${id}/settings/effective`).then(r => r.data),
    enabled: Boolean(id),
  })

  const holidays = useQuery({
    queryKey: ['location-holidays', id],
    queryFn: () => api.get<{ data: Holiday[] }>(`/locations/${id}/holidays`).then(r => r.data),
    enabled: Boolean(id),
  })

  const suggestions = useQuery({
    queryKey: ['holiday-suggestions', id],
    queryFn: () =>
      api.get<{ supported: boolean; country: string | null; holidays: Array<{ date: string; name: string }> }>(
        `/locations/${id}/holidays/suggestions`,
      ),
    enabled: Boolean(id),
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['location-holidays', id] })
    void qc.invalidateQueries({ queryKey: ['holiday-suggestions', id] })
    // Holidays change which days are bookable, so the calendar must refetch.
    void qc.invalidateQueries({ queryKey: ['availability'] })
  }

  const addHolidays = useMutation({
    mutationFn: (list: Array<{ date: string; name: string }>) =>
      api.post(`/locations/${id}/holidays`, { holidays: list }),
    onSuccess: invalidate,
  })

  const removeHoliday = useMutation({
    mutationFn: (date: string) => api.del(`/locations/${id}/holidays/${date}`),
    onSuccess: invalidate,
  })

  const [newDate, setNewDate] = useState('')
  const [newName, setNewName] = useState('')

  if (settings.isPending) return <Skeleton rows={6} />
  if (settings.error) return <ErrorNotice title="Could not load that location" error={settings.error} />

  const data = settings.data!

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => navigate('/admin/locations')}>
        <ArrowLeft size={14} aria-hidden /> All locations
      </Button>

      <PageHeader
        title={data.locationName}
        description={`${data.timezone}${data.country ? ` · ${data.country}` : ''}`}
      />

      <Card>
        <h2 className={s.sectionTitle}>Effective settings</h2>
        <p className={s.sectionHint}>
          What actually applies here, and where each value comes from. Changing an organization
          default moves everything marked <em>Inherited</em>, and nothing marked{' '}
          <em>This location</em>.
        </p>

        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">Value</th>
                <th scope="col">Source</th>
                <th scope="col">If cleared</th>
              </tr>
            </thead>
            <tbody>
              <SettingRow
                label="Working days"
                setting={data.businessDays}
                format={days => days.map(d => DAY_NAMES[d - 1]).join(' ')}
              />
              <SettingRow label="Opens" setting={data.businessHoursStart} format={v => v} />
              <SettingRow label="Closes" setting={data.businessHoursEnd} format={v => v} />
              <SettingRow
                label="Shortest booking"
                setting={data.minBookingMinutes}
                format={minutes}
              />
              <SettingRow
                label="Longest booking"
                setting={data.maxBookingMinutes}
                format={minutes}
              />
              <SettingRow
                label="Bookable ahead"
                setting={data.maxAdvanceDays}
                format={v => `${v} days`}
              />
              <SettingRow
                label="Minimum notice"
                setting={data.minNoticeMinutes}
                format={v => (v === 0 ? 'None' : minutes(v))}
              />
              <SettingRow
                label="Reminder"
                setting={data.reminderLeadMinutes}
                format={v => `${minutes(v)} before`}
              />
            </tbody>
          </table>
        </div>

        <p className={s.footnote}>
          A room can override these again. Blank means inherit; an explicit zero is a real value.
        </p>
      </Card>

      <div className={s.spacedBottom} />

      <Card>
        <h2 className={s.sectionTitle}>
          <CalendarOff size={15} aria-hidden /> Non-working days
        </h2>
        <p className={s.sectionHint}>
          Rooms at this location cannot be booked on these dates. This matters most for recurring
          meetings, which skip them rather than booking a room in a closed building.
        </p>

        {suggestions.data?.supported && suggestions.data.holidays.length > 0 && (
          <div className={s.spacedBottom}>
            <InfoNotice>
              <strong>
                {suggestions.data.holidays.length} public holidays for {suggestions.data.country}{' '}
                are not in your list.
              </strong>
              <p>
                These are suggestions from a built-in list, not an authority — religious holidays
                that follow a lunar calendar are not included, and you should check them.
              </p>
              <div className={s.buttonRow}>
                <Button
                  size="sm"
                  variant="primary"
                  loading={addHolidays.isPending}
                  onClick={async () => {
                    await addHolidays.mutateAsync(suggestions.data!.holidays)
                    toast.show(`${suggestions.data!.holidays.length} dates added`)
                  }}
                >
                  Add all {suggestions.data.holidays.length}
                </Button>
              </div>
            </InfoNotice>
          </div>
        )}

        {suggestions.data && !suggestions.data.supported && suggestions.data.country && (
          <p className={s.muted}>
            No built-in holiday list for {suggestions.data.country}. Add the dates by hand below.
          </p>
        )}

        <form
          className={s.inlineForm}
          onSubmit={async e => {
            e.preventDefault()
            if (!newDate || !newName.trim()) return
            try {
              await addHolidays.mutateAsync([{ date: newDate, name: newName.trim() }])
              toast.show(`${newName.trim()} added`)
              setNewDate('')
              setNewName('')
            } catch (err) {
              toast.show(err instanceof ApiError ? err.message : 'Could not add that date', 'error')
            }
          }}
        >
          <Field label="Date">
            <Input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} />
          </Field>
          <Field label="Name">
            <Input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Office shutdown"
            />
          </Field>
          <Button type="submit" loading={addHolidays.isPending}>
            <Plus size={15} aria-hidden /> Add
          </Button>
        </form>

        {holidays.isPending && <Skeleton rows={2} />}

        {holidays.data && holidays.data.length === 0 && (
          <EmptyState
            title="No non-working days set"
            description="Rooms here are bookable on every working day. Add public holidays or shutdown periods above."
          />
        )}

        {holidays.data && holidays.data.length > 0 && (
          <div className={s.chipList}>
            {holidays.data.map(h => (
              <span key={h.id} className={s.chip}>
                <span className={s.mono}>{h.date}</span>
                {h.name}
                <button
                  type="button"
                  className={s.chipRemove}
                  aria-label={`Remove ${h.name}`}
                  onClick={async () => {
                    await removeHoliday.mutateAsync(h.date)
                    toast.show(`${h.name} removed`)
                  }}
                >
                  <Trash2 size={12} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}

function SettingRow<T>({
  label,
  setting,
  format,
}: {
  label: string
  setting: Resolved<T>
  format: (value: T) => string
}) {
  const overridden = setting.source === 'location' || setting.source === 'room'
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className={s.mono}>{format(setting.value)}</td>
      <td>
        {overridden ? (
          <Badge tone="warning">This location</Badge>
        ) : (
          <Badge tone="neutral">Inherited</Badge>
        )}
      </td>
      <td className={s.muted}>
        {overridden && setting.inheritedValue !== null
          ? format(setting.inheritedValue)
          : '—'}
      </td>
    </tr>
  )
}

function minutes(value: number): string {
  if (value < 60) return `${value} min`
  const hours = value / 60
  return Number.isInteger(hours) ? `${hours} h` : `${Math.floor(hours)}h ${value % 60}m`
}
