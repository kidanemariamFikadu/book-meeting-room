# 05 — API Specification

## 1. Conventions

- Base path `/api/v1`. Breaking changes mean `/api/v2`; the version is never dropped.
- Request and response bodies are JSON, UTF-8.
- All timestamps are **ISO-8601 with an explicit offset**, e.g. `2026-11-04T09:00:00+03:00`.
  The server stores UTC; it accepts any offset and returns UTC with `Z`.
- Authentication is the session cookie (`rb.sid`, `HttpOnly`, `Secure`, `SameSite=Lax`), sent
  automatically because the React client is served from the **same origin**. There is no token
  auth and nothing is stored in `localStorage`.
- Every mutating request requires a CSRF token in the `X-CSRF-Token` header. The client fetches
  it from `GET /api/v1/auth/csrf` on boot and refreshes it on a 403 `CSRF_FAILED`.
- All requests use `credentials: 'same-origin'`. CORS is not configured, because nothing
  cross-origin is expected to call this API.
- `GET` is always safe and idempotent. Mutations use `POST`, `PATCH` and `DELETE`.
- Collection responses are paginated: `?page=1&per_page=50` (max 200), returning
  `{ data: [...], meta: { page, per_page, total, total_pages } }`.
- Every response carries `X-Request-Id`; quote it when reporting a problem.

### Error envelope

```json
{
  "error": {
    "code": "BOOKING_CONFLICT",
    "message": "That room is already booked for part of this time.",
    "details": {
      "conflicts": [
        { "id": "b-7f3e…", "startsAt": "2026-11-04T11:00:00Z",
          "endsAt": "2026-11-04T12:00:00Z", "title": "Design review",
          "organizer": "Alice Bekele" }
      ]
    }
  }
}
```

### Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `VALIDATION_FAILED` | 422 | Body failed schema validation; `details.fields` maps field → message |
| `RULE_VIOLATION` | 422 | Valid input that breaks a business rule (BR-V3…V8); `details.rule` names the rule ID |
| `UNAUTHENTICATED` | 401 | No session, or session expired |
| `FORBIDDEN` | 403 | Authenticated but not permitted |
| `NOT_FOUND` | 404 | Does not exist, or is outside the caller's organization |
| `BOOKING_CONFLICT` | 409 | Overlaps a booking |
| `CLOSURE_CONFLICT` | 409 | Overlaps a room closure |
| `ROOM_INACTIVE` | 409 | Room is deactivated |
| `STATE_CONFLICT` | 409 | E.g. cancelling an already-cancelled booking |
| `SERIES_CONFLICT` | 409 | Some occurrences of a series clash; `details.conflicts[]` lists each date |
| `SERIES_SCOPE_REQUIRED` | 422 | An occurrence was edited without a `scope` |
| `RECURRENCE_LIMIT` | 422 | Series exceeds 500 occurrences or the 365-day horizon |
| `LOCATION_FORBIDDEN` | 403 | A location-scoped admin acted outside their locations (BR-L1, BR-L2) |
| `CALENDAR_NEEDS_REAUTH` | 409 | The connection is broken; the action still succeeded with `.ics` fallback |
| `RATE_LIMITED` | 429 | `Retry-After` header present |
| `CSRF_FAILED` | 403 | Missing or invalid CSRF token |
| `INTERNAL_ERROR` | 500 | Logged with the request ID |

---

## 2. Authentication

### `POST /api/v1/auth/login`
Public. Rate limited: 5 failures per email per 15 minutes, 20 per IP per 15 minutes.

```json
{ "email": "alice@acme.com", "password": "correct horse battery staple" }
```

`200` → `{ "user": { "id", "fullName", "email", "role", "timezone" } }` and sets `rb.sid`.
`401` → `INVALID_CREDENTIALS` — **identical response and timing whether or not the account
exists, and whether or not it is disabled**, so the endpoint cannot enumerate users.
`429` → `RATE_LIMITED`.

### `POST /api/v1/auth/logout`
`204`. Destroys the session server-side and clears the cookie.

### `POST /api/v1/auth/forgot-password`
`{ "email": "..." }` → always `202`, whether or not the address exists.

### `POST /api/v1/auth/reset-password`
`{ "token": "...", "password": "..." }` → `204`. Consumes the token, destroys all that user's
other sessions, and sends a "your password was changed" email.

