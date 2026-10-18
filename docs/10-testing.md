# 10 — Testing Strategy

## 1. Shape of the suite

| Layer | Tool | Count (target) | Speed | Covers |
|-------|------|----------------|-------|--------|
| Unit — shared | Vitest | ~60 | < 2 s | `shared/`: overlap maths, timezone and DST helpers, permission matrix, Zod schemas. **Runs once and protects both sides** |
| Unit — server | Vitest | ~90 | < 5 s | Rule evaluation, `.ics` building, email rendering |
| Integration | Vitest + Supertest + SQLite | ~80 | < 30 s | Every endpoint through real HTTP against a real database, including transactions and the outbox |
| Concurrency | Vitest, PostgreSQL in Docker | ~6 | < 20 s | The exclusion constraint under genuine parallel load |
| Component | Vitest + React Testing Library + MSW | ~40 | < 20 s | Forms, dialogs, conflict rendering, `CalendarGrid` keyboard behaviour |
| End-to-end | Playwright | ~15 | < 3 min | The journeys a person actually performs |
| Accessibility | axe-core in Playwright | every page | included | WCAG 2.1 AA violations |

Deliberately weighted toward unit and integration. The booking rules are where the bugs live,
and they are cheapest to test there.

**The monolith pays off here.** Because the Zod schemas and the permission matrix live in
`shared/` and are imported by both sides, their tests are written once and apply to client
validation and server enforcement simultaneously. There is no second set of "does the frontend
agree with the backend" contract tests to maintain, because there is no second definition.

## 2. What gets tested where

**Unit** — pure functions, no database:
`domain/overlap.ts`, `domain/time.ts`, `domain/permissions.ts`, effective-limit resolution,
`.ics` escaping, email subject and body rendering.

**Integration** — a fresh SQLite file per test file, migrations applied, a transaction rolled
back per test:
every endpoint in [05](05-api-spec.md), including the authorization matrix, the outbox rows a
mutation produces, and the audit rows it writes.

**Concurrency** — PostgreSQL only, because this is specifically about the constraint SQLite
does not have.

**Component** — React Testing Library with MSW intercepting `/api/v1/*`, so components are
tested against realistic responses without a server. Queries are by accessible role and name
(`getByRole('button', { name: 'Move booking' })`), never by test ID or class — a test that
cannot find a control by its accessible name is telling you a screen-reader user cannot either.

**E2E** — real browser, real built app, real server, `CapturingMailer`:
the journeys in section 5.

## 3. Critical test cases

These must all exist and pass. Each cites the rule it protects.

### Overlap and conflict
| # | Case | Expected |
|---|------|----------|
| T-01 | Back-to-back 09:00–10:00 and 10:00–11:00 | Both succeed (BR-T2) |
| T-02 | Exact duplicate range | Second gets 409 (BR-V10) |
| T-03 | New booking fully contains an existing one | 409 |
| T-04 | New booking entirely inside an existing one | 409 |
| T-05 | New booking overlaps only the start, or only the end | 409 in both directions |
| T-06 | Same time, different room | Both succeed |
| T-07 | Overlaps a **cancelled** booking | Succeeds — cancellation frees the slot (BR-M8) |
| T-08 | Overlaps a closure | 409 `CLOSURE_CONFLICT` (BR-V9) |
| T-09 | Editing a booking does not conflict with itself | Succeeds (BR-C5) |
| T-10 | Zero-length booking | 422 (BR-T3) |
| T-11 | End before start | 422 (BR-T3) |

### Concurrency (PostgreSQL)
| # | Case | Expected |
|---|------|----------|
| T-20 | 50 parallel `POST /bookings` for one identical slot | Exactly 1 × 201, 49 × 409; exactly one row in the database (NFR-3) |
| T-21 | Parallel create and admin move into the same slot | Exactly one wins; the loser gets a clean 409, never a 500 |
| T-22 | Transaction rolled back by a conflict | **No outbox rows and no audit rows are left behind** (BR-N1) |
| T-23 | Two admins cancel the same booking simultaneously | One succeeds, one gets 409 `STATE_CONFLICT`; one cancellation email, not two |

