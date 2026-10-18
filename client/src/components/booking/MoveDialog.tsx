/**
 * The admin move and cancel dialogs (S-14, S-15).
 *
 * Both make the consequence obvious before the admin commits, and both
 * require a written reason that is quoted verbatim to the organizer. The
 * confirm button stays disabled until that reason exists (BR-M5).
 */

import { ArrowRight } from 'lucide-react'
import { useState } from 'react'

import { timeInZone } from '@roombook/shared'

import { ApiError } from '../../api/client.js'
import {
  useCancelBooking,
  useCancelOccurrence,
  useMoveBooking,
  useRooms,
  type BookingDetail,
} from '../../api/hooks.js'
import { Button, ErrorNotice, Field, Input, Modal, Select, Textarea, useToast } from '../ui/index.js'
import { ScopeChooserDialog, type EditScopeChoice } from './RecurrenceEditor.js'
import s from './booking.module.css'

const MIN_REASON = 3

export function MoveDialog({
  booking,
  onClose,
  onMoved,
}: {
  booking: BookingDetail
  onClose: () => void
  onMoved: () => void
}) {
  const toast = useToast()
  const move = useMoveBooking()
  const tz = booking.room.location.timezone

  const { data: rooms } = useRooms({ locationId: booking.room.location.id })

  const [roomId, setRoomId] = useState(booking.room.id)
  const [startTime, setStartTime] = useState(timeInZone(new Date(booking.startsAt), tz))
  const [endTime, setEndTime] = useState(timeInZone(new Date(booking.endsAt), tz))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)

  const targetRoom = rooms?.find(r => r.id === roomId)
  const roomChanged = roomId !== booking.room.id
  const timeChanged =
    startTime !== timeInZone(new Date(booking.startsAt), tz) ||
    endTime !== timeInZone(new Date(booking.endsAt), tz)

  const canSubmit = reason.trim().length >= MIN_REASON && (roomChanged || timeChanged)

  async function submit() {
    setError(null)
    setConflict(null)
    try {
      await move.mutateAsync({
        id: booking.id,
        ...(roomChanged ? { roomId } : {}),
        ...(timeChanged
          ? {
              startsAt: shift(new Date(booking.startsAt), startTime, tz).toISOString(),
              endsAt: shift(new Date(booking.endsAt), endTime, tz).toISOString(),
            }
          : {}),
        reason: reason.trim(),
      })
      toast.show('Booking moved — the organizer has been emailed')
      onMoved()
    } catch (err) {
      // A slot taken between opening and submitting is reported INSIDE the
      // dialog, so the admin can pick again without losing their reason.
      if (err instanceof ApiError && err.status === 409) {
        const conflicts = (err.details as { conflicts?: Array<{ title?: string }> })?.conflicts
        setConflict(
          conflicts?.length
            ? `That slot was taken while this dialog was open: ${conflicts[0]?.title ?? 'another booking'}.`
            : err.message,
        )
        return
      }
      setError(err instanceof Error ? err.message : 'Could not move this booking')
    }
  }

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={`Move "${booking.title}"`}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={move.isPending} disabled={!canSubmit} onClick={() => void submit()}>
            Move booking
          </Button>
        </>
      }
    >
      {error && <ErrorNotice title="Could not move" error={new Error(error)} />}
      {conflict && <ErrorNotice title="That slot is no longer free" error={new Error(conflict)} />}

      <div className={s.compare}>
        <div className={s.compareCol}>
          <p className={s.compareHead}>Currently</p>
          <p className={s.compareValue}>{booking.room.name}</p>
          <p className={s.compareValue}>
            {timeInZone(new Date(booking.startsAt), tz)} – {timeInZone(new Date(booking.endsAt), tz)}
          </p>
        </div>
        <ArrowRight size={16} aria-hidden className={s.compareArrow} />
        <div className={s.compareCol}>
          <p className={s.compareHead}>Move to</p>
          <Select value={roomId} onChange={e => setRoomId(e.target.value)} aria-label="New room">
            {(rooms ?? []).map(r => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.capacity} seats)
              </option>
            ))}
          </Select>
          <div className={s.timeRow}>
            <Input
              type="time"
              value={startTime}
              onChange={e => setStartTime(e.target.value)}
              aria-label="New start time"
            />
            <span className={s.to}>to</span>
            <Input
              type="time"
              value={endTime}
              onChange={e => setEndTime(e.target.value)}
              aria-label="New end time"
            />
          </div>
        </div>
      </div>

      <Field
        label="Reason for the move"
        required
        hint="Quoted word for word in the email to the organizer."
        error={
          reason.length > 0 && reason.trim().length < MIN_REASON
            ? 'Please write at least a few words'
            : undefined
        }
      >
        <Textarea
          rows={2}
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Boardroom required for the quarterly review"
        />
      </Field>

      <p className={s.notifyNote}>
        {booking.organizer.fullName} will be emailed with the old and new details and your reason.
        Notification cannot be turned off for an admin move.
      </p>

      {targetRoom && targetRoom.requiresApproval && roomChanged && (
        <p className={s.notifyNote}>
          Note: {targetRoom.name} normally needs approval. An admin move is applied directly.
        </p>
      )}
    </Modal>
  )
}