### `POST /api/v1/auth/accept-invite`
`{ "token": "...", "password": "...", "fullName": "..." }` → `200`, sets status `ACTIVE` and
logs the user in.

### `GET /api/v1/auth/me`
`200` → the current user plus their effective permissions, which the UI uses to decide what to
render. The server still enforces permissions independently.

---

## 3. Rooms

### `GET /api/v1/rooms`
Any authenticated user.

Query: `locationId`, `minCapacity`, `features` (comma-separated IDs), `active` (default `true`),
`q` (name search).

```json
{ "data": [ {
    "id": "r-1", "name": "Boardroom", "capacity": 14, "floor": "3rd",
    "colour": "#2563eb", "isActive": true,
    "location": { "id": "l-1", "name": "Head Office", "timezone": "Africa/Addis_Ababa" },
    "features": [ { "id": "f-1", "name": "Projector" } ],
    "limits": { "minBookingMinutes": 15, "maxBookingMinutes": 480,
                "maxAdvanceDays": 90, "minNoticeMinutes": 0 }
} ], "meta": { "page": 1, "per_page": 50, "total": 6, "total_pages": 1 } }
```

### `GET /api/v1/rooms/:id`
`200` with the room plus its `hours` and upcoming `closures`.

### `POST /api/v1/rooms` · `PATCH /api/v1/rooms/:id`
Admin. Body: `name`, `locationId`, `capacity`, `floor`, `description`, `colour`,
`featureIds[]`, and optional `limits` and `hours`.
`201` / `200`. `409 ROOM_NAME_TAKEN` if the name is already used in that location.

### `POST /api/v1/rooms/:id/deactivate`
Admin. `{ "force": false }`.
`409` with `details.futureBookings` when future bookings exist and `force` is not set —
this is the data behind screen US-M8. With `force: true` the room is deactivated and the
listed bookings are **not** touched; the admin must still resolve them.

### `POST /api/v1/rooms/:id/activate`
Admin. `200`.

### Closures
`GET /api/v1/rooms/:id/closures` · `POST /api/v1/rooms/:id/closures`
(`{ startsAt, endsAt, reason }`) · `DELETE /api/v1/closures/:id`.
`POST` returns `409` with conflicting bookings if any exist in the range (BR-R7).

### Features and locations
`GET|POST /api/v1/features`, `PATCH|DELETE /api/v1/features/:id` — admin.
`GET|POST /api/v1/locations`, `PATCH /api/v1/locations/:id` — admin.

---

## 4. Availability

The endpoint that powers the calendar grid and the room finder.

### `GET /api/v1/availability`

| Param | Required | Notes |
|-------|----------|-------|
| `date` | yes (or `from`/`to`) | `YYYY-MM-DD`, interpreted in the location timezone |
| `from`, `to` | | ISO instants, for a multi-day range. Max span 31 days |
| `roomIds` | | Restrict to specific rooms |
| `locationId` | | |
| `minCapacity`, `features` | | Filters |

```json
{
  "date": "2026-11-04",
  "timezone": "Africa/Addis_Ababa",
  "rooms": [ {
    "roomId": "r-1", "name": "Boardroom",
    "bookableWindows": [ { "startsAt": "2026-11-04T05:00:00Z", "endsAt": "2026-11-04T15:00:00Z" } ],
    "busy": [ {
      "bookingId": "b-9", "startsAt": "2026-11-04T06:00:00Z", "endsAt": "2026-11-04T07:00:00Z",
      "title": "Design review", "organizer": { "id": "u-2", "fullName": "Alice Bekele" },
      "isPrivate": false, "canEdit": false, "canAdminister": true
    } ],
    "closures": [ { "id": "c-3", "startsAt": "…", "endsAt": "…", "reason": "Projector repair" } ]
  } ]
}
```

For a private booking the caller is not entitled to see, `title` is `"Busy"`, `organizer` is
`null` and `isPrivate` is `true` (BR-P3). The redaction happens server-side; the data never
leaves the server.

### `GET /api/v1/availability/find`
Room finder (US-B2). Params: `startsAt`, `endsAt`, `minCapacity`, `features`, `locationId`.
Returns rooms that are **completely free** for the range and satisfy the filters, ordered by
"smallest room that still fits", so a 2-person meeting does not take the boardroom.

