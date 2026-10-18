/**
 * Your own account (S-10), the home placeholder, and the equipment list.
 *
 * Grouped because each is small, and splitting them would add files without
 * adding clarity.
 */

import { zodResolver } from '@hookform/resolvers/zod'
import { CalendarDays, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'
import { z } from 'zod'

import { ApiError, applyFieldErrors } from '../api/client.js'
import {
  useChangePassword,
  useCreateFeature,
  useDeleteFeature,
  useFeatures,
  useRooms,
  useUpdateProfile,
} from '../api/hooks.js'
import { useCurrentUser, usePermissions } from '../auth/AuthProvider.js'
import { useLocationScope } from '../hooks/useLocationScope.js'
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
  Select,
  Skeleton,
  useToast,
} from '../components/ui/index.js'
import s from './admin/admin.module.css'

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  fullName: z.string().trim().min(1, 'Enter your name').max(120),
  timezone: z.string().default(''),
  homeLocationId: z.string().default(''),
})

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(12, 'Use at least 12 characters'),
  })
  .refine(v => v.currentPassword !== v.newPassword, {
    message: 'The new password must differ from the current one',
    path: ['newPassword'],
  })

export function AccountPage() {
  const me = useCurrentUser()
  const toast = useToast()
  const { locations } = useLocationScope()

  const updateProfile = useUpdateProfile()
  const changePassword = useChangePassword()

  const profile = useForm<z.infer<typeof profileSchema>>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      fullName: me.fullName,
      timezone: me.timezone ?? '',
      homeLocationId: me.homeLocationId ?? '',
    },
  })

  const password = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '' },
  })

  return (
    <>
      <PageHeader title="Your account" description={me.email} />

      <div className={s.formGrid}>
        <Card>
          <h2 className={s.sectionTitle}>Profile</h2>
          <form
            className={s.stack}
            noValidate
            onSubmit={profile.handleSubmit(async values => {
              try {
                await updateProfile.mutateAsync({
                  fullName: values.fullName,
                  timezone: values.timezone || null,
                  homeLocationId: values.homeLocationId || null,
                })
                toast.show('Profile saved')
                profile.reset(values)
              } catch (err) {
                if (applyFieldErrors(err, profile.setError as never)) return
                toast.show('Could not save your profile', 'error')
              }
            })}
          >
            <Field label="Your name" error={profile.formState.errors.fullName?.message} required>
              <Input {...profile.register('fullName')} />
            </Field>

            <Field
              label="Home location"
              hint="Where the app opens, and the timezone times are shown in by default."
            >
              <Select {...profile.register('homeLocationId')}>
                <option value="">No preference</option>
                {locations.map(l => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.timezone})
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Display timezone"
              hint="Overrides your home location when you travel. Booking times are always interpreted in the room own timezone."
            >
              <Input placeholder="e.g. Europe/London — leave blank to follow your location" {...profile.register('timezone')} />
            </Field>

            <div className={s.formActions}>
              <Button
                type="submit"
                variant="primary"
                loading={profile.formState.isSubmitting}
                disabled={!profile.formState.isDirty}
              >
                Save profile
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <h2 className={s.sectionTitle}>Password</h2>
          <form
            className={s.stack}
            noValidate
            onSubmit={password.handleSubmit(async values => {
              try {
                await changePassword.mutateAsync(values)
                // Everywhere else is signed out, which is the point.
                toast.show('Password changed. Other devices have been signed out.')
                password.reset()
              } catch (err) {
                if (applyFieldErrors(err, password.setError as never)) return
                password.setError('root', {
                  type: 'server',
                  message: err instanceof ApiError ? err.message : 'Could not change your password',
                })
              }
            })}
          >
            {password.formState.errors.root && (
              <ErrorNotice
                title="Could not change password"
                error={new Error(password.formState.errors.root.message)}
              />
            )}

            <Field
              label="Current password"
              error={password.formState.errors.currentPassword?.message}
              required
            >
              <Input type="password" autoComplete="current-password" {...password.register('currentPassword')} />
            </Field>

            <Field
              label="New password"
              error={password.formState.errors.newPassword?.message}
              hint="At least 12 characters. A memorable phrase beats a short, complex password."
              required
            >
              <Input type="password" autoComplete="new-password" {...password.register('newPassword')} />
            </Field>

            <InfoNotice>
              Changing your password signs you out on every other device, and you will be emailed a
              notice either way — that is how you would find out if it was not you.
            </InfoNotice>

            <div className={s.formActions}>
              <Button type="submit" variant="primary" loading={password.formState.isSubmitting}>
                Change password
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

/**
 * The landing page until the calendar lands in M3.
 *
 * Shows the real room data rather than a placeholder, so there is something
 * genuinely useful here and the configuration can be checked at a glance.
 */
export function HomePage() {
  const me = useCurrentUser()
  const perms = usePermissions()
  const { selected, locations } = useLocationScope()
  const { data: rooms, isPending } = useRooms(
    selected ? { locationId: selected.id } : {},
  )

  return (
    <>
      <PageHeader
        title={`Hello, ${me.fullName.split(' ')[0]}`}
        description={
          selected
            ? `${selected.name} — it is ${selected.currentLocalTime} there now.`
            : 'No locations have been set up yet.'
        }
      />

      <InfoNotice>
        <strong>The calendar arrives in the next milestone.</strong>
        <p>
          Rooms, locations and accounts are fully working now. Booking, the day grid and the room
          finder are next.
        </p>
      </InfoNotice>

      <section className={s.group}>
        <h2 className={s.groupTitle}>
          Bookable rooms
          {selected && <span className={s.groupCount}>{selected.name}</span>}
        </h2>

        {isPending && <Skeleton rows={4} />}

        {!isPending && (rooms ?? []).length === 0 && (
          <Card>
            <EmptyState
              title="No rooms here yet"
              description={
                perms.isAdmin
                  ? 'Add a room and it will appear here straight away.'
                  : 'Ask your office admin to add the meeting rooms for this location.'
              }
              action={
                perms.isAdmin && (
                  <Button variant="primary" onClick={() => undefined}>
                    <Link to="/admin/rooms/new" className={s.plainLink}>
                      <Plus size={15} aria-hidden /> Add room
                    </Link>
                  </Button>
                )
              }
            />
          </Card>
        )}

        {(rooms ?? []).length > 0 && (
          <div className={s.roomCards}>
            {(rooms ?? []).map(room => (
              <Card key={room.id} className={s.roomCard}>
                <div className={s.roomCardHead}>
                  <span className={s.swatch} style={{ background: room.colour }} aria-hidden />
                  <strong>{room.name}</strong>
                  {room.requiresApproval && <Badge tone="pending">needs approval</Badge>}
                </div>
                <p className={s.subtle}>
                  {room.capacity} {room.capacity === 1 ? 'seat' : 'seats'}
                  {room.floor ? ` · ${room.floor}` : ''}
                </p>
                <p className={s.muted}>
                  {room.features.length > 0 ? room.features.map(f => f.name).join(', ') : 'No equipment listed'}
                </p>
              </Card>
            ))}
          </div>
        )}
      </section>

      {locations.length > 1 && (
        <p className={s.footnote}>
          <CalendarDays size={13} aria-hidden /> You are viewing {selected?.name}. Use the location
          switcher to see another site.
        </p>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Equipment types
// ---------------------------------------------------------------------------

/** Admin: the canonical equipment list rooms are tagged with. */
export function FeaturesPage() {
  const toast = useToast()
  const { data: features, isPending } = useFeatures()
  const create = useCreateFeature()
  const remove = useDeleteFeature()
  const [name, setName] = useState('')

  return (
    <>
      <PageHeader
        title="Equipment"
        description="The list people filter rooms by. Keep it short — a filter with thirty options is not a filter."
      />

      <Card>
        <form
          className={s.inlineForm}
          onSubmit={async e => {
            e.preventDefault()
            if (!name.trim()) return
            try {
              await create.mutateAsync({ name: name.trim() })
              toast.show(`${name.trim()} added`)
              setName('')
            } catch (err) {
              toast.show(err instanceof ApiError ? err.message : 'Could not add that', 'error')
            }
          }}
        >
          <Field label="Add equipment type">
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Projector, Whiteboard, Video conference…"
            />
          </Field>
          <Button type="submit" variant="primary" loading={create.isPending}>
            <Plus size={15} aria-hidden /> Add
          </Button>
        </form>
      </Card>

      {isPending && <Skeleton rows={3} />}

      {!isPending && (
        <div className={s.chipList}>
          {(features ?? []).map(f => (
            <span key={f.id} className={s.chip}>
              {f.name}
              <span className={s.chipCount}>{f._count.rooms}</span>
              <button
                type="button"
                className={s.chipRemove}
                aria-label={`Remove ${f.name}`}
                onClick={async () => {
                  try {
                    await remove.mutateAsync(f.id)
                    toast.show(`${f.name} removed`)
                  } catch {
                    toast.show('Could not remove that', 'error')
                  }
                }}
              >
                <Trash2 size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      <p className={s.footnote}>
        Removing an equipment type untags the rooms that had it. No room is deleted.
      </p>
    </>
  )
}
