# 07 — UI & Screens

## 1. Principles

1. **The calendar is the home page.** Most visits are "is a room free right now?" — that
   question should be answered before the user clicks anything.
2. **Booking is three fields.** Room, time, title. Everything else is optional and collapsed.
3. **Never a dead end.** A conflict always offers a way forward (BR-C4). An empty list always
   offers the action that fills it.
4. **Admin power is visible but not intrusive.** Admin-only actions appear inline on the
   booking they affect, marked as admin actions, not hidden in a separate console.
5. **Accessible by construction** (NFR-5): real `<button>` and `<label>` elements, keyboard
   operation throughout, visible focus rings, 4.5:1 contrast, and never colour alone — room
   colours are always paired with the room name, and status is always paired with a word.
6. **Responsive down to 360 px.** The room-by-time grid becomes a stacked per-room list on
   narrow screens, because a horizontally scrolling grid is unusable on a phone.

## 2. Visual language

- **Typography:** one system font stack; three sizes (14 / 16 / 24) plus a 12 px caption.
- **Colour:** a neutral grey scale, one accent for primary actions, plus semantic green /
  amber / red used only for status. Room colours come from a fixed 10-hue palette chosen for
  distinguishability including for the common forms of colour blindness.
- **Dark mode:** supported via CSS custom properties and `prefers-color-scheme`.
- **Density:** comfortable by default; the admin booking table has a compact toggle.
- **Motion:** transitions under 150 ms, and all of them disabled under
  `prefers-reduced-motion`.