### `GET /api/v1/availability/suggestions`
Powers the conflict-recovery UI (BR-C4). Params: the attempted `roomId`, `startsAt`, `endsAt`.
Returns `{ sameRoomAlternatives: [...], otherRooms: [...] }`.

---

## 5. Bookings

### `GET /api/v1/bookings`

| Param | Notes |
|-------|-------|
| `scope` | `mine` (default) \| `all` (admin only) \| `attending` |
| `from`, `to` | Date range filter |
| `status` | `CONFIRMED` \| `CANCELLED` \| `all` |
| `roomId`, `organizerId`, `q` | Filters; `organizerId` is admin-only |

### `GET /api/v1/bookings/:id`
Organizer, attendee, or admin. Includes `attendees`, `canEdit`, `canCancel`, `canMove`, and —
for admins — `history` (audit rows) and `emails` (outbox rows).

### `POST /api/v1/bookings`

```json
{
  "roomId": "r-1",
  "title": "Design review",
  "description": "Walk through the new booking flow",
  "startsAt": "2026-11-04T09:00:00+03:00",
  "endsAt":   "2026-11-04T10:00:00+03:00",
  "isPrivate": false,
  "attendees": [ { "userId": "u-5" }, { "email": "partner@external.com" } ],
  "organizerId": "u-5",
  "notifyAttendees": true
}
```

`organizerId` is admin-only (US-M7); otherwise the caller is the organizer.

`201` → the booking. `409 BOOKING_CONFLICT` with `details.conflicts` and
`details.suggestions`. `422 RULE_VIOLATION` with `details.rule` (e.g. `BR-V8`) and a
human-readable message naming the room's bookable hours.

**Idempotency.** The client may send `Idempotency-Key`. A repeat of the same key within 10
minutes returns the original response rather than creating a second booking — this is what
protects against a double-clicked submit button or a retried request.

### `PATCH /api/v1/bookings/:id`
Edit title, description, attendees, `isPrivate`. Organizer or admin. Sends
`booking_updated` unless `notifyAttendees: false`.

### `POST /api/v1/bookings/:id/move`
The admin action (US-M3, US-M4). Admin only.

```json
{
  "roomId": "r-3",
  "startsAt": "2026-11-04T11:00:00+03:00",
  "endsAt":   "2026-11-04T12:00:00+03:00",
  "reason": "Boardroom required for the quarterly review",
  "notifyAttendees": true
}
```

`roomId` and the times are each optional, but at least one must change. `reason` is
**required**, 3–500 characters (BR-M5). `200` → the updated booking. `409` if the target slot
is occupied, with the conflicting booking in `details` (US-M5). `422` if the target breaks a
rule for the new room.

### `POST /api/v1/bookings/:id/cancel`
`{ "reason": "...", "notifyAttendees": true }`.
Organizer or admin. `reason` is required for admins, optional for the organizer.
`200` → the cancelled booking. `409 STATE_CONFLICT` if already cancelled or already ended.

### `POST /api/v1/bookings/:id/transfer`
Admin. `{ "organizerId": "u-9", "reason": "..." }`. Notifies both organizers (BR-M10).

### `GET /api/v1/bookings/:id/ics`
Returns `text/calendar` for the booking, so a user can re-add it to their calendar at any time.

---

## 5b. Recurring series

Full behaviour: [12-recurrence.md](12-recurrence.md).

### `POST /api/v1/bookings/preview-series`
Dry run. Returns which occurrences are free and which clash, **before** anything is written.

```json
{ "roomId": "r-1", "title": "Weekly standup",
  "startsAtLocal": "2026-11-04T09:00", "durationMinutes": 30,
  "timezone": "Africa/Addis_Ababa",
  "recurrence": { "freq": "WEEKLY", "interval": 1, "byDay": ["TU"], "until": "2027-12-31" } }
```

