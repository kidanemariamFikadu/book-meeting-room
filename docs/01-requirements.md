# 01 — Requirements

Requirement IDs are stable. Tests, API endpoints and the delivery plan all reference them.

Priority key: **MUST** = v1 ships without it only if you say so · **SHOULD** = v1 unless time
runs out · **COULD** = nice to have · **WON'T** = explicitly deferred.

---

## 1. Roles

| Role | Code | Granted by | Typical holder |
|------|------|-----------|----------------|
| Employee | `EMPLOYEE` | Default for every invited user | All staff |
| Office Admin | `ADMIN` | Owner | Office manager, receptionist, facilities |
| Owner | `OWNER` | Seeded at install; can promote others | IT lead or operations director |

Roles are cumulative: `OWNER` ⊃ `ADMIN` ⊃ `EMPLOYEE`.

---

## 2. User stories

### 2.1 Authentication and accounts

| ID | Story | Priority |
|----|-------|----------|
| US-A1 | As an employee, I log in with my work email and password so that I can access the system. | MUST |
| US-A2 | As an invited employee, I set my own password from a one-time emailed link so that no shared password is ever sent to me. | MUST |
| US-A3 | As an employee, I reset a forgotten password via an emailed link so that I am not blocked waiting for IT. | MUST |
| US-A4 | As a user, I log out so that my session cannot be reused on a shared computer. | MUST |
| US-A5 | As an owner, I invite, deactivate and reactivate users so that access matches current staff. | MUST |
| US-A6 | As an owner, I promote a user to admin, or demote an admin, so that responsibility can change hands. | MUST |
| US-A7 | As a user, I change my own password and display name. | SHOULD |
| US-A8 | As a user, I set my preferred timezone so that times display correctly when I travel. | COULD |

### 2.2 Room configuration (admin)

| ID | Story | Priority |
|----|-------|----------|
| US-R1 | As an admin, I create a room with a name, capacity, floor and location so that staff can find it. | MUST |
| US-R2 | As an admin, I tag a room with equipment features (projector, video conference, whiteboard, phone, accessible) so that staff can filter by need. | MUST |
| US-R3 | As an admin, I edit a room's details. | MUST |
| US-R4 | As an admin, I deactivate a room so that it stops accepting new bookings without deleting its history. | MUST |
| US-R5 | As an admin, I set per-room bookable hours that override the organization default. | SHOULD |
| US-R6 | As an admin, I set per-room limits: minimum and maximum booking duration, and how far ahead it may be booked. | SHOULD |
| US-R7 | As an admin, I create a closure (maintenance window) on a room so that nobody can book it during that period. | SHOULD |
| US-R8 | As an admin, I upload a photo of the room so staff can recognize it. | COULD |
| US-R9 | As an admin, I manage locations/buildings, each with its own address and timezone. | SHOULD |

### 2.3 Booking (employee)

| ID | Story | Priority |
|----|-------|----------|
| US-B1 | As an employee, I see a day view of all rooms with their busy and free slots so that I can pick a room at a glance. | MUST |
| US-B2 | As an employee, I search for free rooms by date, time range, required capacity and required features. | MUST |
| US-B3 | As an employee, I book a free room by giving a title, start time and end time. | MUST |
| US-B4 | As an employee, I receive an immediate confirmation email with the room, time and a calendar attachment. | MUST |
| US-B5 | As an employee, I see a list of my upcoming and past bookings. | MUST |
| US-B6 | As an employee, I edit my own future booking (title, time, room) and everyone affected is notified. | MUST |
| US-B7 | As an employee, I cancel my own future booking, and the room is immediately released. | MUST |
| US-B8 | As an employee, I add attendees by picking colleagues or typing external email addresses, and they get an invitation. | SHOULD |
| US-B9 | As an employee, I am told clearly and immediately when my chosen slot is already taken, and I am offered the nearest alternatives. | SHOULD |
| US-B10 | As an employee, I add a description and a meeting agenda to the booking. | COULD |
| US-B11 | As an employee, I mark a booking private so that other staff see only "Busy" instead of the title. | COULD |
| US-B12 | As an employee, I book a recurring meeting (daily, weekly, monthly) with an end date or an occurrence count. | MUST |
| US-B13 | As an employee, when some dates in my series are already taken, I am shown exactly which, and I choose to skip them or place them elsewhere — rather than the whole series failing. | MUST |
| US-B14 | As an employee, I edit or cancel a recurring meeting, choosing whether the change applies to this occurrence, this and all following, or the entire series. | MUST |
| US-B15 | As an employee, I receive **one** email about a series, not one per occurrence. | MUST |

