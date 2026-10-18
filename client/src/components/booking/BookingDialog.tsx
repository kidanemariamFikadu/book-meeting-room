/**
 * Creating a booking (S-07), and recovering from a clash (BR-C4).
 *
 * The conflict panel is the point of this component. A 409 is never a dead
 * end: the server returns the nearest free times in the same room and other
 * rooms free at that moment, and each is one click away. The user never
 * retypes anything.
 */

import { AlertTriangle, Check } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { formatInZone, timeInZone } from '@roombook/shared'

import { ApiError } from '../../api/client.js'
import {
  useCreateBooking,
  useCreateSeries,
  usePreviewSeries,
  useUsers,
  type FreeRoom,
} from '../../api/hooks.js'
import {
  Badge,
  Button,
  Checkbox,
  ErrorNotice,
  Field,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '../ui/index.js'
import {
  RecurrenceEditor,
  SeriesPreviewDialog,
  defaultRule,
  type RecurrenceValue,
  type SeriesPreviewData,
} from './RecurrenceEditor.js'
import s from './booking.module.css'

export interface DraftBooking {
  roomId: string
  roomName: string
  start: Date
  end: Date
  timezone: string
  requiresApproval?: boolean
}

interface Conflict {
  id: string
  startsAt: string
  endsAt: string
  title?: string
  organizer?: string
}

interface Suggestions {
  sameRoom: Array<{ startsAt: string; endsAt: string }>
  otherRooms: FreeRoom[]
}

export function BookingDialog({
  draft,
  onClose,
  onBooked,
  onSeriesCreated,
  rooms,
}: {
  draft: DraftBooking
  onClose: () => void
  onBooked: (id: string) => void
  onSeriesCreated?: (seriesId: string) => void
  rooms: Array<{ roomId: string; name: string }>
}) {
  const toast = useToast()
  const create = useCreateBooking()
  const { data: directory } = useUsers()

  const [roomId, setRoomId] = useState(draft.roomId)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [attendees, setAttendees] = useState<string[]>([])
  const [showMore, setShowMore] = useState(false)
  const [start, setStart] = useState(draft.start)
  const [end, setEnd] = useState(draft.end)

  const [recurrence, setRecurrence] = useState<RecurrenceValue>(() => ({
    enabled: false,
    rule: defaultRule(formatInZone(draft.start, draft.timezone).slice(0, 10)),
  }))
  const [seriesPreview, setSeriesPreview] = useState<SeriesPreviewData | null>(null)

  const previewSeries = usePreviewSeries()
  const createSeries = useCreateSeries()

  const [conflicts, setConflicts] = useState<Conflict[] | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)

  // A fresh draft (a new drag on the grid) clears any previous clash.
  useEffect(() => {
    setRoomId(draft.roomId)
    setStart(draft.start)
    setEnd(draft.end)
    setConflicts(null)
    setSuggestions(null)
    setError(null)
  }, [draft])

  const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60_000)
  const roomName = rooms.find(r => r.roomId === roomId)?.name ?? draft.roomName

  const timeLabel = useMemo(
    () =>
      `${timeInZone(start, draft.timezone)} – ${timeInZone(end, draft.timezone)}`,
    [start, end, draft.timezone],
  )

  const startLocal = formatInZone(start, draft.timezone)

  /** Everything the series endpoints need, derived once. */
  const seriesBody = () => ({
    roomId,
    startsAtLocal: startLocal,
    durationMinutes,
    timezone: draft.timezone,
    recurrence: recurrence.rule,
  })

  async function submit() {
    setError(null)
    setFieldError(null)

    if (title.trim().length === 0) {
      setFieldError('Please give the meeting a title')
      return
    }

    /*
     * A recurring booking is previewed before anything is written, because
     * some dates in a long series will clash and the user must see which.
     * Creating first and reporting afterwards is how a series quietly misses
     * three weeks (docs/12 section 4).
     */
    if (recurrence.enabled) {
      try {
        setSeriesPreview(await previewSeries.mutateAsync(seriesBody()))
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not check those dates')
      }
      return
    }

    try {
      const result = await create.mutateAsync({
        roomId,
        title: title.trim(),
        description: description.trim() || undefined,
        isPrivate,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        attendees: attendees.map(userId => ({ userId })),
      })
      toast.show(
        result.data.status === 'PENDING_APPROVAL'
          ? 'Request sent — you will hear back once it is approved'
          : `${roomName} booked`,
      )
      onBooked(result.data.id)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflicts((err.details as { conflicts?: Conflict[] })?.conflicts ?? [])
        setSuggestions((err.details as { suggestions?: Suggestions })?.suggestions ?? null)
        return
      }
      if (err instanceof ApiError && err.status === 422) {
        // A rule only the server knows about - the room bookable hours, say -
        // lands next to the time rather than in a toast.
        setFieldError(err.message)
        return
      }
      setError(err instanceof Error ? err.message : 'Could not create that booking')
    }
  }

  /** Re-books at a suggested time without the user retyping anything. */
  function takeSuggestion(next: { startsAt: string; endsAt: string }, nextRoomId?: string) {
    setStart(new Date(next.startsAt))
    setEnd(new Date(next.endsAt))
    if (nextRoomId) setRoomId(nextRoomId)
    setConflicts(null)
    setSuggestions(null)
  }

  return (
    <Modal
      open
      onOpenChange={open => !open && onClose()}
      title="New booking"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.isPending || previewSeries.isPending}
            onClick={() => void submit()}
          >
            {recurrence.enabled
              ? 'Check the dates'
              : draft.requiresApproval
                ? 'Request room'
                : 'Book room'}
          </Button>
        </>
      }
    >
      {error && <ErrorNotice title="Could not book" error={new Error(error)} />}

      {conflicts && (
        <div className={s.conflict} role="alert">
          <p className={s.conflictHead}>
            <AlertTriangle size={15} aria-hidden /> {roomName} is already booked
          </p>
          {conflicts.map(c => (
            <p key={c.id} className={s.conflictItem}>
              {timeInZone(new Date(c.startsAt), draft.timezone)}–
              {timeInZone(new Date(c.endsAt), draft.timezone)} · {c.title ?? 'Busy'}
              {c.organizer ? ` — ${c.organizer}` : ''}
            </p>
          ))}

          {(suggestions?.sameRoom.length || suggestions?.otherRooms.length) && (
            <div className={s.suggestions}>
              <p className={s.suggestHead}>Try instead:</p>

              {suggestions.sameRoom.length > 0 && (
                <div className={s.suggestRow}>
                  <span className={s.suggestLabel}>Same room</span>
                  {suggestions.sameRoom.map(alt => (
                    <Button key={alt.startsAt} size="sm" onClick={() => takeSuggestion(alt)}>
                      {timeInZone(new Date(alt.startsAt), draft.timezone)}–
                      {timeInZone(new Date(alt.endsAt), draft.timezone)}
                    </Button>
                  ))}
                </div>
              )}

              {suggestions.otherRooms.length > 0 && (
                <div className={s.suggestRow}>
                  <span className={s.suggestLabel}>Other rooms at {timeLabel}</span>
                  {suggestions.otherRooms.map(r => (
                    <Button
                      key={r.roomId}
                      size="sm"
                      onClick={() =>
                        takeSuggestion(
                          { startsAt: start.toISOString(), endsAt: end.toISOString() },
                          r.roomId,
                        )
                      }
                    >
                      {r.name} ({r.capacity})
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Field label="Title" required error={fieldError ?? undefined}>
        <Input
          autoFocus
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Design review"
        />
      </Field>

      <div className={s.twoCol}>
        <Field label="Room" required>
          <Select value={roomId} onChange={e => setRoomId(e.target.value)}>
            {rooms.map(r => (
              <option key={r.roomId} value={r.roomId}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="When"
          hint={`${formatInZone(start, draft.timezone).slice(0, 10)} · ${durationMinutes} minutes`}
        >
          <div className={s.timeRow}>
            <Input
              type="time"
              value={timeInZone(start, draft.timezone)}
              onChange={e => setStart(withTime(start, e.target.value, draft.timezone))}
            />
            <span className={s.to}>to</span>
            <Input
              type="time"
              value={timeInZone(end, draft.timezone)}
              onChange={e => setEnd(withTime(end, e.target.value, draft.timezone))}
            />
          </div>
        </Field>
      </div>

      {!conflicts && (
        <p className={s.availability}>
          <Check size={14} aria-hidden /> {roomName} looks free at {timeLabel}
        </p>
      )}

      {draft.requiresApproval && (
        <div className={s.approvalNote}>
          This room needs approval. Your request holds the slot while it waits, and you will hear
          back within 24 hours.
        </div>
      )}

      <RecurrenceEditor
        value={recurrence}
        startLocalDate={startLocal.slice(0, 10)}
        startLocalTime={startLocal.slice(11, 16)}
        onChange={setRecurrence}
      />

      <button type="button" className={s.disclosure} onClick={() => setShowMore(v => !v)}>
        {showMore ? 'Hide' : 'Add'} attendees, description and options
      </button>

      {showMore && (
        <div className={s.more}>
          <Field label="Description">
            <Textarea
              rows={2}
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </Field>

          <Field
            label="Attendees"
            hint="Hold Ctrl or Cmd to pick several. In this version only you receive the email."
          >
            <select
              multiple
              size={5}
              className={s.multi}
              value={attendees}
              onChange={e =>
                setAttendees(Array.from(e.target.selectedOptions, o => o.value))
              }
            >
              {(directory ?? []).map(u => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          </Field>

          <Checkbox
            label="Private booking"
            description="Others see only Busy instead of the title. Admins can still see it, because they need to in order to move it."
            checked={isPrivate}
            onChange={e => setIsPrivate(e.target.checked)}
          />
        </div>
      )}

      {seriesPreview && (
        <SeriesPreviewDialog
          preview={seriesPreview}
          roomName={roomName}
          loading={createSeries.isPending}
          onClose={() => setSeriesPreview(null)}
          onConfirm={async strategy => {
            if (strategy === 'FAIL') {
              // "Change the dates" takes them back to the form rather than
              // attempting a create that is certain to be refused.
              setSeriesPreview(null)
              return
            }
            try {
              const result = await createSeries.mutateAsync({
                ...seriesBody(),
                title: title.trim(),
                description: description.trim() || undefined,
                isPrivate,
                conflictStrategy: 'SKIP',
              })
              toast.show(
                result.skipped.length > 0
                  ? `${result.created} meetings booked, ${result.skipped.length} dates skipped`
                  : `${result.created} meetings booked`,
              )
              setSeriesPreview(null)
              onSeriesCreated?.(result.seriesId)
              onClose()
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not create the series')
              setSeriesPreview(null)
            }
          }}
        />
      )}
    </Modal>
  )
}

/**
 * Replaces the wall-clock time while keeping the date, in the room's zone.
 *
 * Done by shifting from the existing instant rather than reconstructing a date,
 * so it stays correct when the browser zone differs from the room's.
 */
function withTime(current: Date, hhmm: string, timeZone: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return current
  const [curH, curM] = timeInZone(current, timeZone).split(':').map(Number)
  const deltaMinutes = h! * 60 + m! - (curH! * 60 + curM!)
  return new Date(current.getTime() + deltaMinutes * 60_000)
}

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'CONFIRMED':
      return <Badge tone="success">Confirmed</Badge>
    case 'PENDING_APPROVAL':
      return <Badge tone="pending">Awaiting approval</Badge>
    case 'CANCELLED':
      return <Badge tone="neutral">Cancelled</Badge>
    case 'REJECTED':
      return <Badge tone="danger">Rejected</Badge>
    case 'ENDED_EARLY':
      return <Badge tone="warning">Ended early</Badge>
    default:
      return <Badge tone="neutral">{status}</Badge>
  }
}
