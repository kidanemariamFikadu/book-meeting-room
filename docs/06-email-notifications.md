# 06 — Email & Notifications

Email is not a side effect here — it is how the organization learns that an admin moved their
meeting. It gets the same rigour as the booking logic.

---

## 1. Delivery pipeline

```
 Business event (inside the DB transaction)
        │
        ▼
 email_outbox rows, one per recipient, status = QUEUED
        │                                    ⟵ transaction commits (or rolls back, sending nothing)
        ▼
 OutboxWorker, every 15 s
   claim up to 20 rows atomically  (UPDATE … SET status='SENDING' … RETURNING)
        │
        ├─ render MJML → HTML, and a plain-text alternative
        ├─ build the .ics attachment where applicable
        ├─ send via the Mailer interface
        │
        ├─ success → status=SENT, sent_at, store rendered bodies
        └─ failure → attempts++, last_error
                     attempts < 5 → QUEUED, scheduled_at = now + backoff
                     attempts = 5 → FAILED, visible in the admin email log
```

**Backoff:** 1 min, 5 min, 15 min, 1 h, 6 h. A `SENDING` row older than 10 minutes is assumed
orphaned by a crash and is returned to `QUEUED` — this is why a restart mid-send does not lose
mail.

**The `Mailer` interface** has three implementations, selected by configuration:

| Implementation | When | Behaviour |
|----------------|------|-----------|
| `SmtpMailer` | Production, when SMTP is configured | nodemailer over SMTP with a pooled connection |
| `ConsoleMailer` | Development with no SMTP | Logs a summary and stores the body; viewable at `/dev/emails`. **Development never needs real credentials** |
| `CapturingMailer` | Tests | Collects messages in memory for assertions |

Swapping to Resend or SendGrid (D2) means writing a fourth implementation of the same
interface — no other file changes.

---

## 1b. When RoomBook does *not* send email

Two features added after v1.0 change what gets sent. Both are decided **once per booking, at
creation**, and the decision is stored so it cannot drift mid-booking.

### Native invitations replace `.ics` for connected organizers

If the organizer has a healthy calendar connection ([13](13-calendar-sync.md)), RoomBook
creates the event through the provider API and **the provider sends the invitations**.
RoomBook then sends **no** booking email to anyone for that booking.

```
useNativeInvites = organizer.calendarConnection?.isHealthy === true
```

| Organizer | Who notifies attendees | RoomBook sends |
|-----------|------------------------|----------------|
| Connected | Google / Microsoft, natively | Nothing (reminders still optional) |
| Not connected | RoomBook | The full matrix below, with `.ics` |
| Connected but token broken | RoomBook, as fallback | The full matrix below, plus one "reconnect your calendar" notice |

> **This is the most important rule in this document.** A user who receives both an `.ics`
> attachment and a native Google invitation ends up with the meeting twice in their calendar
> and stops trusting the system. Test T-140 and the requirement US-C6 exist for this alone.

### One email per action, not one per occurrence

