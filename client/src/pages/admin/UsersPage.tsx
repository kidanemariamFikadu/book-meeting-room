/**
 * Admin: users (S-16). Owner only (BR-U6).
 *
 * Appointing an admin and scoping them to locations is ONE action, because
 * doing it in two steps is how an admin ends up with access nobody intended
 * (D17).
 *
 * Specification: docs/14-multi-location.md section 7.
 */

import { zodResolver } from '@hookform/resolvers/zod'
import { Mail, Plus, UserCog } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { ApiError, applyFieldErrors } from '../../api/client.js'
import {
  useInviteUser,
  useLocations,
  useResendInvite,
  useSetUserStatus,
  useUpdateUser,
  useUsers,
  type UserRow,
} from '../../api/hooks.js'
import { useCurrentUser } from '../../auth/AuthProvider.js'
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
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

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  fullName: z.string().trim().min(1, 'Enter their name').max(120),
  role: z.enum(['EMPLOYEE', 'ADMIN', 'OWNER']),
  homeLocationId: z.string().default(''),
  locationIds: z.array(z.string()).default([]),
})

type InviteValues = z.infer<typeof inviteSchema>

const ROLE_HELP: Record<string, string> = {
  EMPLOYEE: 'Can see every room and book one. Manages only their own bookings.',
  ADMIN: 'Also manages rooms, and can move or cancel anyone booking — within the locations you tick below.',
  OWNER: 'Everything an admin can do, plus users, locations and organization settings.',
}

