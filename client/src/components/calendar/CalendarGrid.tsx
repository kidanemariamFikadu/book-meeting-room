/**
 * The room-by-time calendar grid.
 *
 * Everything else in this app is forms and tables; this is the one component
 * that earns real design effort.
 *
 * Structure: one DOM node per BOOKING, absolutely positioned over a CSS grid
 * of slots — not one node per slot per room, which at 50 rooms x 40 slots
 * would be 2,000 nodes and visibly slow.
 *
 * Keyboard contract (docs/07-ui-screens.md section 7):
 *   Tab            moves between ROOMS, not cells - 2,000 tab stops is not navigation
 *   Left/Right     move the cursor one slot within a room
 *   Up/Down        move between rooms at the same time
 *   Enter          book at the cursor, or open the booking under it
 *   Shift+Arrow    extend the selection
 *   Escape         clear the selection
 *   Home/End       first / last bookable slot of the day
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { timeInZone } from '@roombook/shared'

import type { DayAvailability, RoomAvailability } from '../../api/hooks.js'
import s from './CalendarGrid.module.css'

export interface SlotSelection {
  roomId: string
  start: Date
  end: Date
}

interface Props {
  data: DayAvailability
  slotMinutes?: number
  onSelect: (selection: SlotSelection) => void
  onOpenBooking: (bookingId: string) => void
}

/** Minutes from local midnight, in the grid's timezone. */
function minutesOf(iso: string, timeZone: string): number {
  const [h, m] = timeInZone(new Date(iso), timeZone).split(':').map(Number)
  return h! * 60 + m!
}

