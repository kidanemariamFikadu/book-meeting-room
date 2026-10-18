/**
 * iCalendar generation.
 *
 * Case IDs refer to docs/10-testing.md. T-81 is the one that matters most:
 * a stable UID with an advancing SEQUENCE is what makes a moved meeting
 * update in someone's calendar rather than appear twice.
 */

import { describe, expect, it } from 'vitest'

import { buildIcs, icsAttachment, type IcsEvent } from '../src/mail/ics.js'

const base: IcsEvent = {
  uid: 'booking-abc@roombook',
  sequence: 0,
  method: 'REQUEST',
  start: new Date('2026-11-04T06:00:00Z'),
  end: new Date('2026-11-04T07:00:00Z'),
  title: 'Design review',
  description: 'Walk through the booking flow',
  location: 'Boardroom, 3rd floor, Head Office',
  url: 'https://rooms.acme.test/bookings/abc',
  organizer: { email: 'alice@acme.test', name: 'Alice Bekele' },
  attendees: [{ email: 'bob@acme.test', name: 'Bob Tesfaye' }],
  timeZone: 'Africa/Addis_Ababa',
}

/** Unfolds continuation lines so a property can be asserted as one string. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n /g, '').split('\r\n').filter(Boolean)
}

const propertyOf = (ics: string, name: string) =>
  unfold(ics).find(l => l.startsWith(`${name}:`) || l.startsWith(`${name};`))

describe('structure', () => {
  it('produces a well-formed VCALENDAR with CRLF line endings', () => {
    const ics = buildIcs(base)
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true)
    // Bare LF is rejected by some clients.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('writes the core properties', () => {
    const ics = buildIcs(base)
    expect(propertyOf(ics, 'UID')).toBe('UID:booking-abc@roombook')
    expect(propertyOf(ics, 'SEQUENCE')).toBe('SEQUENCE:0')
    expect(propertyOf(ics, 'METHOD')).toBe('METHOD:REQUEST')
    expect(propertyOf(ics, 'DTSTART')).toBe('DTSTART:20261104T060000Z')
    expect(propertyOf(ics, 'DTEND')).toBe('DTEND:20261104T070000Z')
    expect(propertyOf(ics, 'STATUS')).toBe('STATUS:CONFIRMED')
  })

  it('includes the organizer and attendees with RSVP requested', () => {
    const ics = buildIcs(base)
    expect(propertyOf(ics, 'ORGANIZER')).toContain('mailto:alice@acme.test')
    const attendee = propertyOf(ics, 'ATTENDEE')
    expect(attendee).toContain('mailto:bob@acme.test')
    expect(attendee).toContain('PARTSTAT=NEEDS-ACTION')
    expect(attendee).toContain('RSVP=TRUE')
  })
})

describe('escaping', () => {
  /**
   * An unescaped comma truncates the value in most clients, so a room name
   * like "Boardroom, 3rd floor" would silently lose everything after the
   * comma.
   */
  it('escapes commas, semicolons and backslashes', () => {
    const ics = buildIcs({
      ...base,
      title: 'Budget; forecast, and a back\\slash',
      location: 'Boardroom, 3rd floor',
    })
    expect(propertyOf(ics, 'SUMMARY')).toBe(
      'SUMMARY:Budget\\; forecast\\, and a back\\\\slash',
    )
    expect(propertyOf(ics, 'LOCATION')).toBe('LOCATION:Boardroom\\, 3rd floor')
  })

  it('escapes newlines in a description rather than breaking the property', () => {
    const ics = buildIcs({ ...base, description: 'Line one\nLine two' })
    const description = propertyOf(ics, 'DESCRIPTION')
    expect(description).toContain('Line one\\nLine two')
    // Every physical line must be a property or a continuation.
    for (const line of unfold(ics)) {
      expect(line).toMatch(/^[A-Z-]+[:;]/)
    }
  })

  /**
   * T-79 in spirit: a cancellation reason is free text typed by an admin and
   * read by the organizer. It must not be able to inject a property.
   */
  it('cannot inject a property through free text', () => {
    const ics = buildIcs({
      ...base,
      description: 'Harmless\r\nSUMMARY:Injected\r\nX-EVIL:true',
    })
    expect(propertyOf(ics, 'SUMMARY')).toBe('SUMMARY:Design review')
    expect(unfold(ics).some(l => l.startsWith('X-EVIL'))).toBe(false)
  })
})