For recurring meetings ([12 §7](12-recurrence.md#7-notifications--the-flooding-problem)),
a 52-week series produces **one** email per recipient describing the pattern — never 52.
Per-occurrence email is sent only when a single occurrence is specifically changed, and for
reminders. The outbox row carries `series_id` and `occurrence_count` so the template can say
"34 meetings" rather than listing them.

## 1c. D6 — organizer-only email in v1

**Only the organizer receives RoomBook email in v1.** Attendees do not, unless the organizer's
calendar is connected, in which case Google or Microsoft invites them natively — which is not
RoomBook email at all.

This is implemented as `org_settings.notify_attendees`, which already exists in the schema and
now **ships as `false`**. Every attendee template in the matrix below is still built and
tested; it is simply gated. Expanding to attendees later is a single settings toggle, not a
build, so nothing is lost by starting narrow.

| Organizer | Attendees receive |
|-----------|-------------------|
| Calendar connected | A **native** invitation from Google / Microsoft, with working RSVP buttons |
| Not connected, `notify_attendees = false` (**v1 default**) | **Nothing from RoomBook.** The organizer is expected to tell them |
| Not connected, `notify_attendees = true` (your later toggle) | The full `.ics` invitation set |

> **One consequence to be aware of before launch.** With the v1 default, an attendee added by
> an organizer who has *not* connected a calendar is never told about the meeting by the
> system. If you adopt calendar sync broadly this is a non-issue, because the provider handles
> it. If sync adoption is partial, I would turn `notify_attendees` on at launch — it costs
> nothing, since the templates are already built and tested.

**Approval email is the deliberate exception to D6** ([15 §7](15-approvals.md#7-notifications)):
approvers are not the organizer, and an approver who is never told has nothing to act on.

## 2. Trigger matrix

| # | Event | Template | To | Cc/also | Has `.ics` | Can be suppressed |
|---|-------|----------|-----|---------|-----------|-------------------|
| 1 | Booking created | `booking_confirmed` | Organizer | — | `REQUEST` | No |
| 2 | Booking created with attendees | `booking_invitation` | Each attendee | — | `REQUEST` | By `notifyAttendees: false` |
| 3 | Organizer edits title/description/attendees | `booking_updated` | Attendees | Organizer only if an admin made the change | `REQUEST`, sequence +1 | By `notifyAttendees: false` |
| 4 | **Admin moves room and/or time** | `booking_moved` | Organizer | Each attendee | `REQUEST`, sequence +1 | **No** (BR-N8) |
| 5 | Organizer changes own room/time | `booking_moved` | Attendees | — | `REQUEST`, sequence +1 | By `notifyAttendees: false` |
| 6 | **Admin cancels** | `booking_cancelled` | Organizer | Each attendee | `CANCEL` | **No** (BR-N8) |
| 7 | Organizer cancels | `booking_cancelled` | Attendees | — | `CANCEL` | No |
| 8 | Newly added attendee on an existing booking | `booking_invitation` | That attendee only | — | `REQUEST` | By `notifyAttendees: false` |
| 9 | Attendee removed | `booking_uninvited` | That attendee only | — | `CANCEL` | By `notifyAttendees: false` |
| 10 | Reminder, N minutes before start | `booking_reminder` | Organizer + attendees | — | No | By user opt-out (US-N8) |
| 11 | Organizer reassigned | `booking_transferred` | Old and new organizer | — | `REQUEST` | No |
| 12 | Room deactivated with bookings the admin force-cancelled | `booking_cancelled` with a room-closure reason | Organizer + attendees | — | `CANCEL` | No |
| 13 | User invited | `user_invited` | The new user | — | No | No |
| 14 | Password reset requested | `password_reset` | That user | — | No | No |
| 15 | Password changed | `password_changed` | That user | — | No | No (security notice) |
| 16 | Role changed to admin or owner | `role_changed` | That user | — | No | No |
| 17 | **Series created** | `series_confirmed` | Organizer | Each attendee | `REQUEST` with `RRULE` | No |
| 18 | **Series changed** (`ENTIRE_SERIES` / `THIS_AND_FOLLOWING`) | `series_updated` | Organizer + attendees | — | `REQUEST`, sequence +1 | No for admin changes |
| 19 | **Single occurrence moved or cancelled** | `occurrence_moved` / `occurrence_cancelled` | Organizer + attendees | — | `RECURRENCE-ID` event | No for admin changes |
| 20 | **Series partially created** (some dates clashed) | included in `series_confirmed` | Organizer | — | — | No |
| 21 | Calendar connection broken | `calendar_reauth_needed` | That user | — | No | No |
| 22 | A calendar-side change was **rejected** because the room was taken | `calendar_change_rejected` | That user | — | No | **No** — they must know their change did not stick |

**The actor is not emailed about their own action** (BR-N3), with two deliberate exceptions:
the organizer always gets their own booking confirmation as a receipt, and an admin who
is also the organizer still gets the move or cancellation notice (BR-N4), because the record
matters more than the inbox noise.

---

## 3. Template specifications

Every template renders both HTML (MJML-compiled) and plain text. Subjects stay under 78
characters so they are not truncated in list views. Times are rendered in the **recipient's**
timezone with the zone abbreviation.

### Shared layout

- Header: organization logo (or name), on a neutral band
- Body: a one-line summary in bold, then a details card, then the action button
- Details card, always in this order: **Room · Date · Time · Organizer · Attendees**
- Primary button: "View booking" → `${APP_URL}/bookings/:id`
- Footer: organization name, address of the room's location, and a line explaining why the
  recipient received this email
- No tracking pixels, no external images other than the logo

---

### `booking_confirmed`

**Subject:** `Confirmed: {title} — {room}, {day} at {time}`

> Your booking is confirmed.
>
> | | |
> |---|---|
> | **Room** | Boardroom, 3rd floor, Head Office |
> | **Date** | Tuesday, 4 November 2026 |
> | **Time** | 09:00 – 10:00 (EAT) |
> | **Organizer** | You |
> | **Attendees** | Alice Bekele, Bob Tesfaye, partner@external.com |
>
> [View booking] [Cancel booking]
>
> A calendar invitation is attached.

---

### `booking_moved`
The most important template in the system. The old and new details must be legible at a glance,
and the reason must be impossible to miss.

**Subject:** `Moved: {title} — now {newRoom}, {day} at {newTime}`

> **An administrator has moved your meeting.**
>
> | | Before | After |
> |---|--------|-------|
> | **Room** | ~~Boardroom~~ | **Meeting Room C** |
> | **Date** | Tuesday, 4 November | Tuesday, 4 November |
> | **Time** | ~~09:00 – 10:00~~ | **11:00 – 12:00 (EAT)** |
>
> **Reason given by Sara Mengistu (Office Admin):**
> > Boardroom required for the quarterly review.
>
> [View booking]
>
> Your attendees have also been notified. An updated calendar invitation is attached and will
> replace the previous entry in your calendar.

Rendering rules:
- Only changed rows are emphasised; unchanged rows are shown in muted text for context.
- The strikethrough is accompanied by the words "Before" and "After" — formatting alone is
  never the only signal (NFR-5, and many clients strip styling).
- The reason is quoted verbatim, HTML-escaped, in a visually distinct block.

---

### `booking_cancelled`

**Subject:** `Cancelled: {title} — {room}, {day} at {time}`

> **Your meeting has been cancelled by Sara Mengistu (Office Admin).**
>
> | | |
> |---|---|
> | **Room** | Boardroom |
> | **Date** | Tuesday, 4 November 2026 |
> | **Time** | 09:00 – 10:00 (EAT) |
>
> **Reason:**
> > Emergency maintenance on the projector.
>
> [Find another room]
>
> This meeting has been removed from your calendar. Your attendees have also been notified.

When the organizer cancels their own booking, the opening line becomes "You cancelled this
meeting" for the organizer's copy and "{Organizer} has cancelled this meeting" for attendees.

---

### `booking_invitation`

**Subject:** `Invitation: {title} — {room}, {day} at {time}`
Body as `booking_confirmed`, opening with "{Organizer} has invited you to a meeting", and
noting that accepting is done in their own calendar client (v1 does not track RSVP).

### `booking_updated`

**Subject:** `Updated: {title} — {day} at {time}`
Lists only what changed, in the same Before/After table used by `booking_moved`.

### `booking_reminder`

**Subject:** `Starting in {n} minutes: {title} — {room}`
Deliberately minimal: room, floor, time, and the link. No `.ics`.

### `booking_uninvited`

**Subject:** `Removed from: {title} — {day} at {time}`
One line, plus a `CANCEL` `.ics` so the entry leaves their calendar.

### `series_confirmed`

**Subject:** `Confirmed: {title} — {pattern}, from {firstDate}`

> Your recurring booking is confirmed.
>
> | | |
> |---|---|
> | **Repeats** | Every Tuesday at 09:00 – 09:30 (EAT) |
> | **From** | Tuesday, 4 November 2026 |
> | **Until** | Tuesday, 28 December 2027 — **52 meetings** |
> | **Room** | Boardroom, 3rd floor, Head Office |
>
> **3 dates could not be booked** and have been skipped:
> > 23 December — Boardroom taken by "Quarterly review"
> > 1 January — building closed for New Year
> > 30 March — clock change, 09:00 does not exist on this date
>
> [View series] [Book those dates elsewhere]

The skipped-dates block is omitted when there are none. It is never silently dropped — a
series that quietly missed three weeks is a meeting people miss.

### `occurrence_moved`

**Subject:** `Moved: {title} on {date} only`

> **An administrator has moved one meeting in your recurring series.**
>
> | | Before | After |
> |---|--------|-------|
> | **Date** | Tuesday, 4 November | Tuesday, 4 November |
> | **Time** | ~~09:00 – 09:30~~ | **11:00 – 11:30 (EAT)** |
> | **Room** | ~~Boardroom~~ | **Meeting Room C** |
>
> **Reason given by Sara Mengistu (Office Admin):**
> > Boardroom required for the quarterly review.
>
> **Only this date has changed.** The rest of your weekly series is unaffected and continues
> as normal on 11 November.
>
> [View this meeting] [View the series]

That penultimate line is the whole point of the template. Without it, every recipient has to
open the app to find out whether their standup still exists.

### `calendar_change_rejected`

**Subject:** `Your calendar change could not be applied — {title}`

> You moved **{title}** to 14:00 in your Google Calendar, but **Boardroom is already booked**
> at that time by Sara Mengistu.
>
> **The meeting remains at 09:00 – 10:00 (EAT)** and your calendar has been set back to match.
>
> To move it, use RoomBook — it will show you which rooms are free.
>
> [Find a free time]

Plain about what happened, why, and what the current truth is. A silently reverted change is
how people lose faith in a sync.

### `user_invited`

**Subject:** `You have been invited to {Organization} room booking`
Explains what the system is, who invited them, and carries the accept link. States plainly that
the link expires in 72 hours and can only be used once.

### `password_reset`

**Subject:** `Reset your {Organization} room booking password`
One link, expiring in 1 hour, single use. Includes: "If you did not request this, you can
ignore this email — your password has not changed." No other account details are included.

### `password_changed`

**Subject:** `Your password was changed`
Includes the time and the approximate location/IP, and tells the user to contact their admin
immediately if it was not them. Sent even when the user changed it themselves.

### `role_changed`

**Subject:** `Your access level has changed`
States the new role and what it allows.

---

## 4. Calendar attachments (`.ics`)

Getting these right is what makes the difference between a moved meeting updating in someone's
calendar and silently appearing twice.

| Field | Value |
|-------|-------|
| `UID` | `bookings.ics_uid` — a UUID generated at creation and **never changed**, not even on a move |
| `SEQUENCE` | `bookings.ics_sequence`, incremented on every change. Clients ignore updates whose sequence has not advanced |
| `METHOD` | `REQUEST` for create, update and move; `CANCEL` for cancellation |
| `DTSTART` / `DTEND` | UTC, with `TZID` where a client benefits from the local zone |
| `ORGANIZER` | The organizer's name and email |
| `ATTENDEE` | One line per attendee, `PARTSTAT=NEEDS-ACTION`, `RSVP=TRUE` |
| `LOCATION` | `"{Room}, {floor}, {Location name}, {address}"` |
| `SUMMARY` | The booking title |
| `DESCRIPTION` | Description, plus a link back to the booking page |
| `STATUS` | `CONFIRMED`, or `CANCELLED` on the cancel method |
| `LAST-MODIFIED`, `DTSTAMP` | Current UTC |

A cancellation `.ics` repeats the same `UID` with an incremented `SEQUENCE`, `METHOD:CANCEL` and
`STATUS:CANCELLED`. Omitting any one of those three is the usual reason a cancelled meeting
lingers in someone's calendar.

---

## 5. Deliverability

The best-written email is worthless in a spam folder.

1. **SPF, DKIM and DMARC** must be configured for the sending domain. This is an IT task and is
   on the launch checklist in [09-configuration.md](09-configuration.md).
2. Send from a real, monitored address in the organization's own domain
   (`rooms@acme.com`), never a no-reply address at a third-party domain.
3. Set `Reply-To` to the organizer for booking emails, so replying reaches a human.
4. Always provide a plain-text alternative. HTML-only mail scores badly.
5. Keep the HTML under 100 KB, and never image-only.
6. Set `Auto-Submitted: auto-generated` and, on reminders, `Precedence: bulk`, so out-of-office
   replies do not storm back.
7. Threading: set `References` and `In-Reply-To` to a stable
   `<booking-{id}@{domain}>` message ID, so all mail about one booking threads together in the
   recipient's client. This is a small detail that noticeably reduces inbox noise.

---

## 6. Administration and observability

- **Email log** (`/admin/emails`, US-N6): every row with status, recipient, template, attempts
  and last error. Filterable, and each row can be opened to see exactly what was sent.
- **Resend**: any `FAILED` row can be requeued by an admin with one click.
- **Booking page**: shows the emails generated by that booking, so an admin can answer "did
  Bob get told?" without leaving the screen.
- **Metrics logged**: queue depth, oldest queued age, send latency, failure rate by error class.
- **Alert condition** worth watching once live: oldest `QUEUED` row older than 5 minutes, or
  any `FAILED` row in the last hour.

---

## 7. Future channels (not in v1)

The `NotificationService` dispatches to channels through one interface, so these are additive:

- In-app notification bell
- Slack or Microsoft Teams message to the organizer
- SMS for cancellations within an hour of the start time
- Digest email: "your bookings this week"