`200` → `{ preview: { totalOccurrences, available, conflicts[] } }` — see
[12 §4](12-recurrence.md#4-creating-a-series). Read-only, no side effects.

### `POST /api/v1/bookings` with a `recurrence` block
Creates the series. Requires `conflictStrategy`:

| Value | Behaviour |
|-------|-----------|
| `SKIP` | Create the free occurrences, omit the clashing ones (default) |
| `ALTERNATIVE` | Create clashing dates in the rooms supplied in `alternatives[]` |
| `FAIL` | Create nothing unless every occurrence is free |

`201` → `{ series, created, skipped[] }`. **Partial creation is always reported explicitly.**

### `PATCH /api/v1/bookings/:id` · `POST /api/v1/bookings/:id/move` · `/cancel`
For an occurrence of a series these take an additional required field:

```json
{ "scope": "THIS_OCCURRENCE" | "THIS_AND_FOLLOWING" | "ENTIRE_SERIES", "reason": "…" }
```

`409` returns per-occurrence conflicts when a series-wide change clashes on some dates, with
the same strategy options. **An edit never half-applies** (T-124).

### `GET /api/v1/series/:id`
The rule, its occurrences (paginated), and which are exceptions.

### `GET /api/v1/series/:id/occurrences?from=&to=`
Occurrences in a range, each flagged `isException` and `status`.

### `POST /api/v1/series/:id/reset-exceptions`
Admin or organizer. Returns diverged occurrences to the series values.

## 5c. Calendar connections

Full behaviour: [13-calendar-sync.md](13-calendar-sync.md).

| Endpoint | Role | Notes |
|----------|------|-------|
| `GET /api/v1/calendar/connection` | Self | Status, provider, linked account, last sync |
| `POST /api/v1/calendar/connect/:provider` | Self | `google` \| `microsoft`. Returns the OAuth URL with PKCE and `state` |
| `GET /api/v1/calendar/callback/:provider` | Self | OAuth redirect target. Exchanges the code, stores encrypted tokens, creates the webhook channel, runs an initial sync |
| `DELETE /api/v1/calendar/connection` | Self | **Revokes at the provider**, not only locally |
| `POST /api/v1/calendar/sync` | Self | Manual resync |
| `POST /api/v1/webhooks/google` | Public¹ | Push notification. Validates the channel token, queues an incremental sync, returns 200 immediately |
| `POST /api/v1/webhooks/microsoft` | Public¹ | Graph subscription, including the validation handshake. Validates `clientState` |
| `GET /api/v1/admin/integrations` | Admin | Connection health across the organization |
| `PATCH /api/v1/rooms/:id/resource` | Admin | Map a room to a provider resource calendar or room mailbox |

¹ Necessarily unauthenticated, therefore rate-limited, size-capped, and **never trusted**:
the payload is a hint only, and state always comes from re-reading the provider API (T-152).

## 5d. Locations

Full behaviour: [14-multi-location.md](14-multi-location.md).

| Endpoint | Role | Notes |
|----------|------|-------|
| `GET /api/v1/locations` | Any | Active locations with timezone and current local time |
| `POST /api/v1/locations` · `PATCH /api/v1/locations/:id` | **Owner** | Name, code, address, timezone, country, hours and limit overrides |
| `POST /api/v1/locations/:id/deactivate` | Owner | `409` with future bookings unless resolved (BR-L6) |
| `GET|POST|DELETE /api/v1/locations/:id/holidays` | Owner | Per-location non-working days |
| `GET|PUT /api/v1/users/:id/location-access` | Owner | Grant or revoke location-scoped admin (BR-L4) |
| `GET /api/v1/locations/:id/settings/effective` | Admin | The resolved three-level values, each labelled with where it came from |

Every listing endpoint now accepts `locationId`, and `locationId=all` where a cross-location
view makes sense. The day calendar deliberately does **not** accept `all` (T-171).

## 6. Users

| Endpoint | Role | Notes |
|----------|------|-------|
| `GET /api/v1/users` | Any | Directory for the attendee picker. Returns id, name, email only |
| `GET /api/v1/users/:id` | Admin, or self | Full record |
| `POST /api/v1/users/invite` | Owner | `{ email, fullName, role }` → creates `INVITED`, queues the invitation email |
| `POST /api/v1/users/:id/resend-invite` | Owner | Invalidates the previous token |
| `PATCH /api/v1/users/:id` | Owner, or self for own name/timezone | Role changes are owner-only (BR-U6) |
| `POST /api/v1/users/:id/deactivate` | Owner | `409` with `details.futureBookings` unless `force` (BR-U5). Destroys their sessions |
| `POST /api/v1/users/:id/activate` | Owner | |
| `PATCH /api/v1/account/password` | Self | `{ currentPassword, newPassword }`; destroys other sessions |
| `GET /api/v1/account/sessions` · `DELETE /api/v1/account/sessions/:id` | Self | Sign out other devices |

---

## 7. Admin and operations

| Endpoint | Role | Notes |
|----------|------|-------|
| `GET /api/v1/admin/settings` · `PATCH …` | Owner | The `org_settings` row |
| `GET /api/v1/admin/audit` | Admin | Filter by `entityType`, `entityId`, `actorId`, `from`, `to` |
| `GET /api/v1/admin/emails` | Admin | The outbox log (US-N6). Filter by `status`, `bookingId`, `toEmail` |
| `POST /api/v1/admin/emails/:id/resend` | Admin | Requeues a `FAILED` row |
| `GET /api/v1/admin/reports/utilization` | Admin | `from`, `to`, optional `locationId` → hours booked vs bookable per room (US-P1) |
| `GET /api/v1/admin/reports/bookings.csv` | Admin | CSV export (US-P2) |
| `GET /healthz` | Public | Liveness: process is up |
| `GET /readyz` | Public | Readiness: database reachable, migrations applied |

---

## 8. Rate limits

| Scope | Limit | On exceed |
|-------|-------|-----------|
| Login, per email | 5 failures / 15 min | 429, 15-minute lock (FR-1.4) |
| Login, per IP | 20 failures / 15 min | 429 |
| Forgot password, per email | 3 / hour | 202 regardless, but no email sent |
| Booking create or move, per user | 30 / min | 429 |
| All API, per session | 300 / min | 429 |
| All requests, per IP | 1000 / min | 429 |

---

## 9. Client routes (React Router)

These are **browser routes handled by the SPA**, not server endpoints. The server returns
`index.html` for any path that is not `/api/*` and not a real static file, so a hard refresh or
a pasted deep link works. Each screen is detailed in [07-ui-screens.md](07-ui-screens.md).

| Route | Guard | Screen |
|-------|-------|--------|
| `/login`, `/forgot-password`, `/reset-password`, `/accept-invite` | Public — redirects to `/` if already signed in | S-01…S-04 |
| `/` | Authenticated | Today's calendar (S-05) |
| `/calendar?date=&location=` | Authenticated | Day grid (S-05) |
| `/find` | Authenticated | Room finder (S-06) |
| `/bookings`, `/bookings/new`, `/bookings/:id` | Authenticated | S-09, S-07, S-08 |
| `/account` | Authenticated | S-10 |
| `/admin/rooms`, `/admin/rooms/new`, `/admin/rooms/:id` | `ADMIN` | S-11, S-12 |
| `/admin/bookings` | `ADMIN` | S-13 |
| `/admin/emails`, `/admin/audit`, `/admin/reports` | `ADMIN` | S-18, S-19, S-20 |
| `/admin/users`, `/admin/settings` | `OWNER` | S-16, S-17 |
| `/dev/emails` | Dev build only | S-21 |

**Route guards are a convenience, not a control.** A `RequireAuth` / `RequireRole` wrapper
redirects rather than flashing a forbidden screen, using the shared `can()` from
[02 §3](02-architecture.md#the-shared-package--why-this-is-the-real-win). Every corresponding
API endpoint re-checks permission independently — test T-60 sweeps the whole admin route table
as an employee and expects 403 from each.

### Query key conventions

The client caches server state with TanStack Query. Keys are listed here because invalidating
the wrong one is the usual cause of a stale calendar.

| Key | Invalidated by |
|-----|----------------|
| `['auth','me']` | Login, logout, profile update |
| `['rooms', filters]` | Room create / update / activate / deactivate |
| `['availability', date, locationId, filters]` | **Any** booking create, move, cancel, or closure change |
| `['bookings', scope, filters]` | Any booking mutation |
| `['booking', id]` | Mutations on that booking |
| `['users']` | Invite, role change, deactivate |
| `['admin','emails', filters]` | Resend |
| `['admin','audit', filters]` | Not invalidated — append-only, refetched on mount |
