/**
 * Email templates.
 *
 * Every template renders BOTH html and plain text. HTML-only mail scores badly
 * with spam filters and is unreadable in a text client, so the text version is
 * part of the message rather than a courtesy.
 *
 * Layout mechanics live in layout.ts; this file is the copy.
 *
 * Specification: docs/06-email-notifications.md section 3.
 */

import { config } from '../config.js'
import { logger } from '../middleware/requestContext.js'
import { button, compareRow, esc, layout, quote, row, style, table } from './layout.js'

/** Everything a booking template can refer to. */
export interface BookingPayload {
  bookingId?: string
  title?: string
  room?: string
  location?: string
  address?: string | null
  timeZone?: string
  startsAt?: string
  endsAt?: string
  organizer?: string
  organizerEmail?: string
  description?: string | null
  icsUid?: string
  url?: string
  reason?: string | null
  movedBy?: string | null
  cancelledBy?: string | null
  previousRoom?: string | null
  previousStartsAt?: string | null
  previousEndsAt?: string | null
  roomChanged?: boolean
  timeChanged?: boolean
  attendees?: string[]
  minutesUntil?: number
  [key: string]: unknown
}

export interface Rendered {
  subject: string
  html: string
  text: string
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** A date and time in the room's zone, with the zone ALWAYS named. */
function when(iso: string | undefined | null, timeZone: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  const tz = timeZone ?? 'UTC'
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date)
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(date)
  return `${day}, ${time}`
}

function timeOnly(iso: string | undefined | null, timeZone: string | undefined): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone ?? 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso))
}

const timeRange = (p: BookingPayload): string =>
  p.startsAt ? `${when(p.startsAt, p.timeZone)} - ${timeOnly(p.endsAt, p.timeZone)}` : ''

const roomLine = (p: BookingPayload): string =>
  [p.room, p.location].filter(Boolean).join(', ')

/**
 * The details card.
 *
 * The MEETING comes first. The subject line carries the title too, but a
 * recipient reading the body — or a forwarded copy, or a client that truncates
 * subjects — must still be able to tell which meeting this is about.
 */
const detailsHtml = (p: BookingPayload): string =>
  table(
    row('Meeting', p.title ?? '') +
      row('Room', roomLine(p)) +
      row('When', timeRange(p)) +
      row('Organizer', p.organizer ?? '') +
      row('Attendees', p.attendees?.join(', ') ?? '') +
      row('Address', p.address ?? ''),
  )

const detailsText = (p: BookingPayload): string =>
  [
    p.title ? `Meeting:   ${p.title}` : '',
    `Room:      ${roomLine(p)}`,
    `When:      ${timeRange(p)}`,
    p.organizer ? `Organizer: ${p.organizer}` : '',
    p.attendees?.length ? `Attendees: ${p.attendees.join(', ')}` : '',
    p.address ? `Address:   ${p.address}` : '',
  ]
    .filter(Boolean)
    .join('\n')

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

type Renderer = (p: BookingPayload) => Rendered

const bookingConfirmed: Renderer = p => ({
  subject: `Confirmed: ${p.title} - ${p.room}, ${timeOnly(p.startsAt, p.timeZone)}`,
  html: layout(
    `<h1 style="${style.heading}">Your booking is confirmed.</h1>` +
      detailsHtml(p) +
      button(p.url, 'View booking') +
      `<p style="${style.muted}">A calendar invitation is attached.</p>`,
  ),
  text: [
    'Your booking is confirmed.',
    '',
    detailsText(p),
    '',
    p.url ? `View it: ${p.url}` : '',
    'A calendar invitation is attached.',
  ]
    .filter(Boolean)
    .join('\n'),
})

const bookingPending: Renderer = p => ({
  subject: `Requested: ${p.title} - ${p.room}, ${timeOnly(p.startsAt, p.timeZone)}`,
  html: layout(
    `<h1 style="${style.heading}">Your request is awaiting approval.</h1>` +
      detailsHtml(p) +
      `<p style="${style.muted}">The room is held for you while the request waits, so nobody can book over it. You will hear back once it is decided.</p>` +
      button(p.url, 'View request'),
  ),
  text: [
    'Your request is awaiting approval.',
    '',
    detailsText(p),
    '',
    'The room is held for you while the request waits.',
    p.url ? `View it: ${p.url}` : '',
  ]
    .filter(Boolean)
    .join('\n'),
})