### Time and DST
| # | Case | Expected |
|---|------|----------|
| T-30 | Booking across a spring-forward transition | Correct UTC duration; bookable-hours check uses local wall clock (BR-T6) |
| T-31 | Booking across an autumn-back transition | Correct; the ambiguous hour resolves to the earlier instant (BR-T8) |
| T-32 | Booking at a non-existent local time | 422 with a clear message (BR-T8) |
| T-33 | Viewer in a different timezone from the room | Displayed in the viewer's zone, labelled, and stored identically (BR-T5) |
| T-34 | Server host `TZ` set to something other than UTC | All tests still pass — proves no reliance on the host clock zone |
| T-35 | Booking at 23:30–00:30 crossing midnight | Validated against both days' bookable hours |

### Rules
| # | Case | Expected |
|---|------|----------|
| T-40 | Booking in the past | 422 (BR-V5) |
| T-41 | Booking 6 minutes in the past | 422; 4 minutes in the past succeeds (the 5-minute tolerance) |
| T-42 | Shorter than the minimum, longer than the maximum | 422 each (BR-V3, BR-V4) |
| T-43 | Beyond the advance window | 422 (BR-V6) |
| T-44 | Outside the room's bookable hours | 422 naming the actual hours (BR-V8) |
| T-45 | Room override beats the org setting; `NULL` inherits, `0` does not | Correct resolution |
| T-46 | Inactive room | 409 `ROOM_INACTIVE` |
| T-47 | Room in another organization | **404, not 403** |

### Permissions
| # | Case | Expected |
|---|------|----------|
| T-50 | Employee cancels another employee's booking | 403 |
| T-51 | Employee moves any booking | 403 |
| T-52 | Admin cancels with no reason | 422 (BR-M5) |
| T-53 | Admin cancels with a 2-character reason | 422 |
| T-54 | Anyone modifies a booking that has ended | 403/409 for every role, including owner (BR-M1) |
| T-55 | Admin changes a role | 403 — owner only (BR-U6) |
| T-56 | Last owner demotes or deactivates themselves | 422 (BR-U6) |
| T-57 | Employee requests `scope=all` bookings | 403 |
| T-58 | Private booking viewed by an uninvolved employee | Title is "Busy", organizer null (BR-P3) |
| T-59 | Private booking viewed by an admin | Full details |
| T-60 | Every admin endpoint hit directly by URL as an employee | 403 across the board — a parameterized sweep over the whole route table |

### Notifications
| # | Case | Expected |
|---|------|----------|
| T-70 | Create a booking with 2 attendees | 3 outbox rows: 1 confirmation, 2 invitations (BR-N2) |
| T-71 | Admin moves a booking | Organizer and every attendee get `booking_moved` containing the reason verbatim |
| T-72 | Admin cancels | `booking_cancelled` with the reason; the `.ics` is `METHOD:CANCEL` with an incremented `SEQUENCE` |
| T-73 | Failed booking transaction | Zero outbox rows (BR-N1) |
| T-74 | Cancel a booking with a pending reminder | The reminder row becomes `CANCELLED` and never sends (BR-M9) |
| T-75 | SMTP fails twice then succeeds | Row retries with backoff and ends `SENT`; recipient receives exactly one email |
| T-76 | SMTP fails 5 times | Row ends `FAILED` and appears in the admin email log |
| T-77 | A `SENDING` row older than 10 minutes | Returned to `QUEUED` and sent |
| T-78 | Reminder whose time passed while the system was down | Dropped, not sent late (BR-N7) |
| T-79 | Cancellation reason containing `<script>alert(1)</script>` | Escaped in the HTML body and in the `.ics` |
| T-80 | A recipient name containing `\r\nBcc: attacker@evil.com` | Stripped; no extra recipient |
| T-81 | `.ics` `UID` across create → move → cancel | Identical throughout; `SEQUENCE` strictly increasing |
| T-82 | Opt-out user | Receives no reminder, but still receives a cancellation (BR-N8) |

### Authentication
| # | Case | Expected |
|---|------|----------|
| T-90 | 5 failed logins then a correct one | 429 — the lock holds even for the right password |
| T-91 | Login for a non-existent vs a disabled vs a real account with a wrong password | Identical status, body and comparable timing |
| T-92 | Reuse of a consumed reset token | 400 |
| T-93 | Expired invite token | 400 with an offer to request a new invitation |
| T-94 | Session identifier before and after login | Different (fixation) |
| T-95 | Password change | All other sessions of that user are invalidated |
| T-96 | Deactivating a user | Their active session is rejected on the very next request |
| T-97 | Any mutating request without a CSRF token | 403 |