## 3. Navigation

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ▣ Acme Rooms  Calendar  Find a room  My bookings │📍Head Office▾│Admin▾│👤│
└─────────────────────────────────────────────────────────────────────────┘
```

The location switcher is present on every screen and shows each site's current local time —
see [14 §7](14-multi-location.md#7-user-interface).

`Admin ▾` appears only for `ADMIN` and `OWNER` and contains: Rooms, All bookings, Users
(owner), Settings (owner), Email log, Audit log. On mobile the bar collapses to a hamburger,
with "Find a room" promoted to a floating action button.

## 4. Screen inventory

| # | Screen | Route | Role | Stories |
|---|--------|-------|------|---------|
| S-01 | Login | `/login` | Public | US-A1 |
| S-02 | Forgot password | `/forgot-password` | Public | US-A3 |
| S-03 | Reset password | `/reset-password?token=` | Public | US-A3 |
| S-04 | Accept invitation | `/accept-invite?token=` | Public | US-A2 |
| S-05 | Day calendar | `/` and `/calendar` | User | US-B1 |
| S-06 | Find a room | `/find` | User | US-B2 |
| S-07 | New booking | `/bookings/new` | User | US-B3 |
| S-08 | Booking detail | `/bookings/:id` | User | US-B5, US-M6 |
| S-09 | My bookings | `/bookings` | User | US-B5 |
| S-10 | Account | `/account` | User | US-A7, US-A8 |
| S-11 | Admin: rooms list | `/admin/rooms` | Admin | US-R1…R9 |
| S-12 | Admin: room editor | `/admin/rooms/:id` | Admin | US-R1…R7 |
| S-13 | Admin: all bookings | `/admin/bookings` | Admin | US-M1…M5 |
| S-14 | Admin: move dialog | modal on S-08 / S-13 | Admin | US-M3, US-M4 |
| S-15 | Admin: cancel dialog | modal on S-08 / S-13 | Admin | US-M2 |
| S-16 | Admin: users | `/admin/users` | Owner | US-A5, US-A6 |
| S-17 | Admin: settings | `/admin/settings` | Owner | — |
| S-18 | Admin: email log | `/admin/emails` | Admin | US-N6 |
| S-19 | Admin: audit log | `/admin/audit` | Admin | US-M6 |
| S-20 | Admin: utilization | `/admin/reports` | Admin | US-P1, US-P2 |
| S-21 | Dev mailbox | `/dev/emails` | Dev only | — |
| S-22 | Calendar connection | `/account/calendar` | User | US-C1, US-C7 |
| S-23 | Admin: locations | `/admin/locations` | Owner | US-L1, US-L5, US-L7 |
| S-24 | Admin: integrations health | `/admin/integrations` | Admin | US-C8, US-C9 |
| S-25 | Series detail | `/series/:id` | User | US-B14 |
| S-26 | Recurrence editor | panel within S-07 | User | US-B12 |
| S-27 | Series conflict preview | modal on S-07 | User | US-B13 |
| S-28 | Edit scope chooser | modal on S-08 / S-13 | User, Admin | US-B14, US-M10 |

Screens S-22 and S-24 are specified in [13 §9](13-calendar-sync.md#9-user-experience);
S-23 in [14 §7](14-multi-location.md#7-user-interface).

### S-26 / S-27 — Recurrence

The repeat control lives in the collapsed section of `BookingForm` and expands inline:

```
┌─────────────────────────────────────────────────────┐
│  ☑ Repeat                                           │
│    Every [ 1 ] [ week ▾ ]  on  [M][T̲][W][T][F][S][S]│
│    Ends  ( ) Never                                  │
│          (•) On [ 28 Dec 2027 ]                     │
│          ( ) After [ 52 ] occurrences               │
│    → Every Tuesday at 09:00, 52 meetings            │
└─────────────────────────────────────────────────────┘
```

The summary line restates the rule in plain English and updates live — the cheapest way to
stop someone accidentally booking a room 300 times.

On submit, the **preview** modal (S-27) appears before anything is written:

```
┌──────────────────────────────────────────────────────────┐
│  49 of 52 dates are free                              ✕  │
├──────────────────────────────────────────────────────────┤
│  ⚠ 3 dates have a problem:                               │
│                                                          │
│   23 Dec  Boardroom taken — "Quarterly review"           │
│           [ Skip ]  [ Use Room C ▾ ]                     │
│   1 Jan   Building closed — New Year                     │
│           [ Skip ]                                       │
│   30 Mar  09:00 does not exist (clock change)            │
│           [ Skip ]  [ Use 10:00 ]                        │
│                                                          │
│              [ Back ]  [ Book 49 meetings ]              │
└──────────────────────────────────────────────────────────┘
```

The button states the real count, so nobody is surprised by what they created.

### S-28 — Edit scope chooser

Appears before **any** edit, move or cancel on an occurrence of a series. Defaults to
"The entire series" for the organizer editing their own meeting, and to **"This occurrence
only"** for an admin — because an admin reclaiming a room almost always means today, not
forever. Getting that default right saves a great many accidental series-wide changes.

---

## 5. Key screens in detail

### S-05 — Day calendar

The default landing page and the most-used screen in the system.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ◀  Tuesday, 4 November 2026  ▶      [Today]     Head Office ▾   [Find room] │
│  Capacity ≥ [ 4 ▾]   Features: [Projector ×] [+ add]                         │
├──────────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────────┤
│ Room     │ 08    │ 09    │ 10    │ 11    │ 12    │ 13    │ 14    │ 15        │
├──────────┼───────┴───────┼───────┼───────┴───────┼───────┼───────┼───────────┤
│ Boardroom│░ Design review│       │▓ Quarterly rev│       │       │           │
│ 14 seats │  Alice B.     │       │  Sara M.      │       │       │           │
├──────────┼───────────────┴───────┼───────────────┴───────┼───────┼───────────┤
│ Room C   │                       │░ 1:1  Bob T.          │       │           │
│ 6 seats  │                       │                       │       │           │
├──────────┼───────────────────────┼─────────────┬─────────┴───────┼───────────┤
│ Focus 1  │▚▚ Closed: projector repair ▚▚▚▚▚▚▚▚ │                 │           │
│ 2 seats  │                                     │                 │           │
└──────────┴─────────────────────────────────────┴─────────────────┴───────────┘
   ░ booked    ▓ your booking    ▚ closed    blank = free, click to book
```

Behaviour:
- A **click** on empty space opens the new-booking panel pre-filled with that room and a
  default-length slot. A **drag** across empty space selects a custom range.
- Hovering a booking shows title, organizer, time and attendee count. Private bookings the
  viewer may not see show only "Busy" (BR-P3).
- A **now line** marks the current time and the page auto-advances it.
- Admins see a small "⋯" on every booking with Move and Cancel.
- **Keyboard:** arrow keys move a cursor cell by cell, `Enter` starts a booking at the cursor,
  `Shift+Arrow` extends the selection, `Escape` cancels. Each cell is a real focusable element
  with an accessible name such as "Boardroom, 10:00 to 10:15, free".