### 2.4 Administration of bookings (admin)

| ID | Story | Priority |
|----|-------|----------|
| US-M1 | As an admin, I see every booking across all rooms for any date. | MUST |
| US-M2 | As an admin, I cancel any booking, with a required reason, and the organizer is emailed that reason. | MUST |
| US-M3 | As an admin, I move any booking to a different room, with a required reason, and everyone is emailed. | MUST |
| US-M4 | As an admin, I move any booking to a different time, with a required reason, and everyone is emailed. | MUST |
| US-M5 | As an admin, when I try to move a booking into an occupied slot, I am blocked and shown the conflicting booking. | MUST |
| US-M6 | As an admin, I see a per-booking history of every change: who, when, what, and why. | SHOULD |
| US-M7 | As an admin, I create a booking on behalf of another employee, who becomes the organizer. | SHOULD |
| US-M8 | As an admin, when I deactivate a room that has future bookings, I am shown them and asked to move or cancel them first. | SHOULD |
| US-M9 | As an admin, I override a room's booking-window rules (e.g. book further ahead than staff can). | COULD |
| US-M10 | As an admin, I move or cancel **a single occurrence** of a recurring meeting without disturbing the rest of the series. | MUST |
| US-M11 | As an admin deactivating a room, I resolve a 34-occurrence series as one grouped item rather than 34 separate rows. | MUST |

### 2.4b Multiple locations

| ID | Story | Priority |
|----|-------|----------|
| US-L1 | As an owner, I create and manage locations, each with its own address, timezone, country and working days. | MUST |
| US-L2 | As an employee, I switch between locations and see each one's current local time. | MUST |
| US-L3 | As an employee booking a room in another timezone, I see both the room's local time and my own. | MUST |
| US-L4 | As an owner, I appoint an admin for specific locations only, so the Addis office manager cannot alter London bookings. | MUST |
| US-L5 | As an owner, I set working days and hours per location, because our Dubai office works Sunday–Thursday. | MUST |
| US-L6 | As an admin, I see which settings are inherited from the organization and which this location overrides. | SHOULD |
| US-L7 | As an owner, I maintain a per-location holiday calendar so meetings are not booked into a closed building. | SHOULD |
| US-L8 | As an employee, I search for a room across all locations when I am travelling. | SHOULD |
| US-L9 | As a user, I set my home location so the app opens on the right site. | SHOULD |

### 2.4c Calendar integration

| ID | Story | Priority |
|----|-------|----------|
| US-C1 | As an employee, I connect my Google or Microsoft 365 calendar so my bookings appear there automatically. | MUST |
| US-C2 | As an attendee, I receive a native calendar invitation with working Accept and Decline buttons, rather than an attachment. | MUST |
| US-C3 | As an organizer, I see my attendees' RSVP responses on the booking. | MUST |
| US-C4 | As an organizer, when I move the event in my own calendar, the booking moves too — unless the room is taken, in which case I am told why it could not. | MUST |
| US-C5 | As a user who has not connected a calendar, everything still works via `.ics` attachments. | MUST |
| US-C6 | As a user, I never receive both an `.ics` attachment and a native invitation for the same meeting. | MUST |
| US-C7 | As a user, I disconnect my calendar at any time, and this revokes RoomBook's access at the provider. | MUST |
| US-C8 | As an admin, I map a room to our Google resource calendar or Outlook room mailbox so it shows as busy to people scheduling directly from Outlook. | SHOULD |
| US-C9 | As an admin, I see the health of calendar connections across the organization and who needs to reconnect. | SHOULD |

### 2.5 Notifications

