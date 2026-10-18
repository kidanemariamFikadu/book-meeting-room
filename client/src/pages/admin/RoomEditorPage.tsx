/**
 * Admin: room editor (S-12).
 *
 * Create and edit in one screen. Limits show the value they inherit when left
 * blank, so an admin always knows whether they are reading a default or an
 * override — the commonest source of confusion in a three-level settings model.
 *
 * Specification: docs/07-ui-screens.md, docs/14-multi-location.md section 4.
 */

import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeft } from 'lucide-react'
import { useEffect } from 'react'
import { useFieldArray, useForm } from 'react-hook-form'
import { useNavigate, useParams } from 'react-router-dom'
import { z } from 'zod'

import { applyFieldErrors } from '../../api/client.js'
import {
  useCreateRoom,
  useFeatures,
  useLocations,
  useRoom,
  useUpdateRoom,
  useUsers,
} from '../../api/hooks.js'
import { usePermissions } from '../../auth/AuthProvider.js'
import {
  Button,
  Card,
  Checkbox,
  ErrorNotice,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from '../../components/ui/index.js'
import s from './admin.module.css'

const WEEKDAYS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
]

const ROOM_COLOURS = [
  '#2f5fd0', '#0f7a6c', '#9a4f14', '#7a3fa8', '#19627f',
  '#9c2a62', '#4a6b14', '#b4232a', '#5a5f78', '#0b6ea8',
]

/**
 * A local form schema rather than the shared one.
 *
 * The shared schema describes the API payload, where a blank limit is `null`.
 * An HTML number input yields `''`, so the form models limits as strings and
 * converts on submit — keeping the distinction between "inherit" (blank) and a
 * real `0` explicit rather than accidental.
 */
const formSchema = z.object({
  locationId: z.string().uuid('Choose a location'),
  name: z.string().trim().min(1, 'A room name is required').max(120),
  capacity: z.coerce.number().int().min(1, 'Capacity must be at least 1').max(10000),
  floor: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).optional(),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  featureIds: z.array(z.string()).default([]),
  requiresApproval: z.boolean().default(false),
  approverUserId: z.string().default(''),
  minBookingMinutes: z.string().default(''),
  maxBookingMinutes: z.string().default(''),
  maxAdvanceDays: z.string().default(''),
  minNoticeMinutes: z.string().default(''),
  hours: z
    .array(
      z.object({
        weekday: z.coerce.number().int().min(1).max(7),
        startLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm'),
        endLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm'),
      }),
    )
    .default([]),
})

type FormValues = z.infer<typeof formSchema>

/** Blank means inherit; a number (including 0) is an explicit override. */
const toLimit = (value: string): number | null => (value.trim() === '' ? null : Number(value))

