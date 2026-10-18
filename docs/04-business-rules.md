# 04 — Business Rules

The authoritative statement of how the system behaves. Where this document and the code
disagree, this document is the bug report. Every rule has an ID used by tests.

---

## 1. Time representation

| ID | Rule |
|----|------|
| BR-T1 | All instants are stored and compared in UTC. |
| BR-T2 | A time range is **half-open**: `[start, end)`. 09:00–10:00 and 10:00–11:00 do not conflict. |
| BR-T3 | `start` must be strictly before `end`. Zero-length and negative ranges are rejected. |
| BR-T4 | Times entered by a user are interpreted in the **room's location timezone**, not the browser's and not the server's. |
| BR-T5 | Times shown to a user are rendered in their profile timezone if set, otherwise the room's location timezone, and always labelled with the zone. |
| BR-T6 | Bookable-hours rules are stored as local wall-clock times and resolved per date, so 08:00–18:00 stays 08:00–18:00 across a DST change. |
| BR-T7 | Booking start and end must fall on a multiple of `slot_granularity_minutes` (default 15) measured from midnight local. |
| BR-T8 | Where a DST transition makes a local time ambiguous (clocks going back) the **earlier** instant is used; where it is non-existent (clocks going forward) the request is rejected with a clear message. |

---

## 2. Booking validity

Checked in this order. The first failure is returned; the UI shows one clear message rather
than a wall of errors.

