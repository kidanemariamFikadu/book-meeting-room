/**
 * Admin: locations (S-23). Owner only (BR-L3).
 *
 * Specification: docs/14-multi-location.md section 7.
 */

import { zodResolver } from '@hookform/resolvers/zod'
import { CalendarOff, Clock, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { ApiError, applyFieldErrors } from '../../api/client.js'
import {
  useCreateLocation,
  useDeleteLocation,
  useLocations,
  useSetLocationActive,
  useUpdateLocation,
  type LocationSummary,
} from '../../api/hooks.js'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  Field,
  InfoNotice,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '../../components/ui/index.js'
import s from './admin.module.css'

/**
 * A small curated list rather than the full IANA database.
 *
 * The complete list is ~600 entries and unusable in a dropdown; these cover the
 * common cases and the field accepts any valid name the server recognises.
 */
const TIMEZONES = [
  'Africa/Addis_Ababa', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
  'America/Chicago', 'America/Los_Angeles', 'America/New_York', 'America/Sao_Paulo', 'America/Toronto',
  'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo',
  'Australia/Melbourne', 'Australia/Sydney',
  'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Dublin', 'Europe/Istanbul', 'Europe/London',
  'Europe/Madrid', 'Europe/Paris', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Zurich',
  'UTC',
]

const WEEKDAYS = [
  { value: 1, short: 'Mon' },
  { value: 2, short: 'Tue' },
  { value: 3, short: 'Wed' },
  { value: 4, short: 'Thu' },
  { value: 5, short: 'Fri' },
  { value: 6, short: 'Sat' },
  { value: 7, short: 'Sun' },
]

const formSchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(120),
  code: z.string().trim().max(12).optional(),
  address: z.string().trim().max(500).optional(),
  timezone: z.string().min(1, 'Choose a timezone'),
  country: z.string().trim().length(2, 'Use a two-letter country code').optional().or(z.literal('')),
  businessHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm').optional().or(z.literal('')),
  businessHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm').optional().or(z.literal('')),
  businessDays: z.array(z.number()).default([]),
})

type FormValues = z.infer<typeof formSchema>

