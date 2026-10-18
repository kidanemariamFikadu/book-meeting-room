# 02 — Architecture

> **Decision D1 is resolved:** a **modular monolith** — Node.js + Express backend and a React
> single-page frontend, in one repository, built and deployed as **one process**.

## 1. What "monolith" means here

It is worth being precise, because the word covers several different things.

| Dimension | This project | Not this project |
|-----------|--------------|------------------|
| **Repository** | One repo containing `server/`, `client/` and `shared/` | Separate repos per piece |
| **Deployment** | One Node process, one container, one `docker run` | Separate API and web deployments |
| **Database** | One database, one schema | A database per service |
| **Runtime boundary** | React talks to Express over HTTP on the **same origin** | Cross-origin API with CORS and bearer tokens |
| **Internal structure** | **Strictly modular** — routes, services, data access are separate layers with enforced boundaries | A single undifferentiated codebase |

The last row is the one that matters long-term. A monolith is a *deployment* choice, not an
excuse for tangled code. The layering rules in section 5 are enforced by lint rules, so the
system stays separable if it ever needs to be split.

**Why this suits the project:** one developer, one organization, a few hundred users. A single
deployable removes an entire category of problems — no CORS, no token storage, no version skew
between a separately-deployed API and client, no distributed tracing to debug a booking. The
React frontend gives you the interactive calendar grid, drag-to-select and live availability
checking that this product genuinely benefits from.

## 2. System diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser                                                            │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  React 19 SPA  (Vite build, served as static assets)          │  │
│  │   React Router 7 ── routing                                   │  │
│  │   TanStack Query ── server state, caching, invalidation       │  │
│  │   React Hook Form + Zod ── forms, using SHARED schemas        │  │
│  │   CalendarGrid ── the one genuinely custom component          │  │
│  └──────────────────────────┬────────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────────┘
                              │  fetch, same origin, session cookie
                              │  (no CORS, no bearer tokens)
