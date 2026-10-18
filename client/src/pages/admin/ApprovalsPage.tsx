/**
 * Admin: the approval queue (S-29).
 *
 * Sorted by what is about to lapse, not by what arrived first — the question
 * an admin opens this screen to answer is "what needs me now?".
 *
 * Specification: docs/15-approvals.md section 8.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Clock, UserCheck, X } from 'lucide-react'
import { useState } from 'react'

import { timeInZone } from '@roombook/shared'

import { ApiError, api } from '../../api/client.js'
import { useRooms } from '../../api/hooks.js'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from '../../components/ui/index.js'
import s from './admin.module.css'

interface PendingRequest {
  id: string
  title: string
  description: string | null
  approvalNote: string | null
  startsAt: string
  endsAt: string
  approvalExpiresAt: string | null
  createdAt: string
  isNamedApprover: boolean
  room: {
    id: string
    name: string
    capacity: number
    floor: string | null
    colour: string
    locationId: string
    location: { id: string; name: string; timezone: string }
  }
  organizer: { id: string; fullName: string; email: string }
}

const MIN_REASON = 3

export function ApprovalsPage() {
  const toast = useToast()
  const qc = useQueryClient()

  const queue = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api.get<{ data: PendingRequest[] }>('/approvals').then(r => r.data),
    // Requests lapse on their own, so the list keeps itself current.
    refetchInterval: 30_000,
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['approvals'] })
    void qc.invalidateQueries({ queryKey: ['availability'] })
    void qc.invalidateQueries({ queryKey: ['bookings'] })
  }

  const approve = useMutation({
    mutationFn: ({ id, moveToRoomId }: { id: string; moveToRoomId?: string }) =>
      api.post(`/approvals/${id}/approve`, moveToRoomId ? { moveToRoomId } : {}),
    onSuccess: invalidate,
  })

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/approvals/${id}/reject`, { reason }),
    onSuccess: invalidate,
  })

  const [rejecting, setRejecting] = useState<PendingRequest | null>(null)
  const [moving, setMoving] = useState<PendingRequest | null>(null)

  if (queue.error) {
    return (
      <ErrorNotice
        title="Could not load the approval queue"
        error={queue.error}
        onRetry={() => void queue.refetch()}
      />
    )
  }

  const requests = queue.data ?? []
  const urgent = requests.filter(r => hoursLeft(r) !== null && hoursLeft(r)! <= 2).length

  return (
    <>
      <PageHeader
        title="Pending approvals"
        description="Each request holds its room while it waits, and lapses if nobody responds."
      />

      {/* Lead with what is about to lapse rather than making an admin work it
          out from timestamps. */}
      {urgent > 0 && (
        <div className={s.spacedBottom}>
          <ErrorNotice
            title={`${urgent} request${urgent === 1 ? '' : 's'} lapse within two hours`}
            error={new Error('Once a request lapses the room is released and the requester is told nobody responded.')}
          />
        </div>
      )}

      {queue.isPending && <Skeleton rows={3} />}

      {!queue.isPending && requests.length === 0 && (
        <Card>
          <EmptyState
            title="Nothing waiting"
            description="Requests appear here when someone books a room that needs approval. Only one or two rooms should need it — every approval turns an instant action into a wait."
          />
        </Card>
      )}

      <div className={s.list}>
        {requests.map(req => {
          const tz = req.room.location.timezone
          const left = hoursLeft(req)

          return (
            <Card key={req.id} className={s.approvalCard}>
              <div className={s.approvalHead}>
                {left !== null && (
                  <span className={left <= 2 ? s.expiryUrgent : s.expiry}>
                    <Clock size={12} aria-hidden />
                    {/* The word, not just the colour, carries the urgency. */}
                    {left <= 0 ? 'lapsing now' : `lapses in ${formatLeft(left)}`}
                  </span>
                )}
                {req.isNamedApprover && (
                  <Badge tone="pending">
                    <UserCheck size={11} aria-hidden /> yours to decide
                  </Badge>
                )}
              </div>

              <h2 className={s.approvalTitle}>{req.title}</h2>

              <p className={s.approvalMeta}>
                <span className={s.swatch} style={{ background: req.room.colour }} aria-hidden />
                <strong>{req.room.name}</strong>
                {req.room.floor ? `, ${req.room.floor}` : ''} · {req.room.location.name}
              </p>

              <p className={s.approvalMeta}>
                {new Intl.DateTimeFormat('en-GB', {
                  timeZone: tz,
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                }).format(new Date(req.startsAt))}
                , {timeInZone(new Date(req.startsAt), tz)}–{timeInZone(new Date(req.endsAt), tz)}
              </p>

              <p className={s.approvalMeta}>
                Asked for by <strong>{req.organizer.fullName}</strong>
              </p>

              {req.approvalNote && <blockquote className={s.approvalNote}>{req.approvalNote}</blockquote>}

              <div className={s.approvalActions}>
                <Button
                  variant="primary"
                  size="sm"
                  loading={approve.isPending}
                  onClick={async () => {
                    try {
                      await approve.mutateAsync({ id: req.id })
                      toast.show(`Approved — ${req.organizer.fullName} has been emailed`)
                    } catch (err) {
                      toast.show(
                        err instanceof ApiError ? err.message : 'Could not approve',
                        'error',
                      )
                    }
                  }}
                >
                  <Check size={14} aria-hidden /> Approve
                </Button>

                <Button size="sm" onClick={() => setMoving(req)}>
                  Approve in another room
                </Button>

                <Button size="sm" variant="ghost" onClick={() => setRejecting(req)}>
                  <X size={14} aria-hidden /> Reject…
                </Button>
              </div>
            </Card>
          )
        })}
      </div>

      {rejecting && (
        <RejectDialog
          request={rejecting}
          loading={reject.isPending}
          onClose={() => setRejecting(null)}
          onReject={async reason => {
            try {
              await reject.mutateAsync({ id: rejecting.id, reason })
              toast.show(`Rejected — ${rejecting.organizer.fullName} has been told why`)
              setRejecting(null)
            } catch (err) {
              toast.show(err instanceof ApiError ? err.message : 'Could not reject', 'error')
            }
          }}
        />
      )}

      {moving && (
        <ApproveElsewhereDialog
          request={moving}
          loading={approve.isPending}
          onClose={() => setMoving(null)}
          onApprove={async roomId => {
            try {
              await approve.mutateAsync({ id: moving.id, moveToRoomId: roomId })
              toast.show('Approved in the other room — the requester has been told which')
              setMoving(null)
            } catch (err) {
              toast.show(err instanceof ApiError ? err.message : 'Could not approve', 'error')
            }
          }}
        />
      )}
    </>
  )
}

