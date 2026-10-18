# 15 — Approval Workflow

> **Decision D4 is resolved:** rooms may be marked as requiring approval. A booking for such a
> room is **held** until an admin approves or rejects it.

The `rooms.requires_approval` column and the `PENDING_APPROVAL` booking status were already
reserved in the v1.0 schema, so this is an activation rather than a migration of existing data.

---

## 1. The problem it solves

Some rooms are not first-come-first-served. The boardroom, the auditorium, the room with the
expensive video wall — these need someone to decide whether a given meeting justifies them.
Without approval, the only tool an admin has is to let the booking happen and then move it,
which is worse for everyone.

---

## 2. The central question: does a pending request hold the slot?

This is the decision that defines the whole feature, and both answers are defensible.

| Option | Behaviour | Problem |
|--------|-----------|---------|
| **Pending does not hold the slot** | Others can book over it; approval fails if someone else got there first | Users submit a request, wait a day, and lose the room anyway. Infuriating |
| **Pending holds the slot** | The slot is reserved while awaiting a decision | A forgotten request blocks a valuable room indefinitely |

**Chosen: pending holds the slot, with a deadline.**

A `PENDING_APPROVAL` booking occupies the room exactly as a confirmed one does — it is included
in the exclusion constraint, so nobody can book over it. To stop forgotten requests from
sterilizing the best room in the building, every request carries an **expiry**:

| Rule | Value |
|------|-------|
| Default decision window | **24 hours** from submission |
| For bookings starting sooner than that | Expires 2 hours before the booking starts |
| On expiry | Auto-rejected, slot released, requester emailed: *"nobody responded in time"* |
| Reminder to approvers | At 50% of the window, and again at 2 hours remaining |

This is the only design in which both the requester and the room are treated fairly.

---

## 3. Who approves

| Setting | Behaviour |
|---------|-----------|
| Default | **Any admin for that room's location** ([14 §3](14-multi-location.md#3-permissions-across-locations)) |
| `rooms.approver_user_id` (optional) | A named approver for that specific room — the person who actually owns the boardroom. Location admins remain able to act as a backstop, so a holiday never blocks every request |

An `OWNER` can always approve. A requester **cannot approve their own request**, even if they
are an admin — the whole point is a second pair of eyes (BR-A7).

---

## 4. Lifecycle

```
                   ┌──────────────────┐
  book a room ────▶│ PENDING_APPROVAL │ (slot held, exclusion constraint applies)
  that needs       └────────┬─────────┘
  approval                  │
              ┌─────────────┼──────────────┬──────────────────┐
              ▼             ▼              ▼                  ▼
        ┌───────────┐ ┌───────────┐ ┌────────────┐   ┌───────────────┐
        │ CONFIRMED │ │ REJECTED  │ │ CANCELLED  │   │ EXPIRED       │
        │ approved  │ │ by admin, │ │ withdrawn  │   │ nobody acted  │
        │           │ │ w/ reason │ │ by  user   │   │ in time       │
        └───────────┘ └───────────┘ └────────────┘   └───────────────┘
               │            └──────────────┴─────────────────┘
               │                           │
          slot kept                   slot released
```

`BookingStatus` becomes: `PENDING_APPROVAL` · `CONFIRMED` · `REJECTED` · `CANCELLED` ·
`ENDED_EARLY`.

The exclusion constraint predicate changes from `status <> 'CANCELLED'` to:

```sql
WHERE status IN ('PENDING_APPROVAL', 'CONFIRMED', 'ENDED_EARLY')
```

Both `REJECTED` and `CANCELLED` free the slot; both are retained for audit.

---

## 5. Rules

| ID | Rule |
|----|------|
| BR-A1 | A booking for a room with `requires_approval` is created as `PENDING_APPROVAL`, never `CONFIRMED` |
| BR-A2 | A pending booking **holds the slot** and participates in conflict detection identically to a confirmed one |
| BR-A3 | Every pending booking has an `approval_expires_at`; a worker auto-rejects it on expiry and frees the slot |
| BR-A4 | Approval requires no reason. **Rejection requires a reason** of 3–500 characters, quoted verbatim to the requester |
| BR-A5 | A requester may withdraw their own pending request at any time, with no reason needed |
| BR-A6 | A requester may **not** edit a pending request. They withdraw and resubmit — this prevents a request being approved and then silently changed |
| BR-A7 | **A user cannot approve their own request**, whatever their role |
| BR-A8 | An **admin booking the room directly is auto-approved** — they already hold the authority, and making them approve themselves is theatre |
| BR-A9 | Approving re-validates the booking. If anything changed — the room was deactivated, a closure was added — approval fails with a clear reason rather than confirming an invalid booking |
| BR-A10 | Turning on `requires_approval` for a room does **not** retroactively un-confirm existing bookings |
| BR-A11 | Turning it off auto-approves anything currently pending for that room, and tells the requesters |
| BR-A12 | **A recurring series is approved as a whole, not per occurrence.** Approving admits every occurrence; rejecting admits none ([12](12-recurrence.md)) |
| BR-A13 | Calendar sync is deferred until approval: no provider event is created for a pending booking, because a tentative entry that may vanish is worse than none ([13](13-calendar-sync.md)) |
| BR-A14 | An admin may approve **and move in one action** — "approve, but in Room C" — which is the common real-world outcome |

BR-A12 and BR-A14 are the two that will matter most in daily use.

---

## 6. Data model

### `bookings` additions

