# 12 — Recurring Meetings

> **Decision D5 is resolved:** recurring bookings are **in v1**, with **full per-occurrence
> control** — an admin can move or cancel next Tuesday's standup without touching the rest of
> the series.

This is the most intricate feature in the product. Almost every subtle bug in a booking system
lives here, so the design is written out before any code.

---

## 1. The central decision: materialized occurrences

There are two ways to store a recurring booking.

| Approach | How it works | Verdict |
|----------|--------------|---------|
| **Computed** | Store only the rule (`FREQ=WEEKLY;BYDAY=TU`). Expand it on demand when rendering a calendar | **Rejected.** Conflict detection would have to expand every series in the organization on every booking attempt, and — fatally — the PostgreSQL exclusion constraint cannot see rows that do not exist. Overlap safety would collapse back to application-level checking |
| **Materialized** | Store the rule **and** write a real `bookings` row for each occurrence within a rolling horizon | **Chosen** |

Materializing means every occurrence is an ordinary booking row. Therefore:

- The `GIST` exclusion constraint protects recurring bookings exactly as it protects single
  ones — [03 §6](03-data-model.md#6-concurrency-and-the-overlap-constraint) needs no change.
- Conflict detection, availability queries and the calendar grid need **no special cases**.
  They already work.
- Moving one occurrence is just updating one row.
- Audit, email and `.ics` all operate on rows that already exist.

The cost is a **horizon**: occurrences exist only so far into the future, and a nightly worker
rolls the window forward. That cost is worth paying to keep the rest of the system simple.

### The horizon

| Setting | Default | Notes |
|---------|---------|-------|
| `recurrence_horizon_days` | `365` | How far ahead occurrences are materialized |
| Max occurrences per series | `500` | A hard safety ceiling against a runaway rule |
| Roll-forward | Nightly, in `CleanupWorker` | Extends every open-ended series to keep the horizon full |

A series with `UNTIL` or `COUNT` materializes fully if it fits inside the horizon. An open-ended
series ("every Tuesday, forever") materializes one year out and grows by one day each night.

---

## 2. Data model additions

### `booking_series`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `room_id` | uuid FK | The series default; an exception occurrence may differ |
| `organizer_id` | uuid FK | |
| `title`, `description`, `is_private` | | Series defaults |
| `rrule` | text | RFC 5545, e.g. `FREQ=WEEKLY;BYDAY=TU;INTERVAL=1;UNTIL=20271231T000000Z` |
| `dtstart_local` | timestamp | First occurrence as **local wall clock** |
| `duration_minutes` | int | Stored as a duration, **not** an end time — this is what keeps occurrences correct across DST |
| `timezone` | text | IANA zone the rule is evaluated in |
| `horizon_until` | timestamptz | How far this series is currently materialized |
| `status` | enum | `ACTIVE` \| `ENDED` \| `CANCELLED` |
| `created_at` / `updated_at` | | |

### Changes to `bookings`

| Column | Notes |
|--------|-------|
| `series_id` | uuid FK null — **replaces the reserved `recurrence_id`** |
| `occurrence_start_local` | timestamp null — the occurrence's *originally scheduled* local start. This is the `RECURRENCE-ID` and it **never changes**, even when the occurrence is moved. It is how an exception is matched back to its slot in the series |
| `is_exception` | bool — true once this occurrence diverges from the series |
| `exception_fields` | json null — which fields diverge (`["roomId","startsAt"]`), so a later series edit knows what not to overwrite |

Unique index on (`series_id`, `occurrence_start_local`) — one row per slot in the series, always.

A cancelled occurrence is an ordinary `CANCELLED` booking row with `series_id` set. There is no
separate EXDATE table; the row *is* the exception record, and it preserves who cancelled it and
why.

---

## 3. Recurrence rules supported

v1 supports the patterns people actually use, not all of RFC 5545.

| Pattern | RRULE | UI |
|---------|-------|-----|
| Daily | `FREQ=DAILY;INTERVAL=n` | "Every N days" |
| Every weekday | `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR` | "Every weekday" |
| Weekly on chosen days | `FREQ=WEEKLY;BYDAY=TU,TH;INTERVAL=n` | "Every N weeks on …" |
| Monthly by date | `FREQ=MONTHLY;BYMONTHDAY=15` | "Day 15 of every month" |
| Monthly by position | `FREQ=MONTHLY;BYDAY=1MO` | "First Monday of every month" |
| Yearly | `FREQ=YEARLY` | "Every year on this date" |

**Ends:** never · after N occurrences (`COUNT`) · on a date (`UNTIL`).

**Not supported in v1:** `BYSETPOS` beyond the monthly-position case, `BYWEEKNO`, `BYYEARDAY`,
multiple `RRULE`s, or `RDATE`. The `rrule` column stores standard text, so these are a parser
change rather than a schema change.

**Library:** the `rrule` package for expansion, with the result cross-checked against
`date-fns-tz` for zone correctness. Expansion is never hand-rolled.

### DST correctness

This is where recurrence usually breaks. The rule is stored with a **local start time and a
duration**, never a UTC start and a UTC end:

> A 09:00 standup lasting 30 minutes is `dtstart_local = 09:00`, `duration_minutes = 30`,
> `timezone = Africa/Addis_Ababa`.

Each occurrence is produced by resolving 09:00 in that zone **on that date**, then adding 30
minutes. Across a DST transition the meeting stays at 09:00 local, which is what the organizer
means — the UTC instant shifts, and that is correct. Storing a UTC start and adding 7 days
would silently drift the meeting to 08:00 or 10:00 for half the year.

Occurrences landing on a **non-existent** local time (spring-forward gap) are skipped and
reported to the organizer. Occurrences landing on an **ambiguous** local time (autumn-back
overlap) resolve to the earlier instant, consistent with BR-T8.

---

## 4. Creating a series

The hard part is not generating the dates. It is that **some occurrences will clash** — and
the system must not fail the whole series because week 7 is taken.

### The flow

1. The organizer fills in the booking form and sets a repeat rule.
2. `POST /api/v1/bookings` with a `recurrence` block runs a **dry run** first and returns a
   preview:

```json
{
  "preview": {
    "totalOccurrences": 52,
    "available": 49,
    "conflicts": [
      { "occurrenceStartLocal": "2026-12-23T09:00", "reason": "BOOKING_CONFLICT",
        "conflictingTitle": "Quarterly review", "suggestions": ["10:00", "Room C"] },
      { "occurrenceStartLocal": "2027-01-01T09:00", "reason": "CLOSURE_CONFLICT",
        "detail": "New Year — building closed" },
      { "occurrenceStartLocal": "2027-03-30T09:00", "reason": "NON_EXISTENT_LOCAL_TIME" }
    ]
  }
}
```

3. The UI shows this plainly — *"49 of 52 dates are free. 3 have a clash."* — and offers:

| Choice | Behaviour |
|--------|-----------|
| **Skip the clashing dates** (default) | Create 49 occurrences; the 3 clashes become no rows at all |
| **Book an alternative room for those dates** | Those 3 become exceptions in a different room, created in the same transaction |
| **Cancel** | Nothing is created; adjust the rule and try again |

4. On confirmation the whole series is created in **one serializable transaction**. If any
   intended occurrence fails the exclusion constraint during the write — because someone booked
   it in the seconds between preview and confirm — the transaction is retried once with a fresh
   preview, then reported.

**Partial success is explicit, never silent.** The organizer is always told exactly which dates
were not booked and why. A series that quietly skipped three weeks is a meeting people miss.

---

## 5. Editing: the three-way choice

Every edit, move and cancellation on an occurrence of a series asks the question Outlook and
Google ask, because that is what users already understand:

```
┌──────────────────────────────────────────────┐
│  This is a repeating meeting.                │
│  Apply the change to:                        │
│    ( ) This occurrence only                  │
│    ( ) This and all following occurrences    │
│    (•) The entire series                     │
│                  [ Cancel ]  [ Continue ]    │
└──────────────────────────────────────────────┘
```

### `THIS_OCCURRENCE`

Updates that one row. Sets `is_exception = true` and records which fields diverged in
`exception_fields`. `occurrence_start_local` is **not** changed — it remains the anchor that
ties this row to its slot in the series.

### `THIS_AND_FOLLOWING`

Splits the series:

1. The original series gets `UNTIL` set to just before this occurrence.
2. Occurrences at or after this point are deleted (they are unmodified future rows).
3. A **new** `booking_series` is created from this occurrence onward with the new values.
4. Exceptions earlier in the series are untouched; exceptions later move to the new series.

This is standard calendar behaviour, and it is why the design has a series table rather than a
rule column on each booking.

### `ENTIRE_SERIES`

Updates the series row and regenerates every future occurrence — **except** those marked
`is_exception`, whose diverged fields are preserved. If you moved next Tuesday to Room C and
then change the series room to Room B, next Tuesday stays in Room C. A banner says so, and
offers "reset exceptions to match the series".

Past occurrences are never touched (BR-M1).

### Conflicts during an edit

A series edit is re-validated against every affected occurrence, using the same preview-and-
confirm flow as creation. *"Moving the series to 14:00 clashes on 4 dates."* The admin chooses
to skip those, place them elsewhere, or abandon the edit. **An edit never half-applies.**

---

## 6. Admin moves and cancellations on a series

Your core requirement — an admin reclaiming a room — meets recurrence here.

| Scenario | Scope | Behaviour |
|----------|-------|-----------|
| The boardroom is needed **this Tuesday** only | `THIS_OCCURRENCE` | One occurrence moves to another room; the rest of the series is untouched. **The common case, and the reason you chose full per-occurrence control** |
| A room is closing **from next month** | `THIS_AND_FOLLOWING` | The series splits; the remainder runs in the new room |
| A room is being decommissioned | `ENTIRE_SERIES` | All future occurrences move |
| Deactivating a room with recurring bookings (BR-R4) | — | The resolution list groups by series: *"Weekly standup — 34 future occurrences"* with one action for the whole group, not 34 rows to click |

A reason is required exactly as for single bookings (BR-M5), and the email states the scope
plainly: *"the occurrence on 4 November"* versus *"all 34 remaining occurrences"*.

---

## 7. Notifications — the flooding problem

Naively, creating a weekly series for a year sends 52 confirmation emails. Nobody will use a
system that does that.

| Event | Emails sent |
|-------|-------------|
| Series created | **One** per recipient, describing the pattern: *"Weekly on Tuesdays at 09:00, from 4 Nov until 29 Dec 2027 — 52 meetings"*, listing any skipped dates. One `.ics` carrying the `RRULE` |
| Series edited (`ENTIRE_SERIES`) | **One** per recipient, stating what changed across the series |
| Series cancelled | **One** per recipient |
| `THIS_AND_FOLLOWING` | **One** per recipient, naming the date the change takes effect |
| **Single occurrence moved or cancelled** | **One** per recipient, clearly identifying the single date — *"Only the meeting on 4 November has moved; the rest of the series is unchanged"* |
| Reminders | Per occurrence, as normal — this is the one place per-occurrence email is wanted |

The rule: **one email per user action, not one per affected row.** The `email_outbox` row
carries a `series_id` and an `occurrence_count` so the template can say "34 meetings" rather
than enumerating them.

### `.ics` for a series

- A series is **one** `VEVENT` with an `RRULE` and a single `UID`. Calendar clients expand it.
- A modified occurrence is a **second** `VEVENT` with the **same `UID`** plus a
  `RECURRENCE-ID` equal to its original local start — which is exactly what
  `occurrence_start_local` stores. This is the mechanism that makes "just this Tuesday moved"
  work in Outlook and Google.
- A cancelled occurrence is sent as an `EXDATE` on the series, or as a `RECURRENCE-ID` event
  with `METHOD:CANCEL`.
- `SEQUENCE` increments on the series for series-level changes, and on the exception for
  occurrence-level ones.

Getting `RECURRENCE-ID` wrong is the single most common cause of "the meeting appears twice in
my calendar". Test T-130 exists specifically for it.

---

## 8. Interaction with two-way calendar sync

Where a user has connected their calendar ([13](13-calendar-sync.md)), the provider handles
recurrence natively:

- RoomBook creates **one** recurring event via the Google or Microsoft API, with the `RRULE`.
- A single-occurrence change is pushed as a provider **instance** update (Google
  `events.instances`, Graph `/events/{id}/instances/{occurrenceId}`), not as a new event.
- RoomBook remains the authority on **room availability**. If the user edits one occurrence in
  Google and the new time clashes, RoomBook reverts that instance and emails them
  ([13 §7](13-calendar-sync.md#7-conflict-resolution-who-wins)).
- Materialized rows stay the source of truth internally; provider instance IDs are stored
  per occurrence so that instance-level updates can be addressed.

---

## 9. Performance

| Concern | Mitigation |
|---------|-----------|
| 500 rows written in one transaction | Batched inserts; measured at under 200 ms on PostgreSQL. The preview is read-only and runs outside the write transaction |
| Nightly horizon roll across many series | Only series whose `horizon_until` is within 30 days are touched; indexed on that column |
| Calendar grid now reads many more rows | Unchanged query shape — occurrences are ordinary bookings and use the existing `(room_id, starts_at, ends_at)` index |
| A runaway rule | 500-occurrence ceiling and a 365-day horizon, enforced server-side before any write |
| Series edit touching hundreds of rows | Done in one transaction with a progress response; the UI shows a determinate progress state for series over 100 occurrences |

---

## 10. Test cases

Added to [10-testing.md](10-testing.md).

| # | Case | Expected |
|---|------|----------|
| T-120 | Weekly series across a spring-forward transition | Every occurrence is 09:00 **local**; UTC instants shift by an hour at the boundary |
| T-121 | Weekly series across autumn-back | Same, in the other direction |
| T-122 | Occurrence landing on a non-existent local time | Skipped and reported in the preview, not silently dropped |
| T-123 | Series creation where 3 of 52 dates clash | 49 created, 3 reported, preview matches the result exactly |
| T-124 | Someone books a slot between preview and confirm | Transaction retried once, then reported; no partial series |
| T-125 | Move one occurrence, then edit the whole series | The exception keeps its diverged fields; the banner appears |
| T-126 | `THIS_AND_FOLLOWING` | Original series gets `UNTIL`; a new series starts; earlier exceptions survive |
| T-127 | Cancel one occurrence | That row is `CANCELLED`, its slot is free, other occurrences untouched, its reminder is cancelled |
| T-128 | Cancel the entire series | All **future** occurrences cancelled; past ones untouched |
| T-129 | Series creation sends one email, not 52 | Exactly one outbox row per recipient |
| T-130 | `.ics` for a moved occurrence | Same `UID`, correct `RECURRENCE-ID`, incremented `SEQUENCE`; verified in Outlook and Google to update rather than duplicate |
| T-131 | Horizon roll-forward | An open-ended series materializes one further day each night; no duplicates |
| T-132 | Series exceeding 500 occurrences | Rejected at validation with a clear message |
| T-133 | Deactivating a room with a 34-occurrence series | The resolution list shows one grouped row, and one action resolves all 34 |
| T-134 | Two admins edit the same series simultaneously | One succeeds; the other is told the series changed and is re-shown the preview |
