# 13 — Two-Way Calendar Integration

> **Decision resolved:** v1 includes **two-way synchronization with Google Calendar and
> Microsoft 365**, not only `.ics` attachments.

This moves RoomBook from "a system that emails you about meetings" to "a system your calendar
knows about". It is also the largest single source of operational complexity in the product,
so the boundaries are drawn explicitly.

---

## 1. What "two-way" means here

| Direction | Behaviour |
|-----------|-----------|
| **RoomBook → calendar** | Booking a room creates a real event in the organizer's Google or Outlook calendar. Moving it moves the event. Cancelling it deletes the event. Attendees are invited **by the provider**, so they get a native invitation with working Accept / Decline buttons |
| **Calendar → RoomBook** | RSVPs flow back and appear on the booking. If the organizer edits the event in their calendar — time, title, attendees — RoomBook picks it up and applies it, **provided the room is still free** |
| **Room availability** | Optionally, each RoomBook room is mapped to a provider room resource (a Google resource calendar or a Microsoft room mailbox), so the room shows as busy to anyone scheduling from Outlook or Google directly |

### The one line that governs everything

> **RoomBook is the authority on room availability. The provider is the authority on people.**

The provider decides who is attending and whether they accepted. RoomBook decides whether a
room is free, and no provider-side edit can override that. Every ambiguous case in section 7
resolves from this sentence.

---

## 2. Integration model

A deliberate choice, because there are three plausible designs:

| Model | How | Verdict |
|-------|-----|---------|
| Service account writes to every user's calendar | One app identity with domain-wide delegation | **Rejected.** Enormous blast radius — read/write to every calendar in the company. Hard to get approved, and rightly so |
| Each attendee connects, RoomBook writes to each calendar separately | N API calls per booking | **Rejected.** Breaks for anyone not connected, breaks entirely for external guests, and produces duplicate events when two attendees are both connected |
| **RoomBook acts as the organizer's agent** | Delegated OAuth from the organizer. RoomBook creates **one** event in the organizer's calendar with the attendee list. The provider sends the invitations and collects the RSVPs | **Chosen** |

The third model is both the simplest and the most secure. One event exists, owned by the real
organizer. External guests work without being RoomBook users at all, because Google and
Microsoft handle inviting them. RoomBook only needs permission from the person who booked.

### Room resources (optional, per room)

Separately, an admin can map a RoomBook room to a provider room resource. When set, RoomBook
adds that resource as an attendee on the event, so the room appears busy in native scheduling
tools. This is what stops a colleague booking the room from Outlook and bypassing RoomBook
entirely — worth doing, and configured per room rather than all-or-nothing.

---

## 3. Who connects, and what happens if they do not

Connection is **per user and voluntary**. The system must work for everyone regardless.

| Organizer state | Attendee state | What happens |
|-----------------|----------------|--------------|
| Connected | Anyone, internal or external | A native provider event is created. The provider sends invitations. **RoomBook sends no `.ics` to anyone** — that would duplicate the invitation |
| Not connected | Anyone | Current behaviour: RoomBook emails a `.ics` invitation to the organizer and each attendee ([06](06-email-notifications.md)) |
| Connected, but the token has expired or been revoked | — | RoomBook falls back to `.ics` for that booking, flags the connection as broken, and prompts the user to reconnect. **A failed integration never blocks a booking** |

**Preventing the double invitation is the most important rule in this document.** A user who
receives both a RoomBook `.ics` and a native Google invitation for the same meeting ends up
with two entries in their calendar and loses confidence in the whole system. The decision is
made once, per booking, at creation: `useNativeInvites = organizer.calendarConnection?.isHealthy`.

---

## 4. Data model additions

### `calendar_connections`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid FK unique | One connection per user in v1 |
| `provider` | enum | `GOOGLE` \| `MICROSOFT` |
| `provider_account_email` | text | Shown in the UI so a user can see which account is linked |
| `access_token_encrypted` | bytea | **AES-256-GCM, key from `CALENDAR_TOKEN_KEY`** |
| `refresh_token_encrypted` | bytea | Same |
| `token_expires_at` | timestamptz | |
| `scopes` | text | What was actually granted — may be less than requested |
| `calendar_id` | text | The target calendar, usually `primary` |
| `sync_token` | text null | Google `syncToken` / Graph `deltaLink` for incremental sync |
| `webhook_channel_id` / `webhook_resource_id` | text null | Provider push subscription |
| `webhook_expires_at` | timestamptz null | Renewed by a worker before expiry |
| `status` | enum | `ACTIVE` \| `NEEDS_REAUTH` \| `REVOKED` \| `ERROR` |
| `last_sync_at`, `last_error` | | |