| Column | Notes |
|--------|-------|
| `approval_status` | Derived from `status`; kept separate for query clarity |
| `approval_expires_at` | timestamptz null — when an unanswered request auto-rejects |
| `approved_by` / `approved_at` | |
| `rejected_by` / `rejected_at` / `rejection_reason` | |
| `approval_note` | Optional note from the requester: *"needed for the board — 12 external guests"* |

### `rooms` additions

| Column | Notes |
|--------|-------|
| `requires_approval` | **Now active**, previously reserved |
| `approver_user_id` | Optional named approver (section 3) |
| `approval_window_hours` | Default 24; per-room override |

### Index

`(organization_id, status, approval_expires_at)` where `status = 'PENDING_APPROVAL'` — serves
both the approval queue and the expiry worker.

---

## 7. Notifications

Note that D6 limits RoomBook email to organizers — **approval email is the deliberate
exception**, because an approver who is not told has nothing to act on.

| Event | Template | To |
|-------|----------|-----|
| Request submitted | `approval_requested` | The room's approver, or all admins for that location |
| Reminder at 50% of the window | `approval_reminder` | Same |
| Approved | `booking_approved` | Requester |
| Approved with a move | `booking_approved_moved` | Requester — shows the room they asked for and the room they got |
| Rejected | `booking_rejected` | Requester, with the reason quoted |
| Expired | `approval_expired` | Requester, and the approvers who did not act |
| Withdrawn | `approval_withdrawn` | Approvers |

`approval_requested` contains the decision inline — **Approve** and **Reject** buttons that are
signed, single-use links. An approver should not have to log in to say yes to a meeting room.
The links expire with the request and are consumed on first use.

---

## 8. User interface

### S-29 — Approval queue (`/admin/approvals`)

The admin's working screen, sorted by urgency rather than by submission order.

```
┌─────────────────────────────────────────────────────────────────┐
│  Pending approvals (3)                    Location: All ▾       │
├─────────────────────────────────────────────────────────────────┤
│  ⏰ expires in 1h 20m                                            │
│  Boardroom · Tue 4 Nov, 09:00–11:00 · Alice Bekele              │
│  "Board meeting — 12 external guests"                           │
│                    [ Approve ] [ Approve in another room ▾ ]    │
│                    [ Reject… ]                                  │
├─────────────────────────────────────────────────────────────────┤
│  expires in 18h                                                 │
│  Auditorium · Fri 7 Nov, 14:00–17:00 · Bob Tesfaye              │
│  "All-hands rehearsal"              [ Approve ] [ Reject… ]     │
└─────────────────────────────────────────────────────────────────┘
```

Expiring-soon requests rise to the top and are marked with a word, not only a colour (NFR-5).
A badge on the Admin menu shows the pending count.

### Elsewhere

- **Booking form:** choosing an approval-required room swaps the submit button to **"Request
  room"** and shows *"This room needs approval. You will hear back within 24 hours."*
  Setting expectations before submission avoids most of the support questions.
- **Booking detail:** a clear `PENDING APPROVAL` banner with the expiry countdown, who it is
  with, and a **Withdraw request** button.
- **Calendar grid:** pending blocks are hatched and labelled "Pending", so everyone can see the
  slot is held but not yet settled.
- **My bookings:** a "Awaiting approval" group at the top.
- **Room editor:** the approval toggle, named approver and window length.

---

## 9. Test cases

| # | Case | Expected |
|---|------|----------|
| T-180 | Book an approval-required room | Created `PENDING_APPROVAL`, not confirmed |
| T-181 | Second user books the same slot while the first is pending | **409 — the pending request holds the slot** (BR-A2) |
| T-182 | Approve | Status `CONFIRMED`, requester emailed, calendar sync fires only now (BR-A13) |
| T-183 | Reject with no reason | 422 (BR-A4) |
| T-184 | Reject with a reason | Slot freed immediately, requester emailed the reason verbatim |
| T-185 | Nobody acts within the window | Auto-rejected, slot freed, both parties emailed (BR-A3) |
| T-186 | Booking starts in 3 hours | Expiry is 2 hours before start, not 24 hours out |
| T-187 | Requester approves their own request | 403 even as an admin (BR-A7) |
| T-188 | Admin books the room directly | Auto-confirmed, no approval step (BR-A8) |
| T-189 | Requester edits a pending request | Blocked; withdraw and resubmit (BR-A6) |
| T-190 | Room deactivated while a request is pending | Approval fails with a clear reason (BR-A9) |
| T-191 | `requires_approval` turned off with requests pending | All auto-approved, requesters told (BR-A11) |
| T-192 | Recurring series on an approval room | One approval covers the whole series (BR-A12) |
| T-193 | Approve-and-move | Booking confirmed in the new room; the email shows requested vs granted (BR-A14) |
| T-194 | Approve link in email used twice | Second use rejected — single-use token |
| T-195 | Approve link used after expiry | Rejected with an explanation |
| T-196 | Location admin sees the approval queue | Only requests for their locations (BR-L1) |

---

## 10. Cost and caution

**~3–4 days**, and it touches more of the system than its size suggests: the booking status
enum, the exclusion-constraint predicate, conflict detection, the calendar grid, email, the
sync trigger point, and the recurrence flow.

Two things worth saying plainly:

1. **Only mark rooms that genuinely need it.** Every approval-required room converts an instant
   action into a wait. If half the rooms need approval, people will stop using the system and
   go back to asking in the corridor. One or two rooms is the healthy number.
2. **An unstaffed approval queue is worse than no approval.** The expiry rule in section 2
   prevents the worst outcome, but if requests routinely expire, the right fix is to remove the
   approval requirement, not to shorten the window. The admin dashboard surfaces the expiry
   rate for exactly this reason.
