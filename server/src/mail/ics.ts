/**
 * iCalendar (RFC 5545) generation.
 *
 * Hand-written rather than delegated to a library, because the three fields
 * that decide whether a moved meeting UPDATES an existing calendar entry or
 * appears twice — UID, SEQUENCE and METHOD — need exact control, and most
 * wrappers make at least one of them awkward.
 *
 * Getting this wrong is the single most common flaw in booking systems:
 * the organizer ends up with two copies of the same meeting and stops
 * trusting the tool.
 *
 * Specification: docs/06-email-notifications.md section 4.
 */

export type IcsMethod = 'REQUEST' | 'CANCEL'

export interface IcsAttendee {
  email: string
  name?: string | null
}

export interface IcsEvent {
  /** Stable for the booking's whole life. NEVER regenerated, not even on a move. */
  uid: string
  /** Incremented on every change; clients ignore updates that do not advance it. */
  sequence: number
  method: IcsMethod
  start: Date
  end: Date
  title: string
  description?: string | null
  location?: string | null
  url?: string | null
  organizer: { email: string; name?: string | null }
  attendees?: IcsAttendee[]
  /** Set on an exception to one occurrence of a series: its ORIGINAL start. */
  recurrenceId?: Date | null
  /** RFC 5545 RRULE text for a recurring series, without the "RRULE:" prefix. */
  rrule?: string | null
  /** Occurrences removed from a series. */
  exdates?: Date[]
  timeZone: string
}

/**
 * Escapes a text value per RFC 5545 section 3.3.11.
 *
 * Backslash first, or it would double-escape the sequences added afterwards.
 * An unescaped comma or semicolon silently truncates the value in most
 * clients, which is how a meeting title turns into half a meeting title.
 */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * Folds a line to 75 octets, per RFC 5545 section 3.1.
 *
 * Measured in OCTETS, not characters: a non-ASCII room name is multi-byte in
 * UTF-8, and folding on character count can split a codepoint and corrupt it.
 * Continuation lines begin with a single space.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return line

  const parts: string[] = []
  let offset = 0
  let limit = 75

  while (offset < bytes.length) {
    let take = Math.min(limit, bytes.length - offset)

    // Do not cut mid-codepoint: back off while the next byte is a UTF-8
    // continuation byte (10xxxxxx).
    if (offset + take < bytes.length) {
      while (take > 1 && (bytes[offset + take]! & 0xc0) === 0x80) take--
    }

    parts.push(bytes.subarray(offset, offset + take).toString('utf8'))
    offset += take
    limit = 74 // subsequent lines carry a leading space
  }

  return parts.join('\r\n ')
}

/** UTC timestamp in the basic format iCalendar requires. */
function formatUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
}

export function buildIcs(event: IcsEvent): string {
  const now = new Date()

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RoomBook//Meeting Room Booking//EN',
    'CALSCALE:GREGORIAN',
    // METHOD is what tells the client this is an invitation or a withdrawal
    // rather than a calendar to import.
    `METHOD:${event.method}`,
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `SEQUENCE:${event.sequence}`,
    `DTSTAMP:${formatUtc(now)}`,
    `LAST-MODIFIED:${formatUtc(now)}`,
    `DTSTART:${formatUtc(event.start)}`,
    `DTEND:${formatUtc(event.end)}`,
    `SUMMARY:${escapeText(event.title)}`,
    `STATUS:${event.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    // Shown by clients as the organizing timezone, which helps a recipient in
    // another zone understand what they are looking at.
    `X-WR-TIMEZONE:${event.timeZone}`,
  ]

  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`)

  if (event.description || event.url) {
    const body = [event.description, event.url].filter(Boolean).join('\n\n')
    lines.push(`DESCRIPTION:${escapeText(body)}`)
  }

  if (event.url) lines.push(`URL:${event.url}`)

  lines.push(
    `ORGANIZER;CN=${escapeText(event.organizer.name ?? event.organizer.email)}:mailto:${event.organizer.email}`,
  )

  for (const attendee of event.attendees ?? []) {
    lines.push(
      `ATTENDEE;CN=${escapeText(attendee.name ?? attendee.email)};ROLE=REQ-PARTICIPANT;` +
        `PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee.email}`,
    )
  }

  if (event.rrule) lines.push(`RRULE:${event.rrule}`)

  /*
   * RECURRENCE-ID identifies WHICH occurrence of a series this event replaces.
   * With the same UID and a RECURRENCE-ID, a client updates that one
   * occurrence; without it, the whole series is replaced. This single line is
   * the difference between "just this Tuesday moved" and "the standup has
   * changed forever".
   */
  if (event.recurrenceId) lines.push(`RECURRENCE-ID:${formatUtc(event.recurrenceId)}`)

  for (const exdate of event.exdates ?? []) lines.push(`EXDATE:${formatUtc(exdate)}`)

  lines.push('END:VEVENT', 'END:VCALENDAR')

  // CRLF throughout, as the specification requires; some clients reject LF.
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

export interface IcsAttachment {
  filename: string
  content: string
  contentType: string
}

/**
 * The attachment, with the `method` parameter on the content type.
 *
 * Outlook in particular uses that parameter to decide whether to show Accept
 * and Decline buttons; without it the attachment is treated as a plain file.
 */
export function icsAttachment(event: IcsEvent): IcsAttachment {
  return {
    filename: 'invite.ics',
    content: buildIcs(event),
    contentType: `text/calendar; charset=utf-8; method=${event.method}`,
  }
}