- **Narrow screens:** rooms stack vertically, each showing a horizontal free/busy bar for the
  day plus a list of its bookings.
- **Empty state** (no rooms yet): "No rooms have been set up." Admins also see
  "Add your first room".

### S-06 — Find a room

For when the user knows *when* and *what they need*, not *where*.

```
┌───────────────────────────────────────────────────────────────┐
│  When   [Tue 4 Nov] [09:00] for [1 hour ▾]                    │
│  People [ 6 ]       Features [☑ Projector] [☐ Video] [☐ …]    │
│  Where  [Head Office ▾]                      [ Search ]       │
├───────────────────────────────────────────────────────────────┤
│  3 rooms are free                                             │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Room C          6 seats · 2nd floor · Projector, TV     │  │
│  │                                           [ Book 09:00 ]│  │
│  ├─────────────────────────────────────────────────────────┤  │
│  │ Training Room   12 seats · Ground · Projector           │  │
│  │                                           [ Book 09:00 ]│  │
│  └─────────────────────────────────────────────────────────┘  │
│  Nothing suitable? Nearest free times in Room C: 08:00, 13:00 │
└───────────────────────────────────────────────────────────────┘
```

Results are ordered smallest-room-first among those that fit, so a two-person meeting does not
consume the boardroom. "Book" goes straight to a pre-filled confirmation, one click from done.

### S-07 — New booking

```
┌──────────────────────────────────────────────────────┐
│  New booking                                      ✕  │
├──────────────────────────────────────────────────────┤
│  Title*        [ Design review                     ] │
│  Room*         [ Boardroom (14 seats) ▾            ] │
│  Date*         [ Tue 4 Nov 2026 ]                    │
│  From*  [09:00]  To* [10:00]   (1 hour)              │
│                                                      │
│  ✓ Boardroom is free at this time                    │
│                                                      │
│  ▸ Add attendees, description and options            │
│                                                      │
│                        [ Cancel ]  [ Book room ]     │
└──────────────────────────────────────────────────────┘
```

- The availability line updates live as the fields change, before submission — most conflicts
  are prevented rather than reported.
- The collapsed section holds attendees (a combo box over the staff directory that also accepts
  typed external addresses), description, "private booking", and, for admins, "book on behalf
  of".
- The submit button disables itself on click and the request carries an `Idempotency-Key`, so a
  double click cannot create two bookings.

**Conflict state** — shown inline rather than as an error page:

```
┌──────────────────────────────────────────────────────┐
│  ⚠ Boardroom is already booked 09:00–10:00           │
│     "Quarterly review" — Sara Mengistu               │
│                                                      │
│  Try instead:                                        │
│   Same room:  [ 08:00–09:00 ]  [ 10:00–11:00 ]       │
│   Other rooms at 09:00: [ Room C ] [ Training Room ] │
└──────────────────────────────────────────────────────┘
```

Every suggestion is a one-click rebooking. The user never retypes anything.

### S-08 — Booking detail

Shows the booking, who may do what to it, and — for admins — its full history and the emails it
generated.

```
┌───────────────────────────────────────────────────────────────┐
│  Design review                                   CONFIRMED    │
│  Boardroom · 3rd floor · Head Office                          │
│  Tuesday 4 November 2026, 09:00 – 10:00 (EAT)                 │
│  Organizer: Alice Bekele                                      │
│  Attendees: Bob Tesfaye, partner@external.com                 │
│                                                               │
│  [ Edit ]  [ Cancel booking ]  [ Add to my calendar ]         │
│  Admin:  [ Move ]  [ Cancel with reason ]  [ Reassign ]       │
├───────────────────────────────────────────────────────────────┤
│  History                                                      │
│   4 Nov 08:12  Sara Mengistu moved Boardroom → Room C         │
│                "Boardroom required for the quarterly review"  │
│   1 Nov 14:30  Alice Bekele created the booking               │
├───────────────────────────────────────────────────────────────┤
│  Emails (admin only)                                          │
│   ✓ booking_moved → alice@acme.com        4 Nov 08:12  Sent   │
│   ✓ booking_moved → bob@acme.com          4 Nov 08:12  Sent   │
│   ✗ booking_moved → partner@external.com  4 Nov 08:12  Failed │
│                                              [ Resend ]       │
└───────────────────────────────────────────────────────────────┘
```