export function CalendarGrid({ data, slotMinutes = 15, onSelect, onOpenBooking }: Props) {
  const { timezone } = data

  /**
   * The grid spans the union of every room's bookable hours, so a room open
   * later than the rest is still fully visible, rather than the day being
   * clipped to one room's window.
   */
  const { dayStart, dayEnd } = useMemo(() => {
    let min = 24 * 60
    let max = 0
    for (const room of data.rooms) {
      for (const w of room.bookableWindows) {
        min = Math.min(min, minutesOf(w.startsAt, timezone))
        const end = minutesOf(w.endsAt, timezone)
        max = Math.max(max, end === 0 ? 24 * 60 : end)
      }
    }
    if (min >= max) return { dayStart: 8 * 60, dayEnd: 18 * 60 }
    // A little padding either side, so an 08:00 booking is not flush to the edge.
    return { dayStart: Math.max(0, min - 60), dayEnd: Math.min(24 * 60, max + 60) }
  }, [data.rooms, timezone])

  const totalSlots = Math.max(1, Math.round((dayEnd - dayStart) / slotMinutes))
  const hourMarks = useMemo(() => {
    const marks: number[] = []
    for (let m = Math.ceil(dayStart / 60) * 60; m < dayEnd; m += 60) marks.push(m)
    return marks
  }, [dayStart, dayEnd])

  // The cursor is a (room, slot) pair for keyboard use; the anchor marks where
  // a drag or Shift-extension began.
  const [cursor, setCursor] = useState<{ roomIndex: number; slot: number } | null>(null)
  const [anchor, setAnchor] = useState<{ roomIndex: number; slot: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef<HTMLDivElement>(null)

  const slotToDate = useCallback(
    (slot: number): Date => {
      // Built from the day's own bookable window so the result is a real
      // instant in the grid timezone, including across a DST change.
      const base = data.rooms[0]?.bookableWindows[0]?.startsAt
      const reference = base ? new Date(base) : new Date(`${data.date}T00:00:00Z`)
      const referenceMinutes = base ? minutesOf(base, timezone) : 0
      const delta = dayStart + slot * slotMinutes - referenceMinutes
      return new Date(reference.getTime() + delta * 60_000)
    },
    [data.rooms, data.date, dayStart, slotMinutes, timezone],
  )

  const labelFor = (slot: number) => {
    const total = dayStart + slot * slotMinutes
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }

  const announce = (message: string) => {
    if (liveRef.current) liveRef.current.textContent = message
  }

  const commitSelection = useCallback(
    (roomIndex: number, from: number, to: number) => {
      const room = data.rooms[roomIndex]
      if (!room) return
      const [a, b] = from <= to ? [from, to] : [to, from]
      onSelect({ roomId: room.roomId, start: slotToDate(a), end: slotToDate(b + 1) })
    },
    [data.rooms, onSelect, slotToDate],
  )

  // A pointer release anywhere ends the drag, including outside the grid —
  // otherwise releasing off-grid leaves it stuck in a dragging state.
  useEffect(() => {
    if (!dragging) return
    const stop = () => {
      setDragging(false)
      if (anchor && cursor && anchor.roomIndex === cursor.roomIndex) {
        commitSelection(anchor.roomIndex, anchor.slot, cursor.slot)
      }
    }
    window.addEventListener('pointerup', stop)
    return () => window.removeEventListener('pointerup', stop)
  }, [dragging, anchor, cursor, commitSelection])

  const selection =
    anchor && cursor && anchor.roomIndex === cursor.roomIndex
      ? {
          roomIndex: anchor.roomIndex,
          from: Math.min(anchor.slot, cursor.slot),
          to: Math.max(anchor.slot, cursor.slot),
        }
      : null

  function onRoomKeyDown(e: React.KeyboardEvent, roomIndex: number) {
    const current = cursor?.roomIndex === roomIndex ? cursor.slot : 0
    const move = (next: number, nextRoom = roomIndex) => {
      e.preventDefault()
      const slot = Math.max(0, Math.min(totalSlots - 1, next))
      setCursor({ roomIndex: nextRoom, slot })
      if (!e.shiftKey) setAnchor({ roomIndex: nextRoom, slot })
      else if (!anchor) setAnchor({ roomIndex: nextRoom, slot: current })
      const room = data.rooms[nextRoom]
      announce(
        e.shiftKey && anchor
          ? `Selected ${room?.name}, ${labelFor(Math.min(anchor.slot, slot))} to ${labelFor(Math.max(anchor.slot, slot) + 1)}`
          : `${room?.name}, ${labelFor(slot)}`,
      )
    }

    switch (e.key) {
      case 'ArrowRight':
        return move(current + 1)
      case 'ArrowLeft':
        return move(current - 1)
      case 'ArrowDown':
        return move(current, Math.min(data.rooms.length - 1, roomIndex + 1))
      case 'ArrowUp':
        return move(current, Math.max(0, roomIndex - 1))
      case 'Home':
        return move(0)
      case 'End':
        return move(totalSlots - 1)
      case 'Escape':
        e.preventDefault()
        setAnchor(null)
        setCursor(null)
        announce('Selection cleared')
        return
      case 'Enter':
      case ' ': {
        e.preventDefault()
        const room = data.rooms[roomIndex]
        if (!room) return
        const at = slotToDate(current).getTime()
        // Enter on an existing booking opens it; on free space it books.
        const existing = room.busy.find(
          b => new Date(b.startsAt).getTime() <= at && new Date(b.endsAt).getTime() > at,
        )
        if (existing) return onOpenBooking(existing.bookingId)
        commitSelection(roomIndex, anchor?.roomIndex === roomIndex ? anchor.slot : current, current)
        return
      }
      default:
    }
  }

  const slotFromPointer = (e: React.PointerEvent, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect()
    const ratio = (e.clientX - rect.left) / rect.width
    return Math.max(0, Math.min(totalSlots - 1, Math.floor(ratio * totalSlots)))
  }

  const nowMinutes = useNowMinutes(timezone)
  const nowVisible = nowMinutes >= dayStart && nowMinutes <= dayEnd
  const nowPercent = ((nowMinutes - dayStart) / (dayEnd - dayStart)) * 100

  if (data.rooms.length === 0) return null

  return (
    <div className={s.wrapper}>
      <div ref={liveRef} className="visually-hidden" role="status" aria-live="polite" />

      <div className={s.scroller}>
        <div
          ref={gridRef}
          className={s.grid}
          style={{ '--slots': totalSlots } as React.CSSProperties}
        >
          {/* Time axis */}
          <div className={s.axisCorner}>
            <span className={s.zoneLabel}>{shortZone(timezone)}</span>
          </div>
          <div className={s.axis}>
            {hourMarks.map(m => (
              <span
                key={m}
                className={s.axisMark}
                style={{ left: `${((m - dayStart) / (dayEnd - dayStart)) * 100}%` }}
              >
                {String(Math.floor(m / 60)).padStart(2, '0')}:00
              </span>
            ))}
          </div>

          {data.rooms.map((room, roomIndex) => (
            <RoomRow
              key={room.roomId}
              room={room}
              roomIndex={roomIndex}
              dayStart={dayStart}
              dayEnd={dayEnd}
              timezone={timezone}
              totalSlots={totalSlots}
              selection={selection?.roomIndex === roomIndex ? selection : null}
              cursor={cursor?.roomIndex === roomIndex ? cursor.slot : null}
              labelFor={labelFor}
              onKeyDown={e => onRoomKeyDown(e, roomIndex)}
              onPointerDown={(e, el) => {
                if (e.button !== 0) return
                const slot = slotFromPointer(e, el)
                setAnchor({ roomIndex, slot })
                setCursor({ roomIndex, slot })
                setDragging(true)
              }}
              onPointerMove={(e, el) => {
                if (!dragging) return
                setCursor({ roomIndex, slot: slotFromPointer(e, el) })
              }}
              onOpenBooking={onOpenBooking}
            />
          ))}

          {nowVisible && (
            <div className={s.nowLine} style={{ left: `calc(var(--room-col) + ${nowPercent}% * var(--track-ratio))` }}>
              <span className={s.nowDot} aria-hidden />
            </div>
          )}
        </div>
      </div>

      <p className={s.legend}>
        <span className={s.legendItem}>
          <span className={`${s.legendSwatch} ${s.legendBooked}`} aria-hidden /> Booked
        </span>
        <span className={s.legendItem}>
          <span className={`${s.legendSwatch} ${s.legendMine}`} aria-hidden /> Yours
        </span>
        <span className={s.legendItem}>
          <span className={`${s.legendSwatch} ${s.legendPending}`} aria-hidden /> Awaiting approval
        </span>
        <span className={s.legendItem}>
          <span className={`${s.legendSwatch} ${s.legendClosed}`} aria-hidden /> Closed
        </span>
        <span className={s.legendItem}>Click or drag an empty area to book.</span>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface RoomRowProps {
  room: RoomAvailability
  roomIndex: number
  dayStart: number
  dayEnd: number
  timezone: string
  totalSlots: number
  selection: { from: number; to: number } | null
  cursor: number | null
  labelFor: (slot: number) => string
  onKeyDown: (e: React.KeyboardEvent) => void
  onPointerDown: (e: React.PointerEvent, el: HTMLElement) => void
  onPointerMove: (e: React.PointerEvent, el: HTMLElement) => void
  onOpenBooking: (id: string) => void
}

function RoomRow({
  room,
  dayStart,
  dayEnd,
  timezone,
  totalSlots,
  selection,
  cursor,
  labelFor,
  onKeyDown,
  onPointerDown,
  onPointerMove,
  onOpenBooking,
}: RoomRowProps) {
  const span = dayEnd - dayStart
  const pct = (iso: string) => ((minutesOf(iso, timezone) || 0) - dayStart) / span
  const width = (a: string, b: string) => {
    const start = minutesOf(a, timezone)
    const endRaw = minutesOf(b, timezone)
    const end = endRaw === 0 ? 24 * 60 : endRaw
    return (end - start) / span
  }

  return (
    <>
      <div className={s.roomCell}>
        <span className={s.roomSwatch} style={{ background: room.colour }} aria-hidden />
        <span className={s.roomName}>{room.name}</span>
        <span className={s.roomMeta}>{room.capacity}</span>
      </div>

      {/*
        One focusable element per ROOM. The grid cells are not individually
        focusable, so Tab moves room to room and the arrow keys move within.
      */}
      <div
        className={s.track}
        role="grid"
        tabIndex={0}
        aria-label={`${room.name}, ${room.capacity} seats. Use arrow keys to choose a time, Enter to book.`}
        onKeyDown={onKeyDown}
        onPointerDown={e => onPointerDown(e, e.currentTarget)}
        onPointerMove={e => onPointerMove(e, e.currentTarget)}
      >
        {/* Unbookable time is shaded, so closed periods read as unavailable
            rather than merely empty. */}
        {room.bookableWindows.map((w, i) => (
          <div
            key={i}
            className={s.bookable}
            style={{ left: `${pct(w.startsAt) * 100}%`, width: `${width(w.startsAt, w.endsAt) * 100}%` }}
          />
        ))}

        {Array.from({ length: totalSlots }, (_, i) => (
          <div key={i} className={s.slotLine} style={{ left: `${(i / totalSlots) * 100}%` }} />
        ))}

        {room.closures.map(c => (
          <div
            key={c.id}
            className={s.closure}
            style={{ left: `${pct(c.startsAt) * 100}%`, width: `${width(c.startsAt, c.endsAt) * 100}%` }}
            title={c.reason}
          >
            <span className={s.blockLabel}>Closed — {c.reason}</span>
          </div>
        ))}

        {selection && (
          <div
            className={s.selection}
            style={{
              left: `${(selection.from / totalSlots) * 100}%`,
              width: `${((selection.to - selection.from + 1) / totalSlots) * 100}%`,
            }}
          />
        )}

        {cursor !== null && (
          <div
            className={s.cursor}
            style={{ left: `${(cursor / totalSlots) * 100}%`, width: `${(1 / totalSlots) * 100}%` }}
            aria-hidden
          />
        )}

        {room.busy.map(b => {
          const cls = [
            s.booking,
            b.isMine ? s.bookingMine : '',
            b.status === 'PENDING_APPROVAL' ? s.bookingPending : '',
          ]
            .filter(Boolean)
            .join(' ')

          return (
            <button
              key={b.bookingId}
              type="button"
              className={cls}
              style={{
                left: `${pct(b.startsAt) * 100}%`,
                width: `${width(b.startsAt, b.endsAt) * 100}%`,
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onOpenBooking(b.bookingId)}
              aria-label={`${room.name}, ${timeInZone(new Date(b.startsAt), timezone)} to ${timeInZone(new Date(b.endsAt), timezone)}, ${b.title}${b.organizer ? `, ${b.organizer.fullName}` : ''}, booked`}
            >
              <span className={s.blockLabel}>
                {b.title}
                {b.organizer && <span className={s.blockOrganizer}>{b.organizer.fullName}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}

/** Current time in the grid zone, refreshed each minute for the now-line. */
function useNowMinutes(timeZone: string): number {
  const [minutes, setMinutes] = useState(() => currentMinutes(timeZone))
  useEffect(() => {
    const id = window.setInterval(() => setMinutes(currentMinutes(timeZone)), 60_000)
    return () => window.clearInterval(id)
  }, [timeZone])
  return minutes
}

function currentMinutes(timeZone: string): number {
  const [h, m] = timeInZone(new Date(), timeZone).split(':').map(Number)
  return h! * 60 + m!
}

function shortZone(timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' }).formatToParts(
      new Date(),
    )
    return parts.find(p => p.type === 'timeZoneName')?.value ?? timeZone
  } catch {
    return timeZone
  }
}