| ID | Story | Priority |
|----|-------|----------|
| US-N1 | As an organizer, I receive an email confirming a new booking. | MUST |
| US-N2 | As an organizer, I receive an email when an admin moves my booking, showing old and new details side by side and the stated reason. | MUST |
| US-N3 | As an organizer, I receive an email when an admin cancels my booking, with the stated reason. | MUST |
| US-N4 | As an attendee, I receive an invitation when I am added, and an update when the booking changes or is cancelled. | SHOULD |
| US-N5 | As an organizer, I receive a reminder shortly before my meeting starts. | SHOULD |
| US-N6 | As an admin, I see the email log so that I can confirm a notification actually went out, and resend it if it failed. | SHOULD |
| US-N7 | As a user, every booking email carries an `.ics` attachment so the meeting lands in my own calendar. | SHOULD |
| US-N8 | As a user, I mute non-essential email (reminders) while still receiving cancellations and moves. | COULD |

### 2.6 Reporting

| ID | Story | Priority |
|----|-------|----------|
| US-P1 | As an admin, I see room utilization over a date range (hours booked ÷ hours bookable). | COULD |
| US-P2 | As an admin, I export bookings for a date range as CSV. | COULD |
| US-P3 | As an admin, I see which rooms are most often double-requested, to justify new rooms. | WON'T (v1) |

---

## 3. Functional requirements

### FR-1 Authentication
1. Login takes an email address and password. Email comparison is case-insensitive; passwords are not.
2. Passwords are hashed with Argon2id. Plaintext passwords are never written to disk or logs.
3. Minimum password length is 12 characters. The password is checked against a list of common passwords and rejected if it matches.
4. After 5 failed attempts for one email address within 15 minutes, further attempts for that address are rejected for 15 minutes. The error message does not reveal whether the account exists.
5. Sessions are stored server-side; the cookie holds only an opaque identifier.
6. Sessions expire after 12 hours of inactivity and after 30 days absolutely.
7. Logging in rotates the session identifier (prevents session fixation).
8. Invitation and password-reset tokens are single-use, expire in 72 hours and 1 hour respectively, and are stored hashed.

### FR-2 Room configuration
1. A room has: name (unique per location), location, capacity (≥ 1), floor, description, feature tags, active flag, display colour.
2. A room may override: bookable hours per weekday, minimum duration, maximum duration, maximum days in advance, minimum notice.
3. Deactivating a room hides it from search and blocks new bookings. Existing bookings are untouched, and the admin is warned about future ones (US-M8).
4. Rooms are never hard-deleted while bookings reference them.
5. Closures block booking for a time range and carry a reason shown in the UI.

### FR-3 Booking lifecycle
1. States: `PENDING_APPROVAL` → `CONFIRMED` → `ENDED_EARLY`, plus the terminal states `REJECTED` and `CANCELLED`. The first three occupy their time range; the last two free it. See [15-approvals.md](15-approvals.md) and BR-M2a.
2. Creating a booking requires: room, start, end, title. Description and attendees are optional.
3. Times are stored in UTC and rendered in the viewer's timezone.
4. Start must be strictly before end. Minimum granularity is 5 minutes; the UI offers 15-minute increments.
5. A booking may not overlap another non-cancelled booking in the same room, using half-open intervals.
6. A booking may not overlap a closure on that room.
7. A booking must fall inside the room's bookable hours and satisfy its duration and advance-window rules. Admins may be allowed to override (US-M9, COULD).
8. A booking may not start in the past. Tolerance: a booking may start up to 5 minutes before "now" to allow for an in-progress booking being created.
9. Cancelling sets status `CANCELLED`, records who and why, and immediately frees the slot. Rows are retained for audit; they are not deleted.
10. Past bookings cannot be edited or cancelled (subject to D3).
11. Every mutation writes a row to the booking audit table.