### S-14 — Move dialog (admin)

The screen that makes US-M3 and US-M4 real. It must make the consequence obvious before the
admin commits.

```
┌───────────────────────────────────────────────────────────────┐
│  Move "Design review"                                      ✕  │
├───────────────────────────────────────────────────────────────┤
│              Currently                 Move to                │
│  Room        Boardroom                 [ Room C ▾         ]   │
│  Date        Tue 4 Nov                 [ Tue 4 Nov        ]   │
│  Time        09:00 – 10:00             [11:00] – [12:00]      │
│                                                               │
│  ✓ Room C is free 11:00–12:00                                 │
│                                                               │
│  Reason for the move *  (shown to the organizer)              │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Boardroom required for the quarterly review.            │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ☑ Notify the organizer and 2 attendees by email              │
│    (notification cannot be turned off for admin moves)        │
│                                                               │
│                               [ Cancel ]  [ Move booking ]    │
└───────────────────────────────────────────────────────────────┘
```

- The room dropdown lists only rooms **free at the target time**, with occupied rooms shown
  greyed out and labelled with who has them — so the admin can see the whole picture.
- "Move booking" stays disabled until a reason of at least 3 characters is entered (BR-M5).
- If the target becomes occupied between opening and submitting, the dialog returns the 409
  inline, showing the conflicting booking, rather than failing to a new page (US-M5).

### S-15 — Cancel dialog (admin)

Same shape: the booking summary, a required reason, an explicit list of who will be emailed,
and a destructive-styled confirm button. The dialog states plainly: "The room will be free
immediately and 3 people will be emailed."

### S-12 — Room editor (admin)