export function UsersPage() {
  const me = useCurrentUser()
  const toast = useToast()

  const { data: users, isPending, error, refetch } = useUsers({ includeDisabled: true })
  const { data: locations } = useLocations({ includeInactive: true })

  const invite = useInviteUser()
  const update = useUpdateUser()
  const resend = useResendInvite()
  const setStatus = useSetUserStatus()

  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [confirmDeactivate, setConfirmDeactivate] = useState<UserRow | null>(null)
  const [deactivateBlocked, setDeactivateBlocked] = useState<string | null>(null)

  if (error) {
    return <ErrorNotice title="Could not load users" error={error} onRetry={() => void refetch()} />
  }

  const activeOwners = (users ?? []).filter(u => u.role === 'OWNER' && u.status === 'ACTIVE').length

  return (
    <>
      <PageHeader
        title="Users"
        description="Invite staff and decide who can manage rooms. Nobody is sent a password — each person sets their own."
        actions={
          <Button variant="primary" onClick={() => setInviting(true)}>
            <Plus size={15} aria-hidden /> Invite someone
          </Button>
        }
      />

      {isPending && <Skeleton rows={5} />}

      {!isPending && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Administers</th>
                <th scope="col">Home</th>
                <th scope="col">Last signed in</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map(u => {
                const isSelf = u.id === me.id
                // The last owner must keep their role, or nobody can administer.
                const isLastOwner = u.role === 'OWNER' && activeOwners <= 1
                return (
                  <tr key={u.id} className={u.status === 'DISABLED' ? s.rowInactive : undefined}>
                    <th scope="row">
                      {u.fullName}
                      {isSelf && <span className={s.code}>you</span>}
                      <p className={s.subtle}>{u.email}</p>
                    </th>
                    <td>
                      <Badge tone={u.role === 'OWNER' ? 'pending' : u.role === 'ADMIN' ? 'warning' : 'neutral'}>
                        {u.role.toLowerCase()}
                      </Badge>
                    </td>
                    <td className={s.muted}>
                      {u.role === 'EMPLOYEE'
                        ? '—'
                        : u.locationAccess.length === 0
                          ? 'All locations'
                          : u.locationAccess.map(a => a.location.name).join(', ')}
                    </td>
                    <td className={s.muted}>{u.homeLocation?.name ?? '—'}</td>
                    <td className={s.muted}>
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}
                    </td>
                    <td>
                      {u.status === 'ACTIVE' && <Badge tone="success">Active</Badge>}
                      {u.status === 'INVITED' && <Badge tone="warning">Invited</Badge>}
                      {u.status === 'DISABLED' && <Badge tone="neutral">Deactivated</Badge>}
                      {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                        <>
                          {' '}
                          <Badge tone="danger">locked</Badge>
                        </>
                      )}
                    </td>
                    <td className={s.actions}>
                      <Button size="sm" onClick={() => setEditing(u)} aria-label={`Edit ${u.fullName}`}>
                        <UserCog size={13} aria-hidden /> Edit
                      </Button>
                      {u.status === 'INVITED' && (
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              await resend.mutateAsync(u.id)
                              toast.show('Invitation resent — the previous link no longer works')
                            } catch {
                              toast.show('Could not resend', 'error')
                            }
                          }}
                        >
                          <Mail size={13} aria-hidden /> Resend
                        </Button>
                      )}
                      {u.status !== 'DISABLED' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isSelf || isLastOwner}
                          title={
                            isSelf
                              ? 'You cannot deactivate your own account'
                              : isLastOwner
                                ? 'Promote another owner first'
                                : undefined
                          }
                          onClick={() => setConfirmDeactivate(u)}
                        >
                          Deactivate
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={async () => {
                            await setStatus.mutateAsync({ id: u.id, active: true })
                            toast.show(`${u.fullName} reactivated`)
                          }}
                        >
                          Reactivate
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {inviting && (
        <UserDialog
          title="Invite someone"
          locations={locations ?? []}
          submitLabel="Send invitation"
          onClose={() => setInviting(false)}
          onSave={async values => {
            await invite.mutateAsync({
              email: values.email,
              fullName: values.fullName,
              role: values.role,
              homeLocationId: values.homeLocationId || undefined,
              locationAccess:
                values.role === 'ADMIN' ? { locationIds: values.locationIds } : undefined,
            })
            toast.show(`Invitation sent to ${values.email}`)
            setInviting(false)
          }}
        />
      )}

      {editing && (
        <UserDialog
          title={`Edit ${editing.fullName}`}
          locations={locations ?? []}
          submitLabel="Save changes"
          user={editing}
          lockRole={editing.id === me.id}
          onClose={() => setEditing(null)}
          onSave={async values => {
            await update.mutateAsync({
              id: editing.id,
              fullName: values.fullName,
              ...(editing.id === me.id ? {} : { role: values.role }),
              homeLocationId: values.homeLocationId || null,
              ...(editing.id === me.id
                ? {}
                : { locationAccess: { locationIds: values.role === 'ADMIN' ? values.locationIds : [] } }),
            })
            toast.show('User saved')
            setEditing(null)
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(confirmDeactivate)}
        onOpenChange={open => {
          if (!open) {
            setConfirmDeactivate(null)
            setDeactivateBlocked(null)
          }
        }}
        title={`Deactivate ${confirmDeactivate?.fullName ?? ''}?`}
        consequence={
          <>
            <p>
              They are signed out immediately and cannot sign in again. Their past bookings and the
              audit history stay exactly as they are.
            </p>
            <p className={s.spaced}>You can reactivate the account later.</p>
            {deactivateBlocked && (
              <div className={s.spaced}>
                <ErrorNotice title="They have future bookings" error={new Error(deactivateBlocked)} />
              </div>
            )}
          </>
        }
        confirmLabel={deactivateBlocked ? 'Deactivate anyway' : 'Deactivate'}
        destructive
        loading={setStatus.isPending}
        onConfirm={async () => {
          if (!confirmDeactivate) return
          try {
            await setStatus.mutateAsync({
              id: confirmDeactivate.id,
              active: false,
              force: Boolean(deactivateBlocked),
            })
            toast.show(`${confirmDeactivate.fullName} deactivated`)
            setConfirmDeactivate(null)
            setDeactivateBlocked(null)
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) setDeactivateBlocked(err.message)
            else toast.show('Could not deactivate', 'error')
          }
        }}
      />
    </>
  )
}

function UserDialog({
  title,
  user,
  locations,
  submitLabel,
  lockRole = false,
  onClose,
  onSave,
}: {
  title: string
  user?: UserRow
  locations: Array<{ id: string; name: string; isActive: boolean }>
  submitLabel: string
  lockRole?: boolean
  onClose: () => void
  onSave: (values: InviteValues) => Promise<void>
}) {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: {
      email: '',
      fullName: '',
      role: 'EMPLOYEE',
      homeLocationId: '',
      locationIds: [],
    },
  })

  useEffect(() => {
    if (!user) return
    reset({
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      homeLocationId: user.homeLocationId ?? '',
      locationIds: user.locationAccess.map(a => a.locationId),
    })
  }, [user, reset])

  const role = watch('role')
  const grants = watch('locationIds')

  const submit = handleSubmit(async values => {
    try {
      await onSave(values)
    } catch (err) {
      if (applyFieldErrors(err, setError as never)) return
      setError('root', { type: 'server', message: err instanceof Error ? err.message : 'Could not save' })
    }
  })

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={title}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={isSubmitting} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      {errors.root && <ErrorNotice title="Could not save" error={new Error(errors.root.message)} />}

      <div className={s.twoCol}>
        <Field label="Full name" error={errors.fullName?.message} required>
          <Input autoFocus {...register('fullName')} />
        </Field>
        <Field
          label="Work email"
          error={errors.email?.message}
          required
          hint={user ? 'Changing an email address is not supported yet' : undefined}
        >
          <Input type="email" disabled={Boolean(user)} {...register('email')} />
        </Field>
      </div>

      <Field
        label="Role"
        error={errors.role?.message}
        hint={lockRole ? 'You cannot change your own role.' : ROLE_HELP[role]}
        required
      >
        <Select disabled={lockRole} {...register('role')}>
          <option value="EMPLOYEE">Employee</option>
          <option value="ADMIN">Office admin</option>
          <option value="OWNER">Owner</option>
        </Select>
      </Field>

      {/* Grants only mean something for an admin: an owner already has
          everything, and an employee administers nothing. */}
      {role === 'ADMIN' && !lockRole && (
        <Field
          label="Administers these locations"
          hint="Leave every box unticked for organization-wide access."
        >
          <div className={s.grantList}>
            {locations.map(l => (
              <Checkbox
                key={l.id}
                label={l.isActive ? l.name : `${l.name} (inactive)`}
                checked={grants.includes(l.id)}
                onChange={e =>
                  setValue(
                    'locationIds',
                    e.target.checked ? [...grants, l.id] : grants.filter(x => x !== l.id),
                    { shouldDirty: true },
                  )
                }
              />
            ))}
          </div>
        </Field>
      )}

      <Field label="Home location" hint="Where the app opens for them, and their default timezone.">
        <Select {...register('homeLocationId')}>
          <option value="">No preference</option>
          {locations.map(l => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
      </Field>

      {!user && (
        <InfoNotice>
          They receive an email with a single-use link to choose their own password. No password is
          ever sent to anyone.
        </InfoNotice>
      )}
    </Modal>
  )
}