┌─────────────────────────────▼───────────────────────────────────────┐
│  ONE Node.js process                                                │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Express 5                                                     │  │
│  │                                                               │  │
│  │  GET /assets/*  ─▶ static: the built React bundle             │  │
│  │  GET /api/v1/*  ─▶ JSON API                                   │  │
│  │  GET /display/* ─▶ server-rendered, NO JavaScript (D11)       │  │
│  │  GET /*         ─▶ index.html  (SPA fallback for deep links)  │  │
│  │                                                               │  │
│  │  middleware: requestId · session · csrf · auth · rateLimit    │  │
│  └──────────────────────────┬────────────────────────────────────┘  │
│                             ▼                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Service layer — ALL business rules live here                  │  │
│  │  AuthService    RoomService     AvailabilityService           │  │
│  │  UserService    BookingService  NotificationService           │  │
│  │  AuditService   IcsBuilder                                    │  │
│  └──────────────────────────┬────────────────────────────────────┘  │
│                             ▼                                       │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Data layer — Prisma Client                                    │  │
│  └──────────────────────────┬────────────────────────────────────┘  │
│                             │                                       │
│  ┌──────────────────────────┴────────────────────────────────────┐  │
│  │ Background workers — same process, started after listen()     │  │
│  │  OutboxWorker 15 s · ReminderWorker 60 s · CleanupWorker 03:00│  │
│  │  CalendarSyncWorker 10 s · WebhookRenewal 1 h                 │  │
│  │  CalendarReconcile 6 h · SeriesHorizon nightly                │  │
│  └──────────────────────────┬────────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────────┘
                 ┌────────────┴────────────┐
                 ▼                         ▼
        ┌──────────────────┐      ┌──────────────────┐
        │ PostgreSQL (prod)│      │ SMTP relay       │
        │ SQLite (dev/test)│      │ (Workspace/M365) │
        └──────────────────┘      └──────────────────┘
```

## 3. Stack

### Backend

| Concern | Choice | Why |
|---------|--------|-----|
| Runtime | Node.js 24 LTS | Already installed |
| Language | TypeScript, `strict` | Booking code is full of dates and IDs that are easy to confuse; the compiler catches that class of bug |
| Framework | Express 5 | Small, stable, universally readable |
| ORM | Prisma | One schema drives SQLite and PostgreSQL; typed client; reviewable migrations |
| DB dev/test | SQLite | Zero setup; a test database is a file |
| DB prod | PostgreSQL 16 | `tstzrange` + `GIST` exclusion constraint makes overlapping bookings **impossible at the database level** ([03 §6](03-data-model.md#6-concurrency-and-the-overlap-constraint)) |
| Sessions | `express-session` + Prisma store | Server-side and revocable. Same-origin makes cookies strictly better than JWTs here |
| Passwords | Argon2id | Current OWASP recommendation |
| Validation | Zod, **in `shared/`** | The same schema validates the request on the server and the form in the browser |
| Email | nodemailer behind a `Mailer` interface | No vendor lock-in; swappable in one file |
| Email templates | MJML → HTML at build time | Email HTML is a minefield; MJML handles it |
| Calendar files | `ics` | Correct RFC 5545 including `METHOD` and `SEQUENCE` |
| Jobs | In-process interval workers over a DB outbox | No Redis; the database is the queue and survives restarts |
| Logging | Pino, JSON, request ID per request | Structured and shippable |

### Frontend

| Concern | Choice | Why |
|---------|--------|-----|
| Library | React 19 | Asked for |
| Build | Vite 6 | Fast dev server, simple production build, first-class TS |
| Language | TypeScript, `strict` | Shares types with the backend — the main payoff of one repo |
| Routing | React Router 7 | Mature, well understood, good nested-route support for the admin section |
| Server state | TanStack Query | Caching, background refetch and **cache invalidation after a mutation** — exactly what a calendar that several people are changing needs |
| Client state | React context + `useState` | There is very little genuine client state. Redux or Zustand would be ceremony without payoff |
| Forms | React Hook Form + `zodResolver` | Binds directly to the shared Zod schemas, so client and server validation cannot drift |
| Styling | CSS Modules + design tokens in CSS custom properties | No extra toolchain, scoped by default, dark mode for free. Tailwind is a reasonable swap if you prefer it |
| Dates | `date-fns` + `date-fns-tz` | Timezone-correct formatting; no hand-rolled offset maths |
| Calendar | **Hand-built `CalendarGrid`** | FullCalendar and friends are large, hard to make accessible, and fight custom interactions. The room × time grid is roughly 400 lines and we control its keyboard behaviour entirely |
| Icons | Lucide React | Small, tree-shakeable, consistent |
| Testing | Vitest + React Testing Library + Playwright | Shares the backend test runner |

### The `shared/` package — why this is the real win

One repository means the contract between client and server can be a **single source of truth**
rather than two definitions that drift apart:

```ts
// shared/schemas/booking.ts — imported by BOTH sides
export const createBookingSchema = z.object({
  roomId:    z.string().uuid(),
  title:     z.string().trim().min(1).max(200),
  startsAt:  z.string().datetime({ offset: true }),
  endsAt:    z.string().datetime({ offset: true }),
  isPrivate: z.boolean().default(false),
  attendees: z.array(attendeeSchema).max(100).default([]),
}).strict()

export type CreateBookingInput = z.infer<typeof createBookingSchema>
```

The server parses the request body with it. The React form validates against it via
`zodResolver`. The API client is typed from it. **Change a field once and TypeScript fails the
build everywhere that needs updating** — that is worth more than any amount of API
documentation discipline.

`shared/` also holds: the response types, the error-code union, the permission matrix
(`can(actor, action, resource)` runs identically on both sides — the client uses it to decide
what to render, the server uses it to enforce), and the pure time and overlap helpers.

## 4. Directory layout

```
book-meeting-room/
├── docs/
├── shared/                        # imported by both client and server
│   ├── schemas/                   # Zod: auth, room, booking, user, settings
│   ├── types/                     # response DTOs, error codes
│   ├── permissions.ts             # can(actor, action, resource) — ONE definition
│   └── time.ts                    # overlap maths, timezone helpers
│
├── server/
│   ├── src/
│   │   ├── index.ts               # entry: build app, start workers, listen
│   │   ├── app.ts                 # Express assembly (exported for tests)
│   │   ├── config.ts              # Zod-validated env; fails fast at boot
│   │   ├── db.ts
│   │   ├── middleware/            # requestId, session, csrf, auth, rateLimit, errorHandler
│   │   ├── routes/api/v1/         # auth, rooms, availability, bookings, users, admin
│   │   ├── services/              # Auth, User, Room, Availability, Booking, Notification, Audit
│   │   ├── mail/                  # Mailer interface, SmtpMailer, ConsoleMailer,
│   │   │                          # OutboxWorker, templates/*.mjml, ics.ts
│   │   ├── workers/               # ReminderWorker, CleanupWorker
│   │   ├── domain/                # errors.ts, rules.ts
│   │   └── static.ts              # serve client/dist + SPA fallback
│   └── tests/                     # unit, integration, concurrency
│
├── client/
│   ├── index.html
│   ├── vite.config.ts             # dev proxy /api → localhost:3000
│   └── src/
│       ├── main.tsx  App.tsx  routes.tsx
│       ├── api/                   # typed fetch client + TanStack Query hooks
│       │   ├── client.ts          # fetch wrapper: CSRF header, 401 handling, error parsing
│       │   └── hooks/             # useRooms, useAvailability, useBookings, useCreateBooking…
│       ├── components/
│       │   ├── calendar/          # CalendarGrid, RoomRow, BookingBlock, TimeAxis, NowLine
│       │   ├── booking/           # BookingForm, ConflictPanel, MoveDialog, CancelDialog
│       │   ├── rooms/  admin/  ui/   # Button, Dialog, Field, Toast, Table, EmptyState
│       ├── pages/                 # one per screen in 07-ui-screens.md
│       ├── hooks/                 # useAuth, usePermissions, useTimezone
│       ├── styles/                # tokens.css, global.css, *.module.css
│       └── test/                  # React Testing Library setup, MSW handlers
│
├── prisma/                        # schema.prisma, migrations/, seed.ts
├── docker-compose.yml             # postgres + mailpit
├── Dockerfile                     # multi-stage: build client + server → one runtime image
└── package.json                   # npm workspaces: shared, server, client
```

npm workspaces tie the three together. `shared` is a workspace dependency of both, so imports
are `@roombook/shared/schemas/booking` rather than `../../../shared/...`.

## 5. Layering rules

Enforced by `eslint-plugin-boundaries` so they cannot quietly erode:

1. **Route handlers never touch Prisma.** They parse input, call a service, shape a response.
2. **Services never touch `req` or `res`.** They take plain arguments and throw typed errors.
   This is what lets the workers reuse them and lets tests exercise rules without HTTP.
3. **`shared/` imports nothing from `server/` or `client/`.** It is pure and runs in both.
4. **`client/` never imports from `server/`** — except types re-exported through `shared/`.
5. **All business rules live in services**, never in a component and never in a route. If the
   React form prevents an invalid booking, that is a convenience; the server must still reject it.

## 6. Authentication across the SPA boundary

Same-origin deployment means the simplest option is also the most secure one.

- Login `POST`s to `/api/v1/auth/login`; the server sets an `HttpOnly`, `Secure`,
  `SameSite=Lax` session cookie. **The SPA never sees or stores a credential** — there is no
  token in `localStorage` for an XSS to steal.
- Every request uses `credentials: 'same-origin'`; the cookie rides along automatically.
- CSRF: the server exposes a token at `GET /api/v1/auth/csrf`; the fetch wrapper attaches it as
  `X-CSRF-Token` on every mutating request and refreshes it on 403 `CSRF_FAILED`.
- On boot the app calls `GET /api/v1/auth/me`. A 401 routes to `/login`, preserving the
  attempted path so the user lands where they meant to go.
- A 401 on **any** later response clears the TanStack Query cache and redirects to login — one
  place, in the fetch wrapper.
- `useAuth()` exposes the user, and `usePermissions()` wraps the **shared** `can()` so the UI
  and the server agree about who may do what by construction.

## 7. Request flow — creating a booking

1. `BookingForm` validates locally against `createBookingSchema`. A `useAvailability` query has
   already shown whether the slot looks free, so most conflicts never reach the server.
2. `useCreateBooking` mutation `POST`s to `/api/v1/bookings` with the CSRF header and an
   `Idempotency-Key`, and disables the submit button — a double click cannot create two bookings.
3. Express: `requestId` → `session` → `auth` → `rateLimit` → Zod parse (422 on failure).
4. `BookingService.create()` opens a **serializable transaction**:
   a. Load and authorize the room (404 if missing, inactive, or another organization).
   b. Apply the rules in [04](04-business-rules.md): hours, duration, advance window, not past.
   c. Check closures → 409. d. Check overlapping bookings → 409.
   e. Insert the booking — on PostgreSQL the exclusion constraint is the final authority, and a
      violation is caught and returned as the same 409.
   f. Insert the audit row. g. Insert outbox rows. h. Insert the reminder row.
   **Commit.**
5. 201 returns the booking. The mutation's `onSuccess` invalidates the `availability` and
   `bookings` query keys, so **the calendar grid updates itself** without a manual refetch.
6. On 409 the component renders `ConflictPanel` inline with the conflicting booking and
   one-click alternatives from `/api/v1/availability/suggestions` ([07 §S-07](07-ui-screens.md)).
7. Within 15 s `OutboxWorker` sends the confirmation email with its `.ics`.

Steps 4d–4h in one transaction is the core correctness property: **the booking, its audit trail
and its notifications are all-or-nothing.**

## 8. Keeping the calendar fresh

Several people change the same calendar, so a stale grid causes real conflicts.

| Mechanism | Behaviour |
|-----------|-----------|
| Mutation invalidation | Any create, move or cancel invalidates `['availability', date, locationId]`, so the grid refetches immediately |
| Background refetch | `refetchInterval: 60_000` on the availability query while the tab is focused |
| Refetch on focus | TanStack Query default — returning to the tab after a meeting gets fresh data |
| Stale-time | 30 s for availability, 5 min for rooms and users, which change rarely |
| Conflict as the backstop | Even with a stale grid, the server rejects the booking and the UI offers alternatives. **Polling is an optimization; the transaction is the guarantee** |

Real-time push (SSE or WebSocket) is deliberately not in v1. Sixty-second polling over a
handful of rooms is a trivial load and a fraction of the complexity. The server-side design
does not preclude adding SSE later.

## 9. Build and run

### Development — two processes, one app

```bash
npm run dev          # concurrently: server on :3000, Vite on :5173
```

Vite proxies `/api` to `:3000`, so the browser sees one origin and cookies work exactly as they
will in production. React Fast Refresh and `tsx watch` both reload on save.

### Production — one process

```bash
npm run build        # tsc shared → vite build client → tsc server → mjml compile
npm start            # node server/dist/index.js  — serves API + bundle on one port
```

The Dockerfile is multi-stage: a build stage compiles all three workspaces, the runtime stage
carries only production dependencies, `server/dist`, `client/dist` and the compiled email
templates, and runs as a non-root user.

Static serving: `/assets/*` gets a one-year immutable cache (Vite hashes filenames);
`index.html` is `no-cache`; anything not matching `/api` or a real file falls back to
`index.html` so deep links such as `/bookings/abc` work on a hard refresh.

## 10. Trade-offs of this choice

Stated plainly, since you picked the stack and should know what comes with it.

**Gained**

- A genuinely interactive calendar: drag-to-select, live availability, optimistic updates.
- One shared contract — schemas, types and the permission matrix defined once.
- Clean separation of API and UI without the cost of separate deployments.
- Familiar to most developers, so handover is easy.
- The API already exists if you later want a mobile app or a room-display tablet.

**Given up, versus the server-rendered alternative**

| Cost | Mitigation |
|------|------------|
| **No no-JavaScript fallback in the app itself** | **Resolved (D11).** A separate, tiny server-rendered path at `/display/*` provides read-only schedule views that work with scripting disabled — see [07 §8](07-ui-screens.md#8-display-views--the-no-javascript-path). The SPA is untouched. ~3 days, versus 10–12 to progressively enhance the whole app |
| **Accessibility is hand-built.** Server-rendered HTML is accessible by default; a custom grid is not | Radix UI primitives for dialogs, menus and tooltips (correct focus traps and ARIA for free); axe-core in CI; an explicit keyboard spec for `CalendarGrid` in [07](07-ui-screens.md) |
| **A build step.** More moving parts, slower CI | Vite is fast; the whole build is well under a minute |
| **Two places to get auth wrong** | Mitigated by same-origin cookies — no tokens to mishandle — and one fetch wrapper owning CSRF and 401 |
| **Loading states must be designed** | TanStack Query makes them explicit; [07 §6](07-ui-screens.md#6-cross-cutting-states) requires all five states per screen |
| **Slightly larger estimate** | Roughly 3–4 extra days, reflected in [11](11-delivery-plan.md) |

## 11. Timezone strategy

Unchanged by the stack choice, and still the most common source of bugs in booking systems.

1. **Storage:** every instant in UTC — `TIMESTAMPTZ` in PostgreSQL, ISO-8601 `Z` in SQLite.
2. **Authoritative zone:** each location carries an IANA timezone; the organization has a default.
3. **Interpretation:** "14:00 on 3 March" means 14:00 **in the room's location timezone**. The
   conversion to UTC happens **on the server**, using that zone — never using the browser's
   zone and never using the server's host zone.
4. **Transport:** the API always sends and receives ISO-8601 with an explicit offset. The React
   client never does offset arithmetic; it formats for display with `date-fns-tz` and sends
   back what the server gave it.
5. **Display:** in the viewer's zone (profile setting, else the location's), always labelled.
6. **Recurring rules** such as "08:00–18:00 Mon–Fri" are stored as local wall-clock times plus
   weekday and resolved per date — this is what keeps them correct across DST.
7. **Server runs with `TZ=UTC`**, so an accidental local-time call fails loudly in tests rather
   than quietly in production.

## 12. Scaling notes

The design comfortably covers assumption A1 (≤ 500 users, ≤ 50 rooms).

| Pressure | Symptom | Change |
|----------|---------|--------|
| More users | Session table contention | Move sessions to Redis |
| More email | Outbox lag above 60 s | BullMQ + Redis, or a hosted email API |
| More instances | Duplicate reminders | Add a `job_leases` table, or run workers in one instance with `WORKERS_ENABLED=false` elsewhere |
| Bigger calendars | Day view slows past 50 rooms | The covering index in [03 §5](03-data-model.md#5-indexes); then virtualize the grid rows |
| Several teams changing one calendar | Stale grids | Replace polling with SSE on an `/api/v1/events` stream |
| Genuine multi-tenancy | | `organization_id` scoping is already universal; add PostgreSQL row-level security |

The modular boundaries in section 5 mean that if one part ever needs to be extracted — most
plausibly the email pipeline — the seam already exists.