### Frontend components
| # | Case | Expected |
|---|------|----------|
| T-100 | `BookingForm` submitted with an empty title | Blocked client-side by the shared schema, error shown on the field |
| T-101 | `BookingForm` receives a 422 naming the room's hours (BR-V8) | The server message is attached to the time field, not shown as a toast |
| T-102 | `BookingForm` gets a 409 | `ConflictPanel` renders inline with the conflicting booking and clickable alternatives; the form keeps its contents |
| T-103 | `BookingForm` submit button double-clicked | One request; the button is disabled after the first click and an `Idempotency-Key` is sent |
| T-104 | `MoveDialog` with an empty reason | "Move booking" is disabled; enabled once 3 characters are typed (BR-M5) |
| T-105 | `MoveDialog` room dropdown | Occupied rooms are rendered disabled and labelled with the current holder |
| T-106 | `MoveDialog` target becomes occupied between open and submit | The 409 renders inside the dialog; the dialog does not close or navigate |
| T-107 | `CancelDialog` | States how many people will be emailed before confirming |
| T-108 | `CalendarGrid` keyboard | Arrows move the cursor, `Shift+Arrow` extends, `Enter` opens the form pre-filled, `Escape` clears |
| T-109 | `CalendarGrid` accessible names | Free cells and booking blocks expose the names specified in [07 §7](07-ui-screens.md#calendargrid--the-one-hard-component) |
| T-110 | `CalendarGrid` at 390 px | Renders the stacked `RoomRow` list, not a horizontally scrolling grid |
| T-111 | Private booking rendered for an uninvolved employee | Shows "Busy" only — the component never receives the title, because the server redacted it |
| T-112 | A mutation succeeds | The correct query keys are invalidated ([05 §9](05-api-spec.md#query-key-conventions)) and the grid refetches |
| T-113 | Any request returns 401 | The query cache is cleared and the app redirects to `/login`, preserving the attempted path |
| T-114 | `RequireRole` with an employee session on an admin route | Redirects; no admin navigation is rendered |
| T-115 | Every page in loading, empty and error state | Renders `Skeleton`, `EmptyState` and an inline error with the request ID ([07 §6](07-ui-screens.md#6-cross-cutting-states)) |

### Recurrence, calendar sync and multi-location

Specified in full alongside their features — they are listed there rather than duplicated here:

| Range | Area | Spec |
|-------|------|------|
| T-120…T-134 | Recurring series: DST, partial creation, the three edit scopes, exception preservation, `RECURRENCE-ID`, horizon roll-forward | [12 §10](12-recurrence.md#10-test-cases) |
| T-140…T-158 | Calendar sync: native-vs-`.ics` selection, loop prevention, inbound conflict resolution, webhook authenticity, token encryption | [13 §11](13-calendar-sync.md#11-test-cases) |
| T-160…T-172 | Multi-location: scoped admin permissions, three-level settings inheritance, per-location working days and DST | [14 §9](14-multi-location.md#9-test-cases) |

Three of these are the ones to check first if anything regresses:

- **T-140** — a connected organizer must produce a native invitation and **no `.ics`**. This is
  the double-invitation failure, and it is the one users notice immediately.
- **T-143** — the sync loop must not run away. Each of the three defences is tested alone, so a
  single one failing is caught rather than masked by the other two.
- **T-120** — a weekly standup must stay at 09:00 local across a clock change.

## 4. Fixtures

A small builder API keeps tests readable:

```ts
const org   = await aOrganization({ timezone: 'Africa/Addis_Ababa' })
const admin = await aUser({ org, role: 'ADMIN' })
const room  = await aRoom({ org, capacity: 10, hours: '08:00-18:00 Mon-Fri' })
const bk    = await aBooking({ room, organizer: alice, at: '2026-11-04 09:00', forMinutes: 60 })
```

Time is controlled with a fake clock (`vi.setSystemTime`) so "in the past" and "within the
advance window" are deterministic. No test depends on the real current date.

## 5. End-to-end journeys

Each is written as a user narrative and asserts both the UI and the emails.

| # | Journey |
|---|---------|
| E-01 | **Invitation to first booking.** Owner invites a user → the invitation email is captured → the link opens → a password is set → the user lands on the calendar → books a free room → sees the confirmation on screen → the confirmation email was captured with a valid `.ics` |
| E-02 | **Conflict recovery.** Alice books 09:00–10:00. Bob attempts the same slot → sees the inline conflict with alternatives → clicks "Room C at 09:00" → booking succeeds |
| E-03 | **Admin move.** Admin opens Bob's booking → Move → picks a free room → is blocked until a reason is typed → submits → Bob's email shows before and after and the reason → the booking page history shows the move → the original slot is now free on the calendar |
| E-04 | **Admin cancel.** Admin cancels with a reason → the organizer and both attendees are emailed → the slot is immediately bookable by someone else |
| E-05 | **Room lifecycle.** Admin creates a room with features and hours → it appears in the finder → admin deactivates it → is shown its future bookings → cancels them → the room leaves the calendar while its history remains |
| E-06 | **Self-service.** Employee edits their own booking's time, then cancels it; attendees are notified both times |
| E-07 | **Closure.** Admin adds a maintenance closure → the room shows as closed on the grid → booking into it fails with the closure reason |
| E-08 | **Keyboard only.** Complete E-01's booking step using only the keyboard, including the calendar grid |
| E-09 | **Mobile.** Repeat the booking flow at 390 px width |
| E-10 | **Permissions.** Signed in as an employee, every admin URL returns 403 and no admin navigation is rendered |
| E-11 | **Recurring series end to end.** Create a weekly standup for a year → the preview reports 3 clashes → skip them → one email arrives, not 52 → the calendar shows the series → an admin moves **one** occurrence with a reason → the organizer's email says only that date changed → the rest of the series is visibly unchanged |
| E-12 | **Cross-location booking.** A London user books an Addis room → both timezones are shown → the confirmation email renders in the recipient's zone with the room's alongside → the London admin cannot move it (403) → the Addis admin can |
| E-13 | **Calendar sync happy path.** Connect a mock Google account → book a room → a native event is created and **no `.ics` is sent** → an admin moves the booking → the provider event updates in place → cancel → the event is removed |
| E-14 | **Calendar sync rejection.** With the event synced, simulate the user moving it in Google into an occupied slot → the provider event is reverted → `calendar_change_rejected` arrives → **the room is not double-booked** |

E-13 and E-14 run against a **recorded mock** of the Google and Graph APIs, not the live
services, so CI stays deterministic. A separate, manually-triggered smoke test runs against
real sandbox tenants before each release that touches the integration.

## 6. Quality gates in CI

Every pull request must pass:

1. `npm run typecheck` — zero type errors across `shared`, `server` and `client`, strict mode
2. ESLint — zero errors, including the `eslint-plugin-boundaries` layering rules from
   [02 §5](02-architecture.md#5-layering-rules) (a route importing Prisma fails the build)
3. Unit, integration and component tests — all green
4. Concurrency tests against PostgreSQL — all green
5. `npm run build` succeeds, and Playwright E2E runs **against the built artifact**, not the
   dev server — this is what catches a production-only static-serving or SPA-fallback bug
6. axe-core — zero serious or critical violations
7. `npm audit --omit=dev` — zero high or critical
8. Coverage — **100% of `shared/` and `server/src/services/`**, 80% overall. The booking rules
   are not a place for untested branches; presentational components are less critical
9. A Prisma schema change without a matching committed migration fails the build
10. Client bundle size budget — initial JS under 250 KB gzipped; CI fails on a regression over
    10%, so the calendar does not quietly grow a 2 MB date library

## 7. Manual test pass before release

Automation cannot judge these:

- An email opened in **Outlook, Gmail web, Gmail mobile and Apple Mail** — does the
  before/after table survive, and does the `.ics` update the existing entry rather than
  creating a second one?
- The calendar grid with 50 rooms — still readable and fast?
- A screen reader pass over the calendar and the move dialog.
- A move and a cancellation carried out by the actual office admin, unaided, to check the flow
  makes sense to the person who will live in it.