Tabbed: **Details** (name, location, capacity, floor, description, colour, photo) ·
**Features** (checkbox list) · **Bookable hours** (a per-weekday grid with "copy Monday to all
weekdays") · **Limits** (min/max duration, advance window, notice — each with an "inherit from
organization settings" default) · **Closures** (list plus an add form) · **Danger zone**
(deactivate, with the future-bookings resolution list from BR-R4).

### S-13 — Admin: all bookings

A filterable table: date range, room, organizer, status, free-text search. Each row has inline
Move and Cancel. Bulk selection supports bulk cancel with one shared reason — the realistic
flow when a room floods and eight meetings must be relocated at once.

### S-16 — Admin: users (owner)

Table of users with status, role and last login. Actions: Invite, Resend invitation, Change
role, Deactivate. Deactivation shows the user's future bookings and offers to reassign or
cancel them (BR-U5). The last remaining owner has their demote and deactivate controls
disabled with an explanatory tooltip (BR-U6).

### S-21 — Dev mailbox

Development only. A list of every email the `ConsoleMailer` captured, each openable to see the
rendered HTML, the plain-text alternative and the raw `.ics`. This is what makes it possible to
develop and demo the entire notification system without any SMTP credentials (D2).

---

## 6. Cross-cutting states

Each screen specifies all five. "It works when the data is there" is not a finished screen.

| State | Treatment |
|-------|-----------|
| **Loading** | Skeleton rows for the grid and tables; never a layout shift when content arrives |
| **Empty** | A sentence explaining what would appear here, plus the action that creates it |
| **Error** | Inline, in plain language, next to the field or action that caused it, with the request ID available for support |
| **Offline / failed request** | A toast: "Could not reach the server. Your changes were not saved." The form keeps its contents |
| **Permission denied** | The control is not rendered at all rather than rendered and rejected — and the server enforces it regardless |

## 7. React component architecture

The UI is a React 19 SPA ([02](02-architecture.md)). Screens above map to `pages/`; the pieces
below are the reusable layer.

### Component inventory

| Group | Components | Notes |
|-------|-----------|-------|
| `ui/` | `Button` `Dialog` `Field` `Input` `Select` `Combobox` `Toast` `Table` `Badge` `EmptyState` `Skeleton` `ConfirmDialog` | Built on **Radix UI primitives** for anything with focus management or ARIA — dialogs, menus, comboboxes, tooltips. Hand-rolling a focus trap is how accessibility bugs ship |
| `calendar/` | `CalendarGrid` `TimeAxis` `RoomRow` `BookingBlock` `ClosureBlock` `NowLine` `SelectionOverlay` | The one genuinely custom part, ~400 lines. See below |
| `booking/` | `BookingForm` `AvailabilityHint` `ConflictPanel` `AttendeePicker` `MoveDialog` `CancelDialog` `BookingHistory` `EmailLogPanel` | `MoveDialog` and `CancelDialog` are the admin screens S-14 and S-15 |
| `rooms/` | `RoomCard` `RoomFilters` `FeaturePicker` `HoursEditor` `ClosureList` | |
| `admin/` | `UserTable` `RoleSelect` `SettingsForm` `AuditTable` `UtilizationChart` | |
| `layout/` | `AppShell` `NavBar` `UserMenu` `RequireAuth` `RequireRole` `ErrorBoundary` | |

### `CalendarGrid` — the one hard component

Everything else is forms and tables. This is where the design effort goes.

- **Structure:** a CSS Grid of `rooms × time slots`. One DOM node per *booking*, absolutely
  positioned over the slot grid — **not** one node per 15-minute cell per room, which at 50
  rooms × 40 slots would be 2,000 nodes and slow.
- **Interaction:** pointer-down on free space starts a selection, pointer-move extends it,
  pointer-up opens `BookingForm` pre-filled. Uses Pointer Events, so touch drag works on a
  tablet without a separate code path.
- **Keyboard** (this is the accessibility contract, and it is tested):
  | Key | Action |
  |-----|--------|
  | `Tab` | Moves between rooms, not between cells — 2,000 tab stops is not navigation |
  | `←` `→` | Move the cursor by one slot within a room |
  | `↑` `↓` | Move between rooms at the same time |
  | `Enter` | Start a booking at the cursor, or open the booking under it |
  | `Shift` + `←` `→` | Extend the selection |
  | `Escape` | Clear the selection |
  | `Home` / `End` | First / last bookable slot of the day |
  Each cell has an accessible name like *"Boardroom, 10:00 to 10:15, free"*; each booking block
  reads *"Boardroom, 09:00 to 10:00, Design review, Alice Bekele, booked"*.
- **Live region:** selection changes announce *"Selected Boardroom, 09:00 to 10:00"* via
  `aria-live="polite"`, so a screen-reader user knows what dragging produced.
- **Narrow screens:** below 768 px the grid is replaced — not scrolled — by `RoomRow`
  components stacked vertically, each a free/busy bar plus a list of its bookings.
- **Performance:** memoized per room row; `content-visibility: auto` on off-screen rows.
  Virtualization is only needed past ~50 rooms and is noted, not built.

### Data fetching

Every screen reads server state through a TanStack Query hook, never a bare `fetch`:

```ts
const { data, isPending, error } = useAvailability({ date, locationId, minCapacity })
const moveBooking = useMoveBooking()   // invalidates ['availability'] and ['booking', id]
```

- Loading → `Skeleton`; error → inline message with the request ID; empty → `EmptyState`.
  All three come from the hook's state, so [section 6](#6-cross-cutting-states) is satisfied by
  construction rather than by remembering.
- Mutations invalidate the keys in [05 §9](05-api-spec.md#query-key-conventions). After an
  admin move, the grid updates itself.
- **No optimistic updates on booking creation.** The whole point is that the server decides
  whether a slot is free; showing a booking that may be rejected a moment later is worse than a
  300 ms wait. Optimistic updates *are* used for cheap, non-contended things like toggling a
  room feature.

### Forms

`React Hook Form` + `zodResolver` against the **shared** schemas, so a field the server rejects
is a field the client already rejected, with the same message. Server-side 422 responses map
field errors straight onto the form via `setError`, so a rule only the server knows about
(BR-V8, room hours) still lands next to the right input.

### Styling

CSS Modules, scoped per component, over design tokens in `styles/tokens.css`:

```css
:root {
  --color-surface: #ffffff;  --color-text: #0f172a;  --color-accent: #2563eb;
  --room-hue-1: #2563eb;     /* 10-hue palette, colour-blind safe */
}
:root:not([data-theme="light"]) { @media (prefers-color-scheme: dark) { … } }
:root[data-theme="dark"] { … }
```

Dark mode follows the system preference with a manual override. Room colours always appear
alongside the room name, never as the sole carrier of meaning (NFR-5).

### Testing the UI

- **Component tests** (Vitest + React Testing Library + MSW): `BookingForm` validation,
  `ConflictPanel` rendering a 409, `MoveDialog` keeping submit disabled until a reason is
  typed, `CalendarGrid` keyboard navigation.
- **E2E** (Playwright): the journeys in [10 §5](10-testing.md#5-end-to-end-journeys).
- **axe-core** on every page in CI, zero serious or critical violations.

### What was given up

The React SPA does not run without JavaScript. Because you confirmed that some terminals need
to work without it (D11, view-only), the answer is **not** to compromise the main app, but to
add a small separate server-rendered path beside it — section 8.

## 8. Display views — the no-JavaScript path

> **D11 resolved: view-only.** Read-only schedule pages, server-rendered, working with
> JavaScript entirely disabled. The React SPA is unchanged.

These are deliberately a **separate, tiny surface** rather than a degraded version of the app.
Trying to make the whole SPA work without JS would have cost 10–12 days and compromised the
calendar; this costs about 3 and does the job properly.

### Routes

| Route | Shows |
|-------|-------|
| `GET /display/location/:token` | Every room at one location for today, as a simple table |
| `GET /display/room/:token` | One room's schedule for today — the door-mounted case |

Server-rendered HTML with inline CSS. **No JavaScript, no fetch, no React.** Auto-refresh uses
`<meta http-equiv="refresh" content="60">`, which works with scripting disabled — the one case
where a meta refresh is the correct tool rather than a relic.

### S-30 — Room display

```
┌──────────────────────────────────────────────┐
│  BOARDROOM                      3rd floor    │
│  Tuesday 4 November · 11:42                  │
├──────────────────────────────────────────────┤
│  NOW                                         │
│  ███  11:00 – 12:00   Booked                 │
│                                              │
│  NEXT                                        │
│       14:00 – 15:00   Booked                 │
│       16:00 – 16:30   Booked                 │
│                                              │
│  Free: 12:00–14:00, 15:00–16:00, after 16:30 │
└──────────────────────────────────────────────┘
```

Large type, high contrast, legible across a corridor. Free time is stated explicitly rather
than left as whitespace to be inferred — the question someone asks a door display is "can I use
this room now?", and the page should answer it without being read closely.

### S-31 — Location display

The same, as a room × time table for the whole floor. Suitable for a lobby screen.

### Access and privacy

A lobby screen cannot log in, so these routes are reached by **signed display tokens** rather
than a session.

| Control | Decision |
|---------|----------|
| Token | Created by an admin per display, stored hashed, revocable, bound to one location or room |
| Scope | **Read-only.** No route under `/display` can mutate anything |
| Content | **Titles and organizers are hidden by default** (D21) — the page shows "Booked" and the time. A screen in a public lobby displaying "Exit interview — J. Smith" is a real incident, and the default must be the safe one |
| Per-display override | An admin may enable titles for an internal-only screen |
| Private bookings | Never show a title on a display, whatever the setting |
| Rate limit | Per token, since these endpoints are unauthenticated by necessity |
| Revocation | Removing the token blanks the screen immediately |

### Admin screen

**S-32 — Displays** (`/admin/displays`): create a display token, choose location or room,
toggle title visibility, copy the URL, revoke. Each row shows when that display last fetched,
so a dead screen in a far corridor is visible from the admin console rather than discovered by
someone standing in front of it.

### Test cases

| # | Case | Expected |
|---|------|----------|
| T-200 | Load a display route with JavaScript disabled | Fully renders; shows current and upcoming bookings |
| T-201 | Default token | Shows "Booked", **never** titles or organizers |
| T-202 | Token with titles enabled | Shows titles, but still not for `is_private` bookings |
| T-203 | Revoked or unknown token | 404, and nothing is leaked about whether it ever existed |
| T-204 | Any mutating request under `/display` | 404 — the routes do not exist |
| T-205 | Page refresh behaviour | `meta refresh` present and correct; content updates without scripting |
| T-206 | Contrast and type size | Passes AA at viewing distance; axe clean |