export function LocationsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const { data: locations, isPending, error, refetch } = useLocations({ includeInactive: true })

  const create = useCreateLocation()
  const update = useUpdateLocation()
  const setActive = useSetLocationActive()
  const remove = useDeleteLocation()

  const [editing, setEditing] = useState<LocationSummary | 'new' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<LocationSummary | null>(null)

  if (error) {
    return <ErrorNotice title="Could not load locations" error={error} onRetry={() => void refetch()} />
  }

  return (
    <>
      <PageHeader
        title="Locations"
        description="Each site has its own timezone, working days and rooms. Only an owner can change these."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus size={15} aria-hidden /> Add location
          </Button>
        }
      />

      {isPending && <Skeleton rows={3} />}

      {!isPending && (locations ?? []).length === 0 && (
        <Card>
          <EmptyState
            title="No locations yet"
            description="A location holds rooms and sets the timezone they are booked in. Add one to get started."
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus size={15} aria-hidden /> Add location
              </Button>
            }
          />
        </Card>
      )}

      {(locations ?? []).length > 0 && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Location</th>
                <th scope="col">Timezone</th>
                <th scope="col">Local time</th>
                <th scope="col">Working days</th>
                <th scope="col">Rooms</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(locations ?? []).map(l => (
                <tr key={l.id} className={l.isActive ? undefined : s.rowInactive}>
                  <th scope="row">
                    {l.name}
                    {l.code && <span className={s.code}>{l.code}</span>}
                    {l.address && <p className={s.subtle}>{l.address}</p>}
                  </th>
                  <td className={s.mono}>{l.timezone}</td>
                  <td className={s.mono}>
                    <Clock size={12} aria-hidden /> {l.currentLocalTime}
                  </td>
                  <td className={s.muted}>
                    {l.businessDays.length > 0
                      ? WEEKDAYS.filter(d => l.businessDays.includes(d.value))
                          .map(d => d.short)
                          .join(' ')
                      : 'Inherited'}
                    {l.businessHoursStart && (
                      <span className={s.subtle}>
                        {' '}
                        {l.businessHoursStart}–{l.businessHoursEnd}
                      </span>
                    )}
                  </td>
                  <td>{l.roomCount}</td>
                  <td>
                    {l.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}
                  </td>
                  <td className={s.actions}>
                    <Button
                      size="sm"
                      onClick={() => navigate(`/admin/locations/${l.id}`)}
                      aria-label={`Hours and holidays for ${l.name}`}
                    >
                      <CalendarOff size={13} aria-hidden /> Hours &amp; holidays
                    </Button>
                    <Button size="sm" onClick={() => setEditing(l)} aria-label={`Edit ${l.name}`}>
                      <Pencil size={13} aria-hidden /> Edit
                    </Button>
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          await setActive.mutateAsync({ id: l.id, isActive: !l.isActive })
                          toast.show(`${l.name} ${l.isActive ? 'deactivated' : 'activated'}`)
                        } catch {
                          toast.show('Could not change that location', 'error')
                        }
                      }}
                    >
                      {l.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(l)}
                      aria-label={`Delete ${l.name}`}
                    >
                      <Trash2 size={13} aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <LocationDialog
          location={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async values => {
            const payload = {
              name: values.name,
              code: values.code || undefined,
              address: values.address || undefined,
              timezone: values.timezone,
              country: values.country ? values.country.toUpperCase() : undefined,
              businessHoursStart: values.businessHoursStart || null,
              businessHoursEnd: values.businessHoursEnd || null,
              businessDays: values.businessDays,
            }
            if (editing === 'new') {
              await create.mutateAsync(payload)
              toast.show(`${values.name} created`)
            } else {
              await update.mutateAsync({ id: editing.id, ...payload })
              toast.show('Location saved')
            }
            setEditing(null)
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onOpenChange={open => !open && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name ?? ''}?`}
        consequence={
          <>
            <p>This removes the location permanently and cannot be undone.</p>
            <div className={s.spaced}>
              <InfoNotice>
                <strong>A location with rooms cannot be deleted.</strong>
                <p>
                  Move or delete its rooms first, or deactivate the location instead — it then
                  disappears from the switcher while everything it holds is kept.
                </p>
              </InfoNotice>
            </div>
          </>
        }
        confirmLabel="Delete location"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          if (!confirmDelete) return
          try {
            await remove.mutateAsync(confirmDelete.id)
            toast.show(`${confirmDelete.name} deleted`)
            setConfirmDelete(null)
          } catch (err) {
            toast.show(err instanceof ApiError ? err.message : 'Could not delete', 'error')
            setConfirmDelete(null)
          }
        }}
      />
    </>
  )
}

function LocationDialog({
  location,
  onClose,
  onSave,
}: {
  location: LocationSummary | null
  onClose: () => void
  onSave: (values: FormValues) => Promise<void>
}) {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      code: '',
      address: '',
      timezone: 'UTC',
      country: '',
      businessHoursStart: '',
      businessHoursEnd: '',
      businessDays: [],
    },
  })

  useEffect(() => {
    if (!location) return
    reset({
      name: location.name,
      code: location.code ?? '',
      address: location.address ?? '',
      timezone: location.timezone,
      country: location.country ?? '',
      businessHoursStart: location.businessHoursStart ?? '',
      businessHoursEnd: location.businessHoursEnd ?? '',
      businessDays: location.businessDays,
    })
  }, [location, reset])

  const days = watch('businessDays')
  const timezone = watch('timezone')

  const submit = handleSubmit(async values => {
    try {
      await onSave(values)
    } catch (err) {
      if (applyFieldErrors(err, setError as never)) return
      setError('root', {
        type: 'server',
        message: err instanceof Error ? err.message : 'Could not save',
      })
    }
  })

  // Shows the chosen zone immediately, so a mistake is obvious before saving.
  let preview = ''
  try {
    preview = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date())
  } catch {
    preview = ''
  }

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={location ? `Edit ${location.name}` : 'Add a location'}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={isSubmitting} onClick={() => void submit()}>
            {location ? 'Save changes' : 'Create location'}
          </Button>
        </>
      }
    >
      {errors.root && <ErrorNotice title="Could not save" error={new Error(errors.root.message)} />}

      <div className={s.twoCol}>
        <Field label="Name" error={errors.name?.message} required>
          <Input autoFocus placeholder="Head Office" {...register('name')} />
        </Field>
        <Field label="Short code" error={errors.code?.message} hint="Optional, for dense screens">
          <Input placeholder="HQ" {...register('code')} />
        </Field>
      </div>

      <Field label="Address" error={errors.address?.message} hint="Appears in booking emails and calendar invitations">
        <Input placeholder="Bole Road, Addis Ababa" {...register('address')} />
      </Field>

      <div className={s.twoCol}>
        <Field
          label="Timezone"
          error={errors.timezone?.message}
          required
          hint={preview ? `It is currently ${preview} there` : 'Not a recognised timezone'}
        >
          <Select {...register('timezone')}>
            {TIMEZONES.map(tz => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Country" error={errors.country?.message} hint="Two letters, seeds the holiday calendar">
          <Input placeholder="ET" maxLength={2} {...register('country')} />
        </Field>
      </div>

      <Field
        label="Working days"
        hint="Leave all unticked to inherit the organization default. A Dubai office works Sunday to Thursday."
      >
        <div className={s.dayRow}>
          {WEEKDAYS.map(d => {
            const on = days.includes(d.value)
            return (
              <button
                key={d.value}
                type="button"
                aria-pressed={on}
                className={on ? `${s.dayChip} ${s.dayChipOn}` : s.dayChip}
                onClick={() =>
                  setValue(
                    'businessDays',
                    on ? days.filter(x => x !== d.value) : [...days, d.value].sort(),
                    { shouldDirty: true },
                  )
                }
              >
                {d.short}
              </button>
            )
          })}
        </div>
      </Field>

      <div className={s.twoCol}>
        <Field label="Opens" error={errors.businessHoursStart?.message} hint="Blank = inherited">
          <Input type="time" {...register('businessHoursStart')} />
        </Field>
        <Field label="Closes" error={errors.businessHoursEnd?.message} hint="Blank = inherited">
          <Input type="time" {...register('businessHoursEnd')} />
        </Field>
      </div>
    </Modal>
  )
}