export function RoomEditorPage() {
  const { id } = useParams<{ id: string }>()
  const isNew = id === 'new' || id === undefined
  const navigate = useNavigate()
  const toast = useToast()
  const perms = usePermissions()

  const { data: room, isPending: roomLoading, error: roomError } = useRoom(isNew ? undefined : id)
  const { data: locations } = useLocations()
  const { data: features } = useFeatures()
  const { data: users } = useUsers()

  const create = useCreateRoom()
  const update = useUpdateRoom()

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    setError,
    control,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      locationId: '',
      name: '',
      capacity: 4,
      colour: ROOM_COLOURS[0],
      featureIds: [],
      requiresApproval: false,
      approverUserId: '',
      minBookingMinutes: '',
      maxBookingMinutes: '',
      maxAdvanceDays: '',
      minNoticeMinutes: '',
      hours: [],
    },
  })

  const { fields: hourFields, append, remove } = useFieldArray({ control, name: 'hours' })

  // Default the location once they load, so creating a room needs one fewer click.
  useEffect(() => {
    if (isNew && locations?.length) {
      const first = locations.find(l => l.isActive && perms.administers(l.id))
      if (first) setValue('locationId', first.id)
    }
  }, [isNew, locations, perms, setValue])

  useEffect(() => {
    if (!room) return
    reset({
      locationId: room.location.id,
      name: room.name,
      capacity: room.capacity,
      floor: room.floor ?? '',
      description: room.description ?? '',
      colour: room.colour,
      featureIds: room.features.map(f => f.id),
      requiresApproval: room.requiresApproval,
      approverUserId: room.approver?.id ?? '',
      minBookingMinutes: room.limits.minBookingMinutes?.toString() ?? '',
      maxBookingMinutes: room.limits.maxBookingMinutes?.toString() ?? '',
      maxAdvanceDays: room.limits.maxAdvanceDays?.toString() ?? '',
      minNoticeMinutes: room.limits.minNoticeMinutes?.toString() ?? '',
      hours: room.hours.map(h => ({
        weekday: h.weekday,
        startLocal: h.startLocal,
        endLocal: h.endLocal,
      })),
    })
  }, [room, reset])

  const selectedLocation = locations?.find(l => l.id === watch('locationId'))
  const requiresApproval = watch('requiresApproval')
  const selectedFeatures = watch('featureIds')
  const colour = watch('colour')

  const onSubmit = handleSubmit(async values => {
    const payload = {
      locationId: values.locationId,
      name: values.name,
      capacity: values.capacity,
      floor: values.floor || undefined,
      description: values.description || undefined,
      colour: values.colour,
      featureIds: values.featureIds,
      requiresApproval: values.requiresApproval,
      approverUserId: values.requiresApproval ? values.approverUserId || null : null,
      limits: {
        minBookingMinutes: toLimit(values.minBookingMinutes),
        maxBookingMinutes: toLimit(values.maxBookingMinutes),
        maxAdvanceDays: toLimit(values.maxAdvanceDays),
        minNoticeMinutes: toLimit(values.minNoticeMinutes),
      },
      hours: values.hours,
    }

    try {
      if (isNew) {
        const created = await create.mutateAsync(payload)
        toast.show(`${created.data.name} created`)
        navigate(`/admin/rooms/${created.data.id}`, { replace: true })
      } else {
        await update.mutateAsync({ id: id!, ...payload })
        toast.show('Room saved')
      }
    } catch (err) {
      // A 422 from the server lands on the field it concerns, including rules
      // only the server knows about.
      if (applyFieldErrors(err, setError as never)) return
      setError('root', {
        type: 'server',
        message: err instanceof Error ? err.message : 'Could not save this room',
      })
    }
  })

  if (!isNew && roomError) {
    return <ErrorNotice title="Could not load that room" error={roomError} />
  }
  if (!isNew && roomLoading) return <Skeleton rows={6} />

  const adminLocations = (locations ?? []).filter(l => perms.administers(l.id))
  const approvers = (users ?? []).filter(u => u.role !== 'EMPLOYEE' && u.status === 'ACTIVE')

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => navigate('/admin/rooms')}>
        <ArrowLeft size={14} aria-hidden /> All rooms
      </Button>

      <PageHeader
        title={isNew ? 'Add a room' : (room?.name ?? 'Room')}
        description={
          isNew
            ? 'A new room becomes bookable as soon as you save it.'
            : 'Changes apply immediately. Existing bookings are never invalidated by a change here.'
        }
      />

      {errors.root && (
        <div className={s.spacedBottom}>
          <ErrorNotice title="Could not save" error={new Error(errors.root.message)} />
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className={s.formGrid}>
        <Card>
          <h2 className={s.sectionTitle}>Details</h2>
          <div className={s.twoCol}>
            <Field label="Room name" error={errors.name?.message} required>
              <Input autoFocus placeholder="Boardroom" {...register('name')} />
            </Field>

            <Field
              label="Location"
              error={errors.locationId?.message}
              required
              hint={selectedLocation ? `Times are interpreted in ${selectedLocation.timezone}` : undefined}
            >
              <Select {...register('locationId')} disabled={!isNew && adminLocations.length < 2}>
                <option value="">Choose a location…</option>
                {adminLocations.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Seats" error={errors.capacity?.message} required>
              <Input type="number" min={1} {...register('capacity')} />
            </Field>

            <Field label="Floor" error={errors.floor?.message} hint="Optional">
              <Input placeholder="3rd floor" {...register('floor')} />
            </Field>
          </div>

          <Field label="Description" error={errors.description?.message} hint="Optional. Shown when booking.">
            <Textarea rows={2} {...register('description')} />
          </Field>

          <Field label="Calendar colour" hint="Always shown next to the room name, never on its own.">
            <div className={s.swatchRow} role="radiogroup" aria-label="Calendar colour">
              {ROOM_COLOURS.map(c => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={colour === c}
                  aria-label={`Colour ${c}`}
                  className={colour === c ? `${s.colourDot} ${s.colourDotActive}` : s.colourDot}
                  style={{ background: c }}
                  onClick={() => setValue('colour', c, { shouldDirty: true })}
                />
              ))}
            </div>
          </Field>
        </Card>

        <Card>
          <h2 className={s.sectionTitle}>Equipment</h2>
          {features && features.length > 0 ? (
            <div className={s.featureGrid}>
              {features.map(f => (
                <Checkbox
                  key={f.id}
                  label={f.name}
                  value={f.id}
                  checked={selectedFeatures.includes(f.id)}
                  onChange={e => {
                    const next = e.target.checked
                      ? [...selectedFeatures, f.id]
                      : selectedFeatures.filter(x => x !== f.id)
                    setValue('featureIds', next, { shouldDirty: true })
                  }}
                />
              ))}
            </div>
          ) : (
            <p className={s.muted}>No equipment types defined yet.</p>
          )}
        </Card>

        <Card>
          <h2 className={s.sectionTitle}>Bookable hours</h2>
          <p className={s.sectionHint}>
            Leave empty to inherit{' '}
            {selectedLocation?.businessHoursStart
              ? `${selectedLocation.name} hours (${selectedLocation.businessHoursStart}–${selectedLocation.businessHoursEnd})`
              : 'the organization default'}
            . Times are local wall clock, so they stay correct across a clock change.
          </p>

          {hourFields.length === 0 && <p className={s.muted}>Inheriting — bookable during normal hours.</p>}

          {hourFields.map((field, index) => (
            <div key={field.id} className={s.hourRow}>
              <Select aria-label="Day" {...register(`hours.${index}.weekday`)}>
                {WEEKDAYS.map(d => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </Select>
              <Input aria-label="Opens" type="time" {...register(`hours.${index}.startLocal`)} />
              <span className={s.muted}>to</span>
              <Input aria-label="Closes" type="time" {...register(`hours.${index}.endLocal`)} />
              <Button size="sm" variant="ghost" onClick={() => remove(index)}>
                Remove
              </Button>
            </div>
          ))}

          <div className={s.buttonRow}>
            <Button
              size="sm"
              onClick={() => append({ weekday: 1, startLocal: '08:00', endLocal: '18:00' })}
            >
              Add a window
            </Button>
            {hourFields.length === 0 && (
              <Button
                size="sm"
                onClick={() =>
                  [1, 2, 3, 4, 5].forEach(weekday =>
                    append({ weekday, startLocal: '08:00', endLocal: '18:00' }),
                  )
                }
              >
                Weekdays 08:00–18:00
              </Button>
            )}
          </div>
        </Card>

        <Card>
          <h2 className={s.sectionTitle}>Limits</h2>
          <p className={s.sectionHint}>
            Blank inherits from the location, then the organization. A zero is a real value, not an
            inherit.
          </p>
          <div className={s.twoCol}>
            <Field label="Shortest booking (minutes)" hint="Blank = inherited">
              <Input type="number" min={5} placeholder="inherited" {...register('minBookingMinutes')} />
            </Field>
            <Field label="Longest booking (minutes)" hint="Blank = inherited">
              <Input type="number" min={5} placeholder="inherited" {...register('maxBookingMinutes')} />
            </Field>
            <Field label="Bookable up to (days ahead)" hint="Blank = inherited">
              <Input type="number" min={0} placeholder="inherited" {...register('maxAdvanceDays')} />
            </Field>
            <Field label="Minimum notice (minutes)" hint="Blank = inherited">
              <Input type="number" min={0} placeholder="inherited" {...register('minNoticeMinutes')} />
            </Field>
          </div>
        </Card>

        <Card>
          <h2 className={s.sectionTitle}>Approval</h2>
          <Checkbox
            label="This room needs approval before a booking is confirmed"
            description="Keep this to one or two rooms. Every approval-required room turns an instant action into a wait."
            {...register('requiresApproval')}
          />
          {requiresApproval && (
            <div className={s.indent}>
              <Field
                label="Approver"
                hint="Leave blank so any admin for this location can approve."
                error={errors.approverUserId?.message}
              >
                <Select {...register('approverUserId')}>
                  <option value="">Any admin for this location</option>
                  {approvers.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.fullName} ({u.role.toLowerCase()})
                    </option>
                  ))}
                </Select>
              </Field>
              <p className={s.muted}>
                Approval requests hold the slot so nobody can book over them, and expire if nobody
                responds. The queue itself arrives in a later milestone.
              </p>
            </div>
          )}
        </Card>

        <div className={s.formActions}>
          <Button onClick={() => navigate('/admin/rooms')}>Cancel</Button>
          <Button type="submit" variant="primary" loading={isSubmitting} disabled={!isNew && !isDirty}>
            {isNew ? 'Create room' : 'Save changes'}
          </Button>
        </div>
      </form>
    </>
  )
}