export function CancelDialog({
  booking,
  isOwn,
  isAdmin = false,
  onClose,
  onCancelled,
}: {
  booking: BookingDetail
  isOwn: boolean
  isAdmin?: boolean
  onClose: () => void
  onCancelled: () => void
}) {
  const toast = useToast()
  const cancel = useCancelBooking()
  const cancelOccurrence = useCancelOccurrence()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  /**
   * An occurrence of a series needs a scope before anything happens: guessing
   * between "just this Tuesday" and "the whole standup forever" is not a guess
   * worth making. The default differs by role, because an admin reclaiming a
   * room almost always means today (D16).
   */
  const [scope, setScope] = useState<EditScopeChoice | null>(null)

  if (booking.seriesId && scope === null) {
    return (
      <ScopeChooserDialog
        title={booking.title}
        action="Cancel"
        defaultScope={isAdmin && !isOwn ? 'THIS_OCCURRENCE' : 'ENTIRE_SERIES'}
        loading={false}
        onClose={onClose}
        onChoose={setScope}
      />
    )
  }

  // An organizer cancelling their own booking owes nobody an explanation; an
  // admin cancelling someone else's does (BR-M5).
  const reasonRequired = !isOwn
  const canSubmit = !reasonRequired || reason.trim().length >= MIN_REASON

  const recipients = 1 + booking.attendees.length

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title={`Cancel "${booking.title}"?`}
      footer={
        <>
          <Button onClick={onClose}>Keep booking</Button>
          <Button
            variant="danger"
            loading={cancel.isPending || cancelOccurrence.isPending}
            disabled={!canSubmit}
            onClick={async () => {
              setError(null)
              try {
                if (booking.seriesId && scope) {
                  const result = await cancelOccurrence.mutateAsync({
                    bookingId: booking.id,
                    scope,
                    reason: reason.trim() || undefined,
                  })
                  // The count matters: "1 cancelled" and "34 cancelled" are
                  // very different outcomes to confirm back.
                  const affected = result.data.affected
                  toast.show(
                    scope === 'THIS_OCCURRENCE'
                      ? 'That date cancelled — the rest of the series is unchanged'
                      : `${affected} meeting${affected === 1 ? '' : 's'} cancelled`,
                  )
                } else {
                  await cancel.mutateAsync({
                    id: booking.id,
                    reason: reason.trim() || undefined,
                  })
                  toast.show('Booking cancelled — the room is free again')
                }
                onCancelled()
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not cancel')
              }
            }}
          >
            Cancel booking
          </Button>
        </>
      }
    >
      {error && <ErrorNotice title="Could not cancel" error={new Error(error)} />}

      {/* The consequence, stated plainly, rather than "are you sure?" */}
      <p>
        <strong>{booking.room.name}</strong> will be free immediately, and{' '}
        {isOwn
          ? recipients > 1
            ? `${recipients} people will be emailed`
            : 'you will receive a confirmation'
          : `${booking.organizer.fullName} will be emailed your reason`}
        .
      </p>

      {reasonRequired && (
        <Field
          label="Reason"
          required
          hint="Shown to the organizer word for word."
          error={
            reason.length > 0 && reason.trim().length < MIN_REASON
              ? 'Please write at least a few words'
              : undefined
          }
        >
          <Textarea
            rows={2}
            autoFocus
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Emergency maintenance on the projector"
          />
        </Field>
      )}
    </Modal>
  )
}

/** Replaces the wall-clock time in the room's zone, keeping the date. */
function shift(current: Date, hhmm: string, timeZone: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return current
  const [curH, curM] = timeInZone(current, timeZone).split(':').map(Number)
  return new Date(current.getTime() + (h! * 60 + m! - (curH! * 60 + curM!)) * 60_000)
}