### FR-4 Conflict handling
1. Overlap is checked inside the same database transaction that writes the booking, not before it, so two simultaneous requests cannot both succeed.
2. The database enforces non-overlap independently of the application code: a `GIST` exclusion constraint on PostgreSQL, and a serialized transaction plus a verification re-check on SQLite. See [03-data-model.md](03-data-model.md#6-concurrency-and-the-overlap-constraint).
3. A conflict returns HTTP 409 with the conflicting booking's time range and, if the viewer may see it, its title and organizer.
4. On conflict the UI offers: the same room at the nearest free time, or a different free room at the requested time.

### FR-5 Notifications
1. Email is written to an `email_outbox` row in the same transaction as the booking change. If the transaction rolls back, no email is queued — there are no emails about bookings that do not exist.
2. A background worker sends queued mail, retrying with exponential backoff up to 5 attempts.
3. Every transactional email is also rendered as plain text, not HTML only.
4. Booking emails carry an `.ics` attachment with the correct `METHOD` (`REQUEST` for new and updated, `CANCEL` for cancelled) and a stable `UID` so calendar clients update rather than duplicate.
5. Admin-initiated changes include the admin's name and the stated reason.
6. Full trigger table and templates: [06-email-notifications.md](06-email-notifications.md).

### FR-6 Audit
1. Recorded events: `BOOKING_CREATED`, `BOOKING_UPDATED`, `BOOKING_MOVED`, `BOOKING_CANCELLED`, `ROOM_CREATED`, `ROOM_UPDATED`, `ROOM_DEACTIVATED`, `USER_INVITED`, `USER_ROLE_CHANGED`, `USER_DEACTIVATED`, `LOGIN_SUCCEEDED`, `LOGIN_FAILED`.
2. Each row stores: actor, timestamp (UTC), event type, target entity, before/after snapshot as JSON, reason, and client IP.
3. Audit rows are append-only. No application code path updates or deletes them.

---

## 4. Non-functional requirements

| ID | Requirement | Target | How it is verified |
|----|-------------|--------|--------------------|
| NFR-1 | Page response time | p95 under 300 ms for calendar and list pages at 50 rooms × 90 days of data | Load test with seeded data |
| NFR-2 | Email latency | Queued email leaves the outbox within 60 s under normal operation | Worker metric, integration test |
| NFR-3 | Concurrency safety | 50 simultaneous booking attempts on one slot produce exactly 1 success and 49 clean 409s | Dedicated concurrency test (see [10-testing.md](10-testing.md)) |
| NFR-4 | Availability | Suitable for 99.5% office-hours availability on a single node; no HA requirement in v1 | Operational, not tested |
| NFR-5 | Accessibility | WCAG 2.1 AA: keyboard-operable calendar, visible focus, labelled form controls, 4.5:1 contrast, no colour-only meaning | axe-core in CI plus a manual keyboard pass |
| NFR-6 | Responsive | Usable from 360 px width upward; the day grid becomes a vertical list on narrow screens | Playwright viewport tests |
| NFR-7 | Browser support | Current and previous major version of Chrome, Edge, Firefox, Safari. No IE | Manual |
| NFR-8 | Security | Passes [08-security.md](08-security.md) checklist; dependencies clean on `npm audit --omit=dev` at high severity | CI |
| NFR-9 | Data durability | Nightly database backup with a documented, rehearsed restore | Runbook in [09-configuration.md](09-configuration.md) |
| NFR-10 | Observability | Structured JSON logs with request IDs; `/healthz` liveness and `/readyz` readiness endpoints | Manual check |
| NFR-11 | Timezone correctness | Correct across DST transitions in the configured timezone | Unit tests pinned to a spring-forward and an autumn-back date |
| NFR-12 | Maintainability | TypeScript strict mode, ESLint clean, no file over roughly 400 lines | CI |

---

## 5. Acceptance criteria for v1 sign-off

v1 is complete when all **MUST** stories pass their acceptance tests and:

1. An admin can set up a room from scratch and an employee can book it, in a fresh install, without touching the database.
2. Two users attempting the identical slot produce exactly one booking and one clear error.
3. An admin move produces an email to the organizer showing old room, new room and the reason, within 60 seconds.
4. An admin cancellation frees the slot immediately and emails the organizer the reason.
5. All times remain correct when the organization's timezone crosses a DST boundary.
6. The audit log shows a complete, readable history for a booking that was created, moved twice and then cancelled.
