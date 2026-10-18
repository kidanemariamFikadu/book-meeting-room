/**
 * Admin: rooms (S-11).
 *
 * Grouped by location, because in a multi-site organization a flat list of
 * forty rooms tells you nothing about where any of them are.
 *
 * Specification: docs/07-ui-screens.md, docs/14-multi-location.md.
 */

import { AlertTriangle, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { ApiError } from '../../api/client.js'
import {
  useDeleteRoom,
  useLocations,
  useRooms,
  useSetRoomActive,
  type RoomSummary,
} from '../../api/hooks.js'
import { usePermissions } from '../../auth/AuthProvider.js'
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorNotice,
  InfoNotice,
  PageHeader,
  Skeleton,
  useToast,
} from '../../components/ui/index.js'
import s from './admin.module.css'

export function RoomsPage() {
  const navigate = useNavigate()
  const perms = usePermissions()
  const toast = useToast()

  const { data: rooms, isPending, error, refetch } = useRooms({ includeInactive: true })
  const { data: locations } = useLocations({ includeInactive: true })

  const setActive = useSetRoomActive()
  const deleteRoom = useDeleteRoom()

  const [confirmDelete, setConfirmDelete] = useState<RoomSummary | null>(null)
  const [confirmDeactivate, setConfirmDeactivate] = useState<RoomSummary | null>(null)
  const [deactivateBlocked, setDeactivateBlocked] = useState<string | null>(null)

  /** Grouped by location, preserving the server's ordering within each group. */
  const grouped = useMemo(() => {
    const groups = new Map<string, { name: string; rooms: RoomSummary[] }>()
    for (const room of rooms ?? []) {
      const existing = groups.get(room.location.id)
      if (existing) existing.rooms.push(room)
      else groups.set(room.location.id, { name: room.location.name, rooms: [room] })
    }
    return [...groups.entries()]
  }, [rooms])

  const canCreate = (locations ?? []).some(l => l.isActive && perms.administers(l.id))

  if (error) {
    return <ErrorNotice title="Could not load rooms" error={error} onRetry={() => void refetch()} />
  }

  return (
    <>
      <PageHeader
        title="Rooms"
        description="Add, edit and retire the rooms people can book. Changes take effect immediately."
        actions={
          canCreate && (
            <Button variant="primary" onClick={() => navigate('/admin/rooms/new')}>
              <Plus size={15} aria-hidden /> Add room
            </Button>
          )
        }
      />

      {isPending && <Skeleton rows={5} />}

      {!isPending && grouped.length === 0 && (
        <Card>
          <EmptyState
            title="No rooms yet"
            description={
              canCreate
                ? 'Add your first room and it will appear on the calendar straight away.'
                : 'No rooms have been set up for the locations you administer.'
            }
            action={
              canCreate && (
                <Button variant="primary" onClick={() => navigate('/admin/rooms/new')}>
                  <Plus size={15} aria-hidden /> Add room
                </Button>
              )
            }
          />
        </Card>
      )}

      {grouped.map(([locationId, group]) => {
        const administers = perms.administers(locationId)
        return (
          <section key={locationId} className={s.group}>
            <h2 className={s.groupTitle}>
              {group.name}
              <span className={s.groupCount}>
                {group.rooms.length} {group.rooms.length === 1 ? 'room' : 'rooms'}
              </span>
              {/* A scoped admin sees other sites but cannot change them (BR-L1). */}
              {!administers && <Badge tone="neutral">view only</Badge>}
            </h2>

            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th scope="col">Room</th>
                    <th scope="col">Seats</th>
                    <th scope="col">Floor</th>
                    <th scope="col">Features</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.rooms.map(room => (
                    <tr key={room.id} className={room.isActive ? undefined : s.rowInactive}>
                      <th scope="row" className={s.roomCell}>
                        {/* The colour never stands alone: the name is always beside it. */}
                        <span className={s.swatch} style={{ background: room.colour }} aria-hidden />
                        <span>
                          {room.name}
                          {room.requiresApproval && (
                            <>
                              {' '}
                              <Badge tone="pending">needs approval</Badge>
                            </>
                          )}
                        </span>
                      </th>
                      <td>{room.capacity}</td>
                      <td className={s.muted}>{room.floor ?? '—'}</td>
                      <td className={s.muted}>
                        {room.features.length > 0
                          ? room.features.map(f => f.name).join(', ')
                          : 'None'}
                      </td>
                      <td>
                        {room.isActive ? (
                          <Badge tone="success">Active</Badge>
                        ) : (
                          <Badge tone="neutral">Inactive</Badge>
                        )}
                      </td>
                      <td className={s.actions}>
                        {administers && (
                          <>
                            <Button
                              size="sm"
                              onClick={() => navigate(`/admin/rooms/${room.id}`)}
                              aria-label={`Edit ${room.name}`}
                            >
                              <Pencil size={13} aria-hidden /> Edit
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => {
                                if (room.isActive) setConfirmDeactivate(room)
                                else void setActive.mutateAsync({ id: room.id, isActive: true })
                              }}
                            >
                              {room.isActive ? 'Deactivate' : 'Activate'}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmDelete(room)}
                              aria-label={`Delete ${room.name}`}
                            >
                              <Trash2 size={13} aria-hidden />
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}

      {/* Deactivation: the admin must be told what they are about to orphan. */}
      <ConfirmDialog
        open={Boolean(confirmDeactivate)}
        onOpenChange={open => {
          if (!open) {
            setConfirmDeactivate(null)
            setDeactivateBlocked(null)
          }
        }}
        title={`Deactivate ${confirmDeactivate?.name ?? ''}?`}
        consequence={
          <>
            <p>
              The room disappears from the calendar and the room finder, and nobody can make a new
              booking in it. Existing bookings are left exactly as they are, and all its history is
              kept.
            </p>
            <p className={s.spaced}>You can activate it again at any time.</p>
            {deactivateBlocked && (
              <div className={s.spaced}>
                <ErrorNotice title="Future bookings exist" error={new Error(deactivateBlocked)} />
              </div>
            )}
          </>
        }
        confirmLabel={deactivateBlocked ? 'Deactivate anyway' : 'Deactivate'}
        destructive
        loading={setActive.isPending}
        onConfirm={async () => {
          if (!confirmDeactivate) return
          try {
            await setActive.mutateAsync({
              id: confirmDeactivate.id,
              isActive: false,
              // Forced only on the second attempt, after the warning has been read.
              force: Boolean(deactivateBlocked),
            })
            toast.show(`${confirmDeactivate.name} deactivated`)
            setConfirmDeactivate(null)
            setDeactivateBlocked(null)
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) setDeactivateBlocked(err.message)
            else toast.show('Could not deactivate that room', 'error')
          }
        }}
      />

      {/* Deletion: permitted only when nothing references the room (BR-R3). */}
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onOpenChange={open => !open && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name ?? ''}?`}
        consequence={
          <>
            <p>
              This removes the room permanently and cannot be undone.
            </p>
            <div className={s.spaced}>
              <InfoNotice>
                <strong>A room that has ever been booked cannot be deleted.</strong>
                <p>
                  Deleting it would leave the booking history pointing at nothing. If that is the
                  case you will be told, and deactivating is what you want instead — the room
                  disappears from every booking screen but its history survives.
                </p>
              </InfoNotice>
            </div>
          </>
        }
        confirmLabel="Delete room"
        destructive
        loading={deleteRoom.isPending}
        onConfirm={async () => {
          if (!confirmDelete) return
          try {
            await deleteRoom.mutateAsync(confirmDelete.id)
            toast.show(`${confirmDelete.name} deleted`)
            setConfirmDelete(null)
          } catch (err) {
            toast.show(
              err instanceof ApiError ? err.message : 'Could not delete that room',
              'error',
            )
            setConfirmDelete(null)
          }
        }}
      />

      {rooms && rooms.some(r => !r.isActive) && (
        <p className={s.footnote}>
          <AlertTriangle size={13} aria-hidden /> Inactive rooms are shown here but hidden from
          everyone booking.
        </p>
      )}
    </>
  )
}