function RejectDialog({
  request,
  loading,
  onClose,
  onReject,
}: {
  request: PendingRequest
  loading: boolean
  onClose: () => void
  onReject: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const valid = reason.trim().length >= MIN_REASON

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={`Reject "${request.title}"?`}
      footer={
        <>
          <Button onClick={onClose}>Keep waiting</Button>
          <Button
            variant="danger"
            loading={loading}
            disabled={!valid}
            onClick={() => onReject(reason.trim())}
          >
            Reject request
          </Button>
        </>
      }
    >
      <p>
        <strong>{request.room.name}</strong> will be released immediately, and{' '}
        <strong>{request.organizer.fullName}</strong> will be emailed your reason word for word.
      </p>

      <Field
        label="Reason"
        required
        hint="Shown to the requester exactly as written."
        error={
          reason.length > 0 && !valid ? 'Please write at least a few words' : undefined
        }
      >
        <Textarea
          rows={3}
          autoFocus
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="The board needs this room that morning"
        />
      </Field>
    </Modal>
  )
}

function ApproveElsewhereDialog({
  request,
  loading,
  onClose,
  onApprove,
}: {
  request: PendingRequest
  loading: boolean
  onClose: () => void
  onApprove: (roomId: string) => void
}) {
  const { data: rooms } = useRooms({ locationId: request.room.locationId })
  const [roomId, setRoomId] = useState('')

  const alternatives = (rooms ?? []).filter(r => r.id !== request.room.id)

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title="Approve in another room"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={loading} disabled={!roomId} onClick={() => onApprove(roomId)}>
            Approve in this room
          </Button>
        </>
      }
    >
      <p>
        {request.organizer.fullName} asked for <strong>{request.room.name}</strong>. Approving
        elsewhere lets the meeting go ahead while keeping that room free — the requester is told
        which room they got.
      </p>

      <Field label="Room" required>
        <Select value={roomId} onChange={e => setRoomId(e.target.value)} autoFocus>
          <option value="">Choose a room…</option>
          {alternatives.map(r => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.capacity} seats)
            </option>
          ))}
        </Select>
      </Field>

      <p className={s.muted}>
        <AlertTriangle size={12} aria-hidden /> If the room you choose is already booked at that
        time, you will be told rather than double-booking it.
      </p>
    </Modal>
  )
}

function hoursLeft(req: PendingRequest): number | null {
  if (!req.approvalExpiresAt) return null
  return (new Date(req.approvalExpiresAt).getTime() - Date.now()) / 3_600_000
}

function formatLeft(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  if (hours < 24) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)} days`
}