> **Note on statuses.** With D3 and D4 resolved, `BookingStatus` is now
> `PENDING_APPROVAL` · `CONFIRMED` · `ENDED_EARLY` · `REJECTED` · `CANCELLED`.
> The first three **occupy** their time range and participate in conflict detection; the last
> two free it. The exclusion-constraint predicate is
> `status IN ('PENDING_APPROVAL','CONFIRMED','ENDED_EARLY')`
> — see [15 §4](15-approvals.md#4-lifecycle).

| ID | Rule | Failure |
|----|------|---------|
| BR-V1 | The room exists, belongs to the caller's organization, and `is_active` is true | 404 / 422 |
| BR-V2 | `start < end` | 422 |
| BR-V3 | Duration ≥ the effective minimum (room override, else org setting) | 422 |
| BR-V4 | Duration ≤ the effective maximum | 422 |
| BR-V5 | `start` is not in the past, with 5 minutes of tolerance | 422 |
| BR-V6 | `start` is no further ahead than the effective `max_advance_days` | 422 |
| BR-V7 | `start` is at least `min_notice_minutes` from now | 422 |
| BR-V8 | The whole range falls inside the room's bookable hours for every day it touches | 422 |
| BR-V9 | The range does not overlap any closure on that room | 409 |
| BR-V10 | The range does not overlap any non-cancelled booking in that room | 409 |
| BR-V11 | Title is 1–200 characters after trimming | 422 |
| BR-V12 | Attendee emails are syntactically valid; external addresses are rejected if `allow_external_attendees` is false | 422 |
| BR-V13 | Attendee count ≤ 100 | 422 |

**Effective value resolution** for every limit: room override → organization setting → built-in
default. A room column of `NULL` means inherit; `0` means an explicit zero, not inherit.

### Overnight and multi-day bookings
BR-V8 implies that a booking cannot cross a gap in bookable hours. A room bookable 08:00–18:00
cannot be booked 17:00–09:00 the next day. Rooms intended for overnight use are configured with
24-hour bookable windows. Multi-day bookings are permitted when the room allows it and all
intervening hours are bookable.

---

## 3. Conflict detection

**The test.** Two ranges overlap when `a.start < b.end AND b.start < a.end`. Strict
inequalities are what make touching bookings legal (BR-T2).

**Scope.** A booking conflicts only with rows in the **same room** whose status is not
`CANCELLED`, and with closures on that room. Bookings for the same organizer in different rooms
at the same time do **not** conflict — a person may double-book themselves, and that is their
business. The UI shows a non-blocking warning.

| ID | Rule |
|----|------|
| BR-C1 | The overlap check and the write happen in one serializable transaction (never check-then-write across transactions). |
| BR-C2 | On PostgreSQL a `GIST` exclusion constraint is the final authority; a violation is caught and returned as the same 409. |
| BR-C3 | A 409 response includes the conflicting range, and the conflicting title and organizer **only if** the viewer is allowed to see them (see BR-P3). |
| BR-C4 | On conflict the UI offers alternatives: the same room at the nearest free slots before and after, and up to 5 other rooms free at the requested time that meet the capacity and feature filters. |
| BR-C5 | When a booking is being edited, it is excluded from its own conflict check. |

---

## 4. Booking modification

### Who may modify

| Actor | Own future booking | Own **in-progress** booking | Another user's future booking | Another user's in-progress booking | Any **ended** booking |
|-------|--------------------|------------------------------|-------------------------------|-------------------------------------|------------------------|
| Employee | Edit, cancel | **End early** (D3) | No | No | No |
| Admin | Edit, cancel, move | End early | Edit, cancel, move (**reason required**) | End early (**reason required**) | No |
| Owner | Same as admin | Same as admin | Same as admin | Same as admin | No |

### Why "ended early" rather than "cancelled"

You asked that people be able to cancel their own meeting once it has started. Recording that
as `CANCELLED` would be a small lie: the room **was** used for twenty minutes, and erasing that
makes utilization reporting claim the room sat empty. Truncating instead keeps the record
honest, frees the remainder of the slot for someone else straight away, and still gives the
user the one-click "I'm done, release the room" action they wanted. The button simply says
**"End now and release the room"**.

| ID | Rule |
|----|------|
| BR-M1 | A booking that has already **ended** can never be modified or cancelled by anyone, including an owner. |
| BR-M2 | **(D3, revised)** A booking that is **in progress** — started but not ended — may be ended early by its **organizer** or by an admin. |
| BR-M2a | Ending an in-progress booking **truncates it; it does not erase it.** `ends_at` is set to now, status becomes `ENDED_EARLY`, and the remainder of the slot is released immediately. |
| BR-M2b | An `ENDED_EARLY` booking still **occupies** the time it actually used, so it continues to count toward utilization and still blocks overlapping bookings in that truncated range. |
| BR-M2c | An in-progress booking may not be moved, nor have its start time changed. Only its end may be brought forward. |
| BR-M3 | A **move** preserves the booking ID, organizer, attendees and `ics_uid`, and increments `ics_sequence`. It is not a cancel-and-recreate; the organizer's calendar entry updates in place. |
| BR-M4 | A move is validated against the full rule set in section 2 for the **target** room and time. |
| BR-M5 | An admin move or cancellation **requires a non-empty reason** of 3–500 characters. The reason is quoted verbatim in the email and stored in the audit row. |
| BR-M6 | An organizer editing their own booking is not required to give a reason. |
| BR-M7 | Changing only the title or description does not change `ics_sequence` enough to disturb calendars, but still notifies attendees unless "do not notify" is ticked. |
| BR-M8 | Cancellation is a status change, never a row deletion. The slot is free the instant the transaction commits. |
| BR-M9 | Cancelling a booking sets any queued, unsent reminder for it to `CANCELLED`. |
| BR-M10 | Transferring organizership (admin reassigning a booking to another employee) notifies both the old and new organizer. |

### What counts as which event

| Change | Event type | Email sent |
|--------|-----------|------------|
| Room changed | `BOOKING_MOVED` | `booking_moved` |
| Time changed | `BOOKING_MOVED` | `booking_moved` |
| Room **and** time changed | `BOOKING_MOVED` | `booking_moved`, one email covering both |
| Title / description / attendees changed | `BOOKING_UPDATED` | `booking_updated` |
| Status → `CANCELLED` | `BOOKING_CANCELLED` | `booking_cancelled` |

---

## 5. Room configuration rules

| ID | Rule |
|----|------|
| BR-R1 | Room name is unique within its location, compared case-insensitively after trimming. |
| BR-R2 | Capacity is an integer ≥ 1. |
| BR-R3 | A room is never hard-deleted while any booking references it. The UI offers "Deactivate" and does not offer "Delete". |
| BR-R4 | Deactivating a room with future bookings requires the admin to first move or cancel each one; the screen lists them with inline actions (US-M8). |
| BR-R5 | Editing a room's bookable hours does **not** retroactively invalidate existing bookings that now fall outside them. Existing bookings stand; the admin is shown a list of the affected ones and may move or cancel them. |
| BR-R6 | Reducing capacity does not invalidate existing bookings. |
| BR-R7 | A closure may not be created over an existing booking without the admin resolving those bookings first, by the same flow as BR-R4. |
| BR-R8 | A closure must have `start < end` and may be created in the past only by an owner (for record-keeping). |

---

## 6. User and access rules

| ID | Rule |
|----|------|
| BR-U1 | Email is unique per organization, compared lower-cased. |
| BR-U2 | A new user starts as `INVITED` with no password hash, and becomes `ACTIVE` when they accept the invitation and set a password. |
| BR-U3 | An invitation can be resent, which invalidates the previous token. |
| BR-U4 | A `DISABLED` user cannot log in; their existing sessions are destroyed immediately on deactivation. |
| BR-U5 | Deactivating a user with future bookings warns the admin and offers to reassign or cancel them. |
| BR-U6 | Only an `OWNER` may change roles, and the last remaining `OWNER` cannot be demoted or deactivated. |
| BR-U7 | A user cannot change their own role. |
| BR-U8 | Changing an email address requires confirmation at the new address before it takes effect. |

---

## 7. Privacy rules

| ID | Rule |
|----|------|
| BR-P1 | Free/busy information for every room is visible to every authenticated user. This is the point of the system. |
| BR-P2 | Booking title and organizer are visible to all authenticated users by default. |
| BR-P3 | For a booking marked `is_private`, non-admin users who are neither organizer nor attendee see only "Busy" and the time range. Admins always see full details, because they need them to move the booking. |
| BR-P4 | Nothing is visible to unauthenticated visitors. There is no public calendar. |
| BR-P5 | Attendee email addresses are visible to the organizer, other attendees, and admins — not to unrelated staff. |

---

## 8. Notification rules

Full specification in [06-email-notifications.md](06-email-notifications.md). The governing rules:

| ID | Rule |
|----|------|
| BR-N1 | Email rows are written in the same transaction as the change. A rolled-back booking sends nothing. |
| BR-N2 | One outbox row per recipient. No shared BCC, so a single bad address cannot block everyone else. |
| BR-N3 | The actor is never emailed about their own action — except the organizer, who always receives their own confirmation as a receipt. |
| BR-N4 | Admin-initiated changes always email the organizer, even if the admin is also the organizer. |
| BR-N5 | Attendees are notified subject to `notify_attendees` and the per-edit "do not notify" checkbox (D6). |
| BR-N6 | Reminders are suppressed for cancelled bookings and for users who opted out (BR-M9, US-N8). |
| BR-N7 | A reminder whose send time has already passed when it is picked up (because the system was down) is dropped, not sent late. A reminder arriving after the meeting started is worse than none. |
| BR-N8 | Cancellation and move emails are never suppressed by any opt-out. They are operationally essential. |

---

## 8b. Rules defined elsewhere

Three feature areas carry their own rule sets. They are specified in full in their own
documents rather than duplicated here, but they are part of the same authoritative set:

| Area | Rules | Spec |
|------|-------|------|
| Recurring meetings — materialization, edit scopes, exception preservation, partial creation | — | [12-recurrence.md](12-recurrence.md) |
| Calendar sync — who wins when a change arrives from the provider | — | [13 §7](13-calendar-sync.md#7-conflict-resolution-who-wins) |
| Multiple locations — scoped admin authority and settings inheritance | BR-L1…BR-L7 | [14 §3](14-multi-location.md#3-permissions-across-locations) |

Two principles govern the interactions between them:

> **An occurrence of a series is an ordinary booking row.** Every rule in sections 1–8 applies
> to it unchanged. Recurrence adds rules about *which rows exist*; it changes nothing about how
> an individual booking behaves.

> **RoomBook is the authority on room availability; the provider is the authority on people.**
> No calendar-side edit can create an overlapping booking. A user can lose a change they made
> in Google, but they can never cause a double-booked room — and they are always told why.

## 9. Worked examples

**Back-to-back bookings.** Alice books Room A 09:00–10:00. Bob books Room A 10:00–11:00.
Both succeed: `09:00 < 11:00` is true but `10:00 < 10:00` is false, so BR-T2 means no overlap.

**Simultaneous requests.** Alice and Bob both submit Room A 14:00–15:00 within the same
millisecond. Both transactions begin; one commits, the other hits the exclusion constraint
(BR-C2) and receives a 409 listing Alice's booking and offering 13:00–14:00, 15:00–16:00, and
Rooms B and C at 14:00.

**Admin move.** The CEO needs the boardroom at 14:00, where Bob has a booking. The admin opens
Bob's booking, clicks Move, picks Room C — free at that time — and types the reason "Boardroom
required for the quarterly review". The booking keeps its ID; `ics_sequence` goes 0 → 1; an
audit row records before `{room: Boardroom}` and after `{room: Room C}` with the reason; Bob and
his three attendees each receive a `booking_moved` email showing both rooms and the reason, with
an updated `.ics` that replaces the entry in their calendars rather than adding a second one.

**Cancellation frees the slot.** The admin cancels a 14:00–15:00 booking at 13:50. The status
becomes `CANCELLED` and the commit is immediate, so another user can book 14:00–15:00 a second
later. The queued reminder for the cancelled booking flips to `CANCELLED` and never sends.

**DST.** The organization is in a zone that moves clocks forward at 02:00 on a Sunday. A room is
bookable 08:00–18:00 daily. Bookable hours on that Sunday still run 08:00–18:00 local, which is
one hour shorter in UTC. A user attempting to book 02:30 on that date — a time that does not
exist — gets a clear rejection under BR-T8.