### `booking_calendar_links`

| Column | Notes |
|--------|-------|
| `booking_id` / `series_id` | One of the two |
| `connection_id` | Which connection owns the provider event |
| `provider_event_id` | The event in Google or Microsoft |
| `provider_instance_id` | For a single occurrence of a recurring series ([12 §8](12-recurrence.md#8-interaction-with-two-way-calendar-sync)) |
| `provider_etag` | For optimistic concurrency on writes |
| `last_pushed_hash` | Hash of what RoomBook last wrote — **this is the loop-prevention mechanism** |
| `sync_state` | `SYNCED` \| `PENDING` \| `FAILED` \| `DETACHED` |

### `rooms` addition

`provider_resource_email` — the room mailbox or resource calendar address, when mapped.

### `booking_attendees` additions

`response` is now genuinely used, populated from the provider. Add `responded_at`.

---

## 5. Sync mechanics

### Outbound (RoomBook → provider)

Reuses the outbox pattern, because the properties wanted are identical: transactional
enqueueing, retry, and durability across restarts.

1. A booking change writes a `calendar_sync_jobs` row **in the same transaction**.
2. `CalendarSyncWorker` (every 10 s) claims jobs atomically and calls the provider API.
3. On success it stores `provider_event_id`, `etag` and `last_pushed_hash`.
4. On failure it retries with backoff; after 5 attempts the booking is marked
   `sync_state = FAILED`, visible to the organizer and in the admin log, and **`.ics` is sent
   as a fallback** so the meeting still reaches people.

`sendUpdates` is set to `all` so the provider notifies attendees of changes — this is what
replaces RoomBook's own email for connected organizers.

### Inbound (provider → RoomBook)

**Push first, polling as a backstop.** Neither alone is reliable.

| Provider | Mechanism | Lifetime | Renewal |
|----------|-----------|----------|---------|
| Google | `events.watch` push channel → `POST /api/v1/webhooks/google` | ~7 days | `WebhookRenewalWorker`, hourly, renews anything expiring within 24 h |
| Microsoft | Graph subscription → `POST /api/v1/webhooks/microsoft` | ~3 days (calendars) | Same worker |

A webhook is only a **hint that something changed** — neither provider sends the actual
change reliably. On receipt RoomBook performs an **incremental sync** using the stored
`syncToken` / `deltaLink`, which returns exactly what changed since last time.

A reconciliation sweep runs every 6 hours over all `ACTIVE` connections regardless of
webhooks, because push notifications are lost occasionally and a silently desynchronized
calendar is worse than a slow one. A full resync runs when a sync token is rejected as stale.

### Loop prevention

RoomBook writes an event → the provider fires a webhook → RoomBook must not treat its own
write as a user edit and write again, forever.

Three defences, because one is not enough:

1. **`last_pushed_hash`.** Before processing an inbound change, hash the incoming event's
   salient fields. If it matches what RoomBook last wrote, ignore it.
2. **Extended properties.** Every event carries a private property
   `roombook_booking_id` and `roombook_revision`. An inbound event whose revision matches the
   current one is RoomBook's own echo.
3. **A short write-suppression window.** Inbound changes within 10 seconds of an outbound
   write to the same event are discarded.

---

## 6. OAuth and consent

### Scopes requested — minimum viable, and no more

| Provider | Scope | Why |
|----------|-------|-----|
| Google | `https://www.googleapis.com/auth/calendar.events` | Create and modify events. **Not** `calendar`, which would grant calendar-list and settings access |
| Google | `openid email` | Identify the linked account |
| Microsoft | `Calendars.ReadWrite` | Equivalent |
| Microsoft | `offline_access` | Refresh tokens |
| Microsoft | `User.Read` | Identify the linked account |

RoomBook never requests read access to the user's full calendar history, contacts, or mail.
It is worth being able to say this plainly to staff and to IT.

> **A note on free/busy lookup.** Showing a colleague's existing busy times while scheduling
> would need a broader scope (`calendar.readonly` or `Calendars.Read.Shared`). It is
> deliberately **not** in v1 — the privacy cost and the consent conversation are
> disproportionate to the benefit. It is in the backlog as an opt-in feature.

### Flow

Standard authorization code with **PKCE**, `state` bound to the session as CSRF protection,
and `prompt=consent&access_type=offline` on Google so a refresh token is actually issued.

```
/account/calendar → "Connect Google Calendar"
   → provider consent screen
   → GET /api/v1/calendar/callback/google?code&state
   → exchange code, encrypt and store tokens, create the webhook channel,
     run an initial sync, redirect back with a success banner
```

### Admin consent

- **Google Workspace:** an admin may need to allow the app in the Workspace Marketplace
  settings, or users will be blocked by "unverified app" or app-access controls.
- **Microsoft 365:** a tenant admin must grant consent for the app registration, or each user
  hits a consent prompt their tenant may forbid.

Both are **IT tasks with lead time**. They are on the launch checklist in
[09](09-configuration.md), and they are the most likely cause of a schedule slip on this
feature — Google's app verification in particular can take days to weeks if the app needs it.

---

## 7. Conflict resolution: who wins

The hardest part of any two-way sync. Each case is decided by the rule in section 1.

| Case | Resolution |
|------|-----------|
| User changes the **time** in Google, new slot is **free** | Accepted. RoomBook updates the booking, writes an audit row attributed to the user with source `CALENDAR_SYNC`, and notifies attendees |
| User changes the **time** in Google, new slot **clashes** | **Rejected.** RoomBook reverts the provider event to the booked time and emails the user: *"Your change could not be applied — Boardroom is booked at 14:00 by Sara Mengistu. The meeting remains at 09:00."* The room is RoomBook's to decide |
| User changes the **time** to outside the room's bookable hours | Rejected the same way, naming the rule |
| User changes **title or description** | Accepted and copied into RoomBook. Harmless |
| User **adds or removes attendees** | Accepted. The provider already notified them |
| User **deletes the event** in their calendar | Treated as a cancellation. The booking is cancelled, the room is freed, attendees are notified. This is almost always what the user meant |
| User **moves the event to a different calendar** | The link is marked `DETACHED`; RoomBook keeps the booking and falls back to `.ics`, and tells the user |
| **Admin moves the booking in RoomBook** | Always wins. The provider event is updated. This is the whole point of admin authority |
| Simultaneous edits on both sides | RoomBook wins; the provider write uses the stored `etag`, and a 412 triggers a re-read and a forced overwrite |
| Provider is down | Booking still succeeds. The sync job retries; after 5 failures, `.ics` fallback |
| User **revokes access** | Connection → `REVOKED`. Existing events are left in place, future bookings use `.ics`, and the user is told once |

**The principle to hold on to:** a user can lose a change they made in Google, but they can
never cause a double-booked room. The reverted change is always explained by email.

---

## 8. Security

This feature holds OAuth tokens to employees' calendars, which is the most sensitive data in
the system by some margin.

| Control | Decision |
|---------|----------|
| Token storage | AES-256-GCM encrypted at rest with `CALENDAR_TOKEN_KEY`, a key held **separately from the database** |
| Token in logs | Never. Access and refresh tokens are redacted by a Pino serializer, and the redaction is tested |
| Scope | Minimum necessary (section 6). No mail, no contacts, no calendar-wide read |
| Webhook authenticity | Google: validate the channel token and resource ID. Microsoft: validate `clientState` and the validation handshake. **Both: never trust the payload — always re-read via the API** |
| Webhook endpoint | Unauthenticated by necessity, so rate-limited, size-capped, and responding 200 immediately while queueing the work |
| Revocation | Disconnecting in RoomBook revokes the token at the provider, not just locally |
| Offboarding | Deactivating a user revokes their calendar connection immediately |
| Key rotation | `CALENDAR_TOKEN_KEY` supports two keys so tokens can be re-encrypted without forcing everyone to reconnect |
| Data residency | Meeting titles now travel to Google or Microsoft. For most organizations they are already there — but it must be stated explicitly in the privacy notice ([08 §7](08-security.md#7-data-protection)) |

---

## 9. User experience

### S-22 — Calendar connection (`/account/calendar`)

```
┌─────────────────────────────────────────────────────────┐
│  Calendar connection                                    │
│                                                         │
│  ✓ Connected to Google Calendar                         │
│    alice@acme.com · last synced 2 minutes ago           │
│                                                         │
│    Your bookings appear in your calendar automatically, │
│    and your guests are invited by Google.               │
│                                                         │
│    [ Sync now ]            [ Disconnect ]               │
└─────────────────────────────────────────────────────────┘
```

Disconnected state explains the benefit in one sentence and offers both providers.
`NEEDS_REAUTH` state is a prominent banner across the app, not a quiet note — a silently
broken sync is the worst outcome.

### Elsewhere

- **Booking detail** shows a small "In your Google Calendar ✓" line, or a sync warning.
- **Attendee list** shows live RSVP status once it flows back: *Bob Tesfaye — Accepted*.
- **Admin** gets `/admin/integrations`: connection health across the organization, failure
  counts, and room-resource mappings.

---

## 10. Failure modes, and what the user sees

| Failure | Behaviour | User-visible |
|---------|-----------|--------------|
| Provider API down | Jobs retry with backoff | Nothing, unless it persists; then a sync warning on the booking |
| Token expired | Silent refresh | Nothing |
| Refresh token revoked | Connection → `NEEDS_REAUTH`, `.ics` fallback resumes | A banner and one email |
| Rate limited (429) | Honour `Retry-After`, exponential backoff, per-connection queue | Nothing |
| Webhook channel expired without renewal | The 6-hourly reconciliation sweep catches the drift | Up to 6 hours of delay on inbound changes |
| Sync token rejected as stale | Full resync of that connection | Nothing |
| Provider event deleted externally by an admin | Link → `DETACHED`; booking retained | A note on the booking |
| **Anything at all** | **The booking itself always succeeds** | The room is never lost because an integration failed |

---

## 11. Test cases

| # | Case | Expected |
|---|------|----------|
| T-140 | Connected organizer creates a booking | A native event is created; **no `.ics` is emailed to anyone** |
| T-141 | Unconnected organizer creates a booking | `.ics` emailed as before; no provider call |
| T-142 | Organizer connected, booking created, then organizer disconnects | Existing event remains; the next booking uses `.ics` |
| T-143 | RoomBook writes an event and the webhook echoes it back | No second write — loop prevention holds (all three defences tested independently) |
| T-144 | User moves the event in Google to a free slot | Booking updated, audit row has source `CALENDAR_SYNC` |
| T-145 | User moves the event in Google to an occupied slot | Provider event reverted, user emailed, booking unchanged, **room not double-booked** |
| T-146 | User deletes the event in Google | Booking cancelled, room freed, attendees notified |
| T-147 | Admin moves the booking in RoomBook | Provider event updated within 10 s |
| T-148 | Provider returns 500 five times | Booking stands, `sync_state = FAILED`, `.ics` fallback sent |
| T-149 | Provider returns 429 | Backoff honoured; no job lost |
| T-150 | Refresh token revoked at the provider | Connection → `NEEDS_REAUTH`, banner shown, `.ics` resumes |
| T-151 | Webhook with an invalid `clientState` / channel token | Rejected, logged, no processing |
| T-152 | Webhook payload claiming a change that did not occur | Ignored — state comes from the API re-read, never the payload |
| T-153 | Recurring series pushed to the provider | One recurring event with the correct `RRULE` |
| T-154 | One occurrence moved | A provider **instance** update, not a new event ([12 §8](12-recurrence.md#8-interaction-with-two-way-calendar-sync)) |
| T-155 | Attendee accepts in Gmail | RSVP appears on the booking within one sync cycle |
| T-156 | Token encryption | Tokens are unreadable in a raw database dump; key rotation re-encrypts without reconnection |
| T-157 | Deactivating a user | Their calendar connection is revoked at the provider immediately |
| T-158 | Tokens in logs | A deliberate error path logs no token material |

---

## 12. Honest assessment

**What you gain:** meetings appear in people's real calendars with no extra step, external
guests get native invitations with working RSVP buttons, and — with room resources mapped —
the room is visibly busy to anyone scheduling from Outlook, which closes the loophole of people
bypassing RoomBook entirely.

**What it costs:**

1. **8–12 days of build**, and it is the most intricate work in the project.
2. **Ongoing maintenance that does not stop at launch.** Google and Microsoft change APIs,
   deprecate endpoints, and alter consent requirements. This is the one part of the system that
   will need attention in a year whether or not anyone touches the code.
3. **An IT dependency with lead time** — tenant admin consent on Microsoft, and potentially
   Google app verification. Start this during M2, not M6.
4. **A new class of support question**: "why is my calendar out of sync?" The admin
   integrations screen exists specifically so someone can answer it.
5. **Meeting titles leave your infrastructure** for Google or Microsoft. Usually already true,
   but it must be stated.

**My recommendation, now that it is specified:** build it, but build it **last** (M6), behind a
feature flag, with the `.ics` path fully working first. That way the integration can be enabled
for a handful of volunteers, then the organization, and can be switched off without anyone
losing the ability to book a room. The fallback design in section 3 makes that practical rather
than theoretical.