/**
 * The most important template in the system.
 *
 * Old and new must be legible at a glance and the reason impossible to miss.
 * The strikethrough is ACCOMPANIED by the words "Before" and "After", because
 * formatting alone is never the only signal - plenty of clients strip it.
 */
const bookingMoved: Renderer = p => {
  const changes: Array<[string, string, string]> = []
  if (p.roomChanged) changes.push(['Room', p.previousRoom ?? '', p.room ?? ''])
  if (p.timeChanged) {
    changes.push([
      'When',
      `${when(p.previousStartsAt, p.timeZone)} - ${timeOnly(p.previousEndsAt, p.timeZone)}`,
      timeRange(p),
    ])
  }
  if (changes.length === 0) changes.push(['When', '', timeRange(p)])

  const headline = p.movedBy
    ? `${p.movedBy} has moved your meeting.`
    : 'Your meeting has moved.'

  return {
    subject: `Moved: ${p.title} - now ${p.room}, ${timeOnly(p.startsAt, p.timeZone)}`,
    html: layout(
      `<h1 style="${style.heading}">${esc(headline)}</h1>` +
        `<p style="${style.body}"><strong>${esc(p.title)}</strong></p>` +
        table(
          `<tr><td></td>` +
            `<td style="${style.columnHead}">Before</td>` +
            `<td style="${style.columnHead}">After</td></tr>` +
            changes.map(([l, b, a]) => compareRow(l, b, a)).join(''),
        ) +
        quote(p.reason, p.movedBy) +
        button(p.url, 'View booking') +
        `<p style="${style.muted}">An updated calendar invitation is attached. It replaces the previous entry rather than adding a second one.</p>`,
    ),
    text: [
      headline,
      '',
      ...changes.map(([l, b, a]) => `${l}:\n  Before: ${b || '(unchanged)'}\n  After:  ${a}`),
      '',
      p.reason ? `Reason given${p.movedBy ? ` by ${p.movedBy}` : ''}:\n  "${p.reason}"` : '',
      '',
      p.url ? `View it: ${p.url}` : '',
      'An updated calendar invitation is attached.',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

const bookingCancelled: Renderer = p => {
  const headline = p.cancelledBy
    ? `${p.cancelledBy} has cancelled this meeting.`
    : 'This meeting has been cancelled.'

  return {
    subject: `Cancelled: ${p.title} - ${p.room}, ${timeOnly(p.startsAt, p.timeZone)}`,
    html: layout(
      `<h1 style="${style.heading}">${esc(headline)}</h1>` +
        detailsHtml(p) +
        quote(p.reason, p.cancelledBy) +
        button(`${config.APP_URL}/find`, 'Find another room') +
        `<p style="${style.muted}">This meeting has been removed from your calendar.</p>`,
    ),
    text: [
      headline,
      '',
      detailsText(p),
      '',
      p.reason ? `Reason:\n  "${p.reason}"` : '',
      '',
      `Find another room: ${config.APP_URL}/find`,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

const bookingUpdated: Renderer = p => ({
  subject: `Updated: ${p.title} - ${timeOnly(p.startsAt, p.timeZone)}`,
  html: layout(
    `<h1 style="${style.heading}">This meeting has been updated.</h1>` +
      detailsHtml(p) +
      button(p.url, 'View booking'),
  ),
  text: ['This meeting has been updated.', '', detailsText(p), '', p.url ? `View it: ${p.url}` : '']
    .filter(Boolean)
    .join('\n'),
})

/** Deliberately minimal: room, time, link. No calendar attachment. */
const bookingReminder: Renderer = p => ({
  subject: `Starting in ${p.minutesUntil ?? 15} minutes: ${p.title} - ${p.room}`,
  html: layout(
    `<h1 style="${style.heading}">${esc(p.title)} starts in ${esc(p.minutesUntil ?? 15)} minutes.</h1>` +
      `<p style="${style.body}"><strong>${esc(roomLine(p))}</strong><br>${esc(timeRange(p))}</p>` +
      button(p.url, 'View booking'),
  ),
  text: [
    `${p.title} starts in ${p.minutesUntil ?? 15} minutes.`,
    '',
    roomLine(p),
    timeRange(p),
    '',
    p.url ? `View it: ${p.url}` : '',
  ]
    .filter(Boolean)
    .join('\n'),
})

const bookingEndedEarly: Renderer = p => ({
  subject: `Ended early: ${p.title} - ${p.room}`,
  html: layout(
    `<h1 style="${style.heading}">This meeting was ended early.</h1>` +
      `<p style="${style.body}">${esc(p.room)} is free again for the rest of the slot.</p>` +
      detailsHtml(p),
  ),
  text: [
    'This meeting was ended early.',
    `${p.room} is free again for the rest of the slot.`,
    '',
    detailsText(p),
  ].join('\n'),
})

const RENDERERS: Record<string, Renderer> = {
  booking_confirmed: bookingConfirmed,
  booking_pending: bookingPending,
  booking_invitation: bookingConfirmed,
  booking_moved: bookingMoved,
  booking_cancelled: bookingCancelled,
  booking_updated: bookingUpdated,
  booking_reminder: bookingReminder,
  booking_ended_early: bookingEndedEarly,
}

export function hasTemplate(name: string): boolean {
  return name in RENDERERS
}

export const templateNames = (): string[] => Object.keys(RENDERERS).sort()

/**
 * Renders a template.
 *
 * An unknown template produces a plain fallback rather than throwing: a
 * notification nobody designed is still better than a cancellation nobody
 * receives, and the subject stored at queue time is already correct.
 */
export function render(
  template: string,
  payload: BookingPayload,
  storedSubject?: string,
): Rendered {
  const renderer = RENDERERS[template]

  if (renderer) {
    const result = renderer(payload)
    // The subject computed when the row was queued is authoritative: the admin
    // email log shows it, and it must not drift between queueing and sending.
    return storedSubject ? { ...result, subject: storedSubject } : result
  }

  logger.warn({ template }, 'No renderer for template; sending plain fallback')
  const text = [payload.title, '', detailsText(payload), '', payload.url ?? '']
    .filter(Boolean)
    .join('\n')

  return {
    subject: storedSubject ?? String(payload.title ?? 'RoomBook notification'),
    html: layout(`<p style="${style.body}">${esc(text).replace(/\n/g, '<br>')}</p>`),
    text,
  }
}

// ---------------------------------------------------------------------------
// Approval workflow (docs/15-approvals.md section 7)
// ---------------------------------------------------------------------------

/**
 * Tells an approver a decision is needed.
 *
 * Leads with who asked and what for, then how long they have. An approval
 * request that does not say when it lapses invites people to leave it.
 */
const approvalRequested: Renderer = p => {
  const expires = p.expiresAt
    ? `This request lapses ${when(String(p.expiresAt), p.timeZone)} if nobody responds, and the room is then released.`
    : ''

  return {
    subject: `Approval needed: ${p.title} - ${p.room}`,
    html: layout(
      `<h1 style="${style.heading}">${esc(p.requestedBy ?? p.organizer)} has asked for ${esc(p.room)}.</h1>` +
        detailsHtml(p) +
        (p.approvalNote
          ? `<p style="${style.body}"><strong>They added:</strong></p><blockquote style="${style.quote}">${esc(p.approvalNote)}</blockquote>`
          : '') +
        button(p.url, 'Review the request') +
        (expires ? `<p style="${style.muted}">${esc(expires)}</p>` : '') +
        `<p style="${style.muted}">The room is held while this waits, so nobody can book over it.</p>`,
    ),
    text: [
      `${p.requestedBy ?? p.organizer} has asked for ${p.room}.`,
      '',
      detailsText(p),
      '',
      p.approvalNote ? `They added:\n  "${p.approvalNote}"` : '',
      '',
      p.url ? `Review it: ${p.url}` : '',
      expires,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

const bookingApproved: Renderer = p => ({
  subject: `Approved: ${p.title} - ${p.room}, ${timeOnly(p.startsAt, p.timeZone)}`,
  html: layout(
    `<h1 style="${style.heading}">Your request has been approved.</h1>` +
      detailsHtml(p) +
      (p.note ? `<blockquote style="${style.quote}">${esc(p.note)}</blockquote>` : '') +
      button(p.url, 'View booking') +
      `<p style="${style.muted}">A calendar invitation is attached.</p>`,
  ),
  text: [
    'Your request has been approved.',
    '',
    detailsText(p),
    '',
    p.note ? `Note: "${p.note}"` : '',
    p.url ? `View it: ${p.url}` : '',
  ]
    .filter(Boolean)
    .join('\n'),
})

/** Approved, but elsewhere - which room they asked for still matters to them. */
const bookingApprovedMoved: Renderer = p => ({
  subject: `Approved in ${p.room}: ${p.title} - ${timeOnly(p.startsAt, p.timeZone)}`,
  html: layout(
    `<h1 style="${style.heading}">Your request has been approved, in a different room.</h1>` +
      `<p style="${style.body}">You asked for <strong>${esc(p.requestedRoom)}</strong>. You have <strong>${esc(p.room)}</strong>.</p>` +
      detailsHtml(p) +
      (p.note ? `<blockquote style="${style.quote}">${esc(p.note)}</blockquote>` : '') +
      button(p.url, 'View booking'),
  ),
  text: [
    'Your request has been approved, in a different room.',
    `You asked for ${p.requestedRoom}. You have ${p.room}.`,
    '',
    detailsText(p),
    '',
    p.note ? `Note: "${p.note}"` : '',
    p.url ? `View it: ${p.url}` : '',
  ]
    .filter(Boolean)
    .join('\n'),
})

const bookingRejected: Renderer = p => ({
  subject: `Not approved: ${p.title} - ${p.room}`,
  html: layout(
    `<h1 style="${style.heading}">Your request was not approved.</h1>` +
      detailsHtml(p) +
      quote(p.reason, p.rejectedBy ? String(p.rejectedBy) : null) +
      button(p.url, 'Find another room') +
      `<p style="${style.muted}">The room is free again, so it may now be booked by someone else.</p>`,
  ),
  text: [
    'Your request was not approved.',
    '',
    detailsText(p),
    '',
    p.reason ? `Reason given${p.rejectedBy ? ` by ${p.rejectedBy}` : ''}:\n  "${p.reason}"` : '',
    '',
    p.url ? `Find another room: ${p.url}` : '',
  ]
    .filter(Boolean)
    .join('\n'),
})

/** Nobody acted in time. Both sides are told, since both were waiting. */
const approvalExpired: Renderer = p => ({
  subject: `Expired: ${p.title} - ${p.room}`,
  html: layout(
    `<h1 style="${style.heading}">This request expired without a decision.</h1>` +
      detailsHtml(p) +
      `<p style="${style.body}">Nobody responded in time, so the room has been released and is available again.</p>` +
      button(`${config.APP_URL}/find`, 'Book another room'),
  ),
  text: [
    'This request expired without a decision.',
    '',
    detailsText(p),
    '',
    'Nobody responded in time, so the room has been released.',
    `Book another room: ${config.APP_URL}/find`,
  ].join('\n'),
})

const approvalWithdrawn: Renderer = p => ({
  subject: `Withdrawn: ${p.title} - ${p.room}`,
  html: layout(
    `<h1 style="${style.heading}">${esc(p.organizer)} has withdrawn this request.</h1>` +
      detailsHtml(p) +
      `<p style="${style.muted}">No action is needed from you.</p>`,
  ),
  text: [
    `${p.organizer} has withdrawn this request.`,
    '',
    detailsText(p),
    '',
    'No action is needed from you.',
  ].join('\n'),
})

Object.assign(RENDERERS, {
  approval_requested: approvalRequested,
  booking_approved: bookingApproved,
  booking_approved_moved: bookingApprovedMoved,
  booking_rejected: bookingRejected,
  approval_expired: approvalExpired,
  approval_withdrawn: approvalWithdrawn,
})