describe('line folding', () => {
  it('folds a long line to 75 octets with a leading space on continuations', () => {
    const ics = buildIcs({ ...base, title: 'A'.repeat(200) })
    const physical = ics.split('\r\n')

    for (const line of physical) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75)
    }
    // Unfolding must restore the original value exactly.
    expect(propertyOf(ics, 'SUMMARY')).toBe(`SUMMARY:${'A'.repeat(200)}`)
  })

  /**
   * Folding is measured in octets, so a multi-byte character must not be
   * split across a fold - that would corrupt it.
   */
  it('does not split a multi-byte character when folding', () => {
    const title = 'የስብሰባ ክፍል '.repeat(12)
    const ics = buildIcs({ ...base, title })

    for (const line of ics.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75)
    }
    expect(propertyOf(ics, 'SUMMARY')).toBe(`SUMMARY:${title}`)
    // No replacement characters, which is what a split codepoint produces.
    expect(ics).not.toContain('�')
  })
})

describe('updates and cancellations', () => {
  /**
   * T-81. The defining test for this module.
   *
   * Create, move, cancel: the UID is identical throughout and the SEQUENCE
   * strictly increases. Together those make a client update the entry it
   * already has instead of adding another.
   */
  it('T-81: keeps one UID across create, move and cancel while SEQUENCE advances', () => {
    const created = buildIcs({ ...base, sequence: 0, method: 'REQUEST' })
    const moved = buildIcs({
      ...base,
      sequence: 1,
      method: 'REQUEST',
      start: new Date('2026-11-04T08:00:00Z'),
      end: new Date('2026-11-04T09:00:00Z'),
    })
    const cancelled = buildIcs({ ...base, sequence: 2, method: 'CANCEL' })

    const uids = [created, moved, cancelled].map(i => propertyOf(i, 'UID'))
    expect(new Set(uids).size).toBe(1)

    const sequences = [created, moved, cancelled].map(i =>
      Number(propertyOf(i, 'SEQUENCE')!.split(':')[1]),
    )
    expect(sequences).toEqual([0, 1, 2])

    expect(propertyOf(moved, 'DTSTART')).toBe('DTSTART:20261104T080000Z')
  })

  /**
   * A cancellation needs all three of METHOD:CANCEL, STATUS:CANCELLED and an
   * advanced SEQUENCE. Omitting any one is the usual reason a cancelled
   * meeting lingers in someone's calendar.
   */
  it('T-72: a cancellation carries METHOD, STATUS and an advanced SEQUENCE', () => {
    const ics = buildIcs({ ...base, sequence: 3, method: 'CANCEL' })
    expect(propertyOf(ics, 'METHOD')).toBe('METHOD:CANCEL')
    expect(propertyOf(ics, 'STATUS')).toBe('STATUS:CANCELLED')
    expect(propertyOf(ics, 'SEQUENCE')).toBe('SEQUENCE:3')
  })

  it('sets the method parameter on the attachment content type', () => {
    expect(icsAttachment(base).contentType).toContain('method=REQUEST')
    expect(icsAttachment({ ...base, method: 'CANCEL' }).contentType).toContain('method=CANCEL')
    expect(icsAttachment(base).filename).toBe('invite.ics')
  })
})

describe('recurrence', () => {
  it('writes an RRULE for a series', () => {
    const ics = buildIcs({ ...base, rrule: 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20271231T000000Z' })
    expect(propertyOf(ics, 'RRULE')).toBe('RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20271231T000000Z')
  })

  /**
   * T-130 (building toward M4b). RECURRENCE-ID is what scopes a change to ONE
   * occurrence; the same UID without it would replace the whole series.
   */
  it('T-130: an exception carries the same UID plus a RECURRENCE-ID', () => {
    const series = buildIcs({ ...base, rrule: 'FREQ=WEEKLY;BYDAY=TU' })
    const exception = buildIcs({
      ...base,
      sequence: 1,
      recurrenceId: new Date('2026-11-04T06:00:00Z'),
      start: new Date('2026-11-04T08:00:00Z'),
      end: new Date('2026-11-04T09:00:00Z'),
    })

    expect(propertyOf(exception, 'UID')).toBe(propertyOf(series, 'UID'))
    expect(propertyOf(exception, 'RECURRENCE-ID')).toBe('RECURRENCE-ID:20261104T060000Z')
    // The exception itself must not repeat, or it would spawn a second series.
    expect(propertyOf(exception, 'RRULE')).toBeUndefined()
  })

  it('writes EXDATE for a skipped occurrence', () => {
    const ics = buildIcs({
      ...base,
      rrule: 'FREQ=WEEKLY;BYDAY=TU',
      exdates: [new Date('2026-12-23T06:00:00Z')],
    })
    expect(propertyOf(ics, 'EXDATE')).toBe('EXDATE:20261223T060000Z')
  })
})
