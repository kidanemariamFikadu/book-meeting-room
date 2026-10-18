# 11 — Delivery Plan

## 1. Milestones

Estimates assume one developer working steadily. They are ranges, not commitments, and they
include writing the tests listed in [10-testing.md](10-testing.md) — tests are part of each
milestone, not a phase at the end.

### M0 — Foundations · 2–3 days
**Monorepo**: npm workspaces for `shared`, `server`, `client`. TypeScript strict in all three,
ESLint with the boundary rules, Prettier, Vitest. Express skeleton with config validation and
`/healthz` / `/readyz`. Vite + React 19 skeleton with the `/api` dev proxy, React Router,
TanStack Query provider, design tokens and the `ui/` primitives. The shared Zod schemas and
`can()`. Prisma with the full schema from [03](03-data-model.md), the first migration
**including the PostgreSQL exclusion constraint**, the seed script. Docker Compose with
PostgreSQL and Mailpit. The production static-serving and SPA fallback — built and verified in
M0, not discovered at M5. CI running.

**Done when:** `npm run dev` serves a styled React shell talking to Express, `npm run build`
followed by `npm start` serves the same app from one process, the schema is migrated, and CI
is green.

### M1 — Authentication and users · 4–5 days
*Server:* Argon2id hashing, sessions, login, logout, rate limiting and lockout, invitations,
invitation acceptance, forgotten and reset password, CSRF, security headers.
*Client:* the typed fetch wrapper (CSRF header, 401 handling, error parsing), `useAuth`,
`RequireAuth` / `RequireRole`, `AppShell` and navigation, the auth pages, account page, and the
owner's user-management table.
*Shared:* the permission matrix, used by both.
Screens S-01…S-04, S-10, S-16. Tests T-50…T-60, T-90…T-97, T-113, T-114.

**Done when:** an owner can invite a user who sets their own password and signs in, and every
authorization test passes.

### M2 — Rooms and configuration · 4–5 days
Locations, features, rooms with capacity, floor, colour and photo, bookable hours, per-room
limits, closures, activate and deactivate with the future-bookings guard, organization
settings.
Screens S-11, S-12, S-17. Tests T-44…T-47.

**Done when:** an admin can configure the organization's real rooms, and the data is correct
enough to build the calendar on.

### M3 — Booking engine · 7–9 days · **the core of the project**
*Server:* `AvailabilityService` and `BookingService`, the full rule set from
[04](04-business-rules.md), transactional conflict detection, move, cancel, transfer, the
audit log, the suggestions endpoint.
*Client:* **`CalendarGrid`** (the single largest component — grid layout, pointer
drag-selection, the full keyboard contract, the narrow-screen stacked variant), `BookingForm`
with live availability, `ConflictPanel`, `AttendeePicker`, `MoveDialog`, `CancelDialog`, the
room finder, my-bookings, booking detail with history, the admin bookings table.
Screens S-05…S-09, S-13, S-14, S-15, S-19. Tests T-01…T-23, T-30…T-43, T-100…T-112.

**Done when:** T-20 passes — 50 parallel attempts on one slot yield exactly one booking — an
admin can move a booking between rooms with a reason recorded, and the grid updates itself
afterwards without a manual refresh.

> This milestone carries most of the project's risk. `CalendarGrid` alone is 2–3 days of the
> estimate, and its keyboard and screen-reader behaviour is the part most likely to be
> underestimated. Build it early in the milestone, not last.

### M2b — Approval workflow · 3–4 days
Activates `requires_approval`: the `PENDING_APPROVAL` → `CONFIRMED`/`REJECTED`/`EXPIRED`
lifecycle, the revised exclusion-constraint predicate, pending bookings holding their slot,
the expiry worker, named approvers, approve-and-move, signed single-use approve/reject links
in email, and the admin approval queue.
Screens S-29, plus changes to S-05, S-07, S-08, S-12. Tests T-180…T-196.

**Done when:** a pending request blocks the slot, expires cleanly if nobody acts, and an admin
can approve from the email without signing in.

> Placed right after rooms (M2) because it changes the booking status enum and the exclusion
> constraint. Doing it after the booking engine would mean reworking conflict detection.

### M3b — Multiple locations · 3–4 days
Locations as a full settings level with three-tier inheritance, per-location working days,
timezones and holidays, location-scoped admin grants, the location switcher, dual-timezone
display, cross-location search, and the locations admin screen.
Screens S-23, plus changes to S-05, S-06, S-07, S-11, S-13, S-16.
Tests T-160…T-172.

**Done when:** a London admin cannot move an Addis booking, a Dubai location works Sunday to
Thursday, and a cross-timezone booking shows both times everywhere it appears.

> Scheduled **immediately after** the booking engine and **before** recurrence, because
> recurrence has to evaluate rules in a location timezone and skip a location's holidays.
> Doing it the other way round means rewriting the recurrence engine.

### M3c — Display views (no-JavaScript) · 3 days
The server-rendered read-only path at `/display/*`: room display, location display, signed
revocable display tokens, title-hiding by default, meta-refresh auto-update, and the admin
screen for creating and revoking displays.
Screens S-30, S-31, S-32. Tests T-200…T-206.

**Done when:** a door-mounted terminal with JavaScript fully disabled shows the room's current
and upcoming bookings, updates itself, and reveals no meeting titles.

### M4 — Notifications · 3–4 days
The `Mailer` interface and its three implementations, the outbox worker with retry and the
orphan sweep, all sixteen templates in MJML plus plain text, `.ics` generation with correct
`UID`, `SEQUENCE` and `METHOD`, the reminder worker, the admin email log with resend, the dev
mailbox.
Screens S-18, S-21. Tests T-70…T-82.

**Done when:** a move produces a correct email in Outlook and Gmail whose calendar attachment
**updates** the existing entry rather than duplicating it.

### M4b — Recurring meetings · 8–10 days
*Server:* the `booking_series` model, RRULE parsing and expansion with DST-correct local-time
semantics, materialization with a rolling horizon, the dry-run preview with per-occurrence
conflict reporting, the three edit scopes (`THIS_OCCURRENCE`, `THIS_AND_FOLLOWING`,
`ENTIRE_SERIES`), exception preservation, the horizon worker, series-aware email, and `.ics`
with `RRULE` and `RECURRENCE-ID`.
*Client:* the recurrence editor with a live plain-English summary, the conflict-preview modal
with per-date resolution, the scope chooser, series detail, and series-grouped rows in the
admin resolution lists.
Screens S-25…S-28. Tests T-120…T-134, journey E-11.

**Done when:** a weekly standup survives a clock change at 09:00 local, an admin can move one
occurrence without disturbing the rest, and creating a 52-week series sends exactly one email.

> The hardest milestone in the project. The preview-then-confirm flow is not optional polish —
> without it, a series silently missing three weeks is a meeting people miss.

### M4c — Two-way calendar sync · 10–12 days
*Server:* OAuth with PKCE for Google and Microsoft, encrypted token storage with rotation,
the outbound sync queue, webhook endpoints with authenticity validation, incremental sync via
sync tokens and delta links, the renewal and reconciliation workers, three-layer loop
prevention, inbound conflict resolution with revert-and-notify, RSVP ingestion, room-resource
mapping, and the `.ics` fallback path on every failure mode.
*Client:* the connection screen, reauth banner, sync status on bookings, live RSVP display,
and the admin integrations health screen.
Screens S-22, S-24. Tests T-140…T-158, journeys E-13, E-14.

**Done when:** a connected organizer's booking appears natively with **no `.ics` sent**, an
admin move updates the provider event in place, a calendar-side change into an occupied slot
is reverted and explained, and disabling the feature flag returns everyone to a fully working
`.ics` path.

> **Built last and behind `CALENDAR_SYNC_ENABLED`**, so it can be rolled out to volunteers
> first and switched off without anyone losing the ability to book a room. **Begin the Google
> and Microsoft admin-consent paperwork during M2** — it has a lead time measured in days to
> weeks and is the most likely cause of a slipped date.

### M5 — Hardening and launch · 4–6 days
Accessibility pass with axe and a keyboard and screen-reader review, responsive pass at 360 px,
Playwright journeys E-01…E-10 **against the built artifact**, bundle-size budget and code
splitting of the admin routes, load testing at realistic data volumes, the index review, the
cleanup worker and retention, logging and metrics, the security checklist in
[08](08-security.md#8-pre-launch-security-checklist), the backup and restore rehearsal, the
Dockerfile and deployment, the admin user guide, and the first-run walkthrough with the real
office admin.

**Done when:** every item on the pre-launch checklist is ticked and the office admin has moved
a real booking unaided.

### Totals

| Milestone | Low | High |
|-----------|----:|-----:|
| M0 Foundations (monorepo, both halves) | 2 | 3 |
| M1 Auth and users | 4 | 5 |
| M2 Rooms | 4 | 5 |
| **M2b Approval workflow** (D4) | **3** | **4** |
| M3 Booking engine | 7 | 9 |
| **M3b Multiple locations** | **3** | **4** |
| **M3c Display views, no-JS** (D11) | **3** | **3** |
| M4 Notifications | 3 | 4 |
| **M4b Recurring meetings** | **8** | **10** |
| **M4c Two-way calendar sync**, both providers (D13) | **10** | **12** |
| M5 Hardening and launch | 5 | 7 |
| **Total** | **52 days** | **66 days** |

Roughly **10½ to 13 weeks** for one developer.

### How the estimate got here

| Version | Scope added | Estimate |
|---------|-------------|----------|
| v1.0 | Server-rendered, single site, no recurrence, `.ics` only | 18–26 days |
| v1.1 | + React monolith | 24–32 days |
| v1.2 | + multi-location, + recurrence, + two-way sync | 46–59 days |
| **v1.3** | **+ approvals (D4), + no-JS display views (D11)** | **52–66 days** |

Three of these decisions reduce nothing and add six days; one — D12, keeping calendar sync in
v1 — declined the only large saving on offer. That is a legitimate choice for a product meant
to be complete at launch, but it means **there is now no slack in the plan**. The remaining
reduction options are listed below and I would not expect to use them unless something slips.

### Reductions still available, if needed later

| Option | Saves | Cost of taking it |
|--------|-------|-------------------|
| Defer calendar sync to a follow-on release | 10–12 days | You said no (D12); still the single largest lever if a date becomes fixed |
| Build one calendar provider first | ~4 days | You said both (D13); could still be staged — Google first, Microsoft four weeks later |
| Reduce recurrence to series-plus-skip | 3–4 days | Loses per-occurrence moves, which is the feature you specifically asked for |
| Defer approvals to a follow-on | 3–4 days | Easy to add later; nothing else depends on it except the status enum |

**My recommendation if you need a date:** stage the two calendar providers rather than cutting
anything. Google and Microsoft share the same abstraction, so shipping the second one later is
close to free in rework and takes ~4 days off the critical path.

Add the optional items below only if you want them; they are excluded from that total.

| Optional in v1 | Extra |
|----------------|-------|
| Utilization reports and CSV export (US-P1, US-P2) | 2 days |
| Room photos with upload and resizing (US-R8) | 1 day |
| Private bookings (US-B11) | 1 day — recommended, it is cheap and prevents a real privacy problem |
| Approval workflow (D4) | 3 days |
| Free/busy lookup of colleagues while scheduling | 3 days — needs a broader calendar scope; see [13 §6](13-calendar-sync.md#scopes-requested--minimum-viable-and-no-more) |

## 2. Critical path and risks

```
M0 ──▶ M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M5
              └── M3 is the risk concentration ──┘
```

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Timezone and DST bugs found late | High | High | Timezone helpers and their tests are written in M0, before any booking code exists. `TZ=UTC` enforced, and T-34 proves nothing depends on the host zone |
| Concurrency bug ships silently | Medium | High | The exclusion constraint goes in the **first** migration, and T-20 runs in CI from M3 onward, so a regression cannot pass review |
| Calendar emails duplicate instead of updating | High — this is the single most common failure in booking systems | Medium | Stable `UID` and incrementing `SEQUENCE` designed in from the start ([06](06-email-notifications.md#4-calendar-attachments-ics)); verified manually in four real mail clients at M4 |
| Email lands in spam | Medium | High — users stop trusting it | SPF/DKIM/DMARC on the launch checklist, owned by IT, started during M4 rather than discovered at launch |
| **`CalendarGrid` accessibility and keyboard behaviour prove harder than estimated** | **High** | Medium | There is no server-rendered fallback now, so this must be right. Radix primitives handle dialogs and menus; the grid's keyboard contract is specified up front in [07 §7](07-ui-screens.md#calendargrid--the-one-hard-component) and tested (T-108, T-109); build it first in M3, not last |
| Client and server validation drift apart | Low | Medium | Structurally prevented: one Zod schema in `shared/` serves both. This is the main reason for the monorepo |
| Bundle grows quietly | Medium | Low | A CI size budget (gate 10 in [10](10-testing.md#6-quality-gates-in-ci)); admin routes lazy-loaded |
| Production-only bug in static serving or SPA deep links | Medium | Medium | The production serving path is built in **M0** and E2E runs against the built artifact, not the dev server |
| **Google app verification or Microsoft tenant consent takes weeks** | **High** | **High — blocks M4c entirely** | Start the paperwork in **M2**, not M4c. Build against sandbox tenants meanwhile. The feature flag means launch does not wait for it |
| **Recurrence DST bugs** | High | High | Series store local start + duration, never a UTC start. T-120/T-121 run in CI from the first day of M4b, and the seed data contains a series that straddles a transition |
| **Sync loop writes thousands of events** | Medium | **Severe — could spam every attendee** | Three independent defences ([13 §5](13-calendar-sync.md#loop-prevention)), each tested alone; a per-connection write rate cap as a circuit breaker |
| **Double invitations** (both `.ics` and native) | **High if not designed for** | High — users lose trust immediately | One decision point, stored per booking; T-140 and US-C6 |
| Provider API changes after launch | Medium | Medium | Ongoing maintenance that does not stop at launch — budget for it. Stated plainly in [13 §12](13-calendar-sync.md#12-honest-assessment) |
| **Scope growth beyond this plan** | **High** | **High** | The scope has already roughly doubled once. Treat 46–59 days as the ceiling and use the reduction options above rather than adding to it |
| SQLite and PostgreSQL behave differently | Medium | Medium | Concurrency tests run against PostgreSQL in CI; Docker Compose offers a prod-like local stack |
| Organization cannot supply SMTP | Low | Medium | `ConsoleMailer` means development and demos are never blocked; switching to Resend is one file (D2) |

## 3. What you need to provide

| When | What |
|------|------|
| Before M0 | ~~D1~~ — **resolved: Node + React monolith.** Confirm the assumptions in [00](00-overview.md#7-assumptions) |
| Before M2b | **Which rooms actually require approval**, and who approves each (D20). Keep the list short — see [15 §10](15-approvals.md#10-cost-and-caution) |
| Before M3c | Where the display terminals go, and whether any of them is in a **public** area (that decides D21) |
| Before M2 | The real list of rooms: name, location, capacity, floor, equipment |
| Before M2 | Business hours, how far ahead staff may book, maximum meeting length |
| **During M2 — start now, long lead time** | **Google Workspace app approval and/or Microsoft Entra tenant admin consent** ([13 §6](13-calendar-sync.md#admin-consent)). This is the single most likely thing to delay the project |
| Before M3b | Your list of **locations**: name, address, timezone, country, working days, and who administers each |
| Before M3b | Each location's holiday calendar, or confirmation that the country default is fine |
| Before M4c | Which provider(s) you actually use — building only one saves ~4 days |
| Before M4c | Whether you want room-resource mapping, and the resource addresses if so |
| During M4 | SMTP credentials, or a decision on Resend/SendGrid (D2); and the DNS access to set SPF/DKIM/DMARC |
| During M4 | Answers to D6 (attendee emails) and D7 (reminder lead time) |
| Before M5 | The hosting target: your own server, a VPS, or a container platform |
| Before M5 | The organization logo and the name to use in emails |
| At M5 | An hour of the office admin's time to walk through the real flows |

## 4. Suggested review points

Rather than disappearing for five weeks:

| Point | What you will see |
|-------|-------------------|
| End of M1 | Sign in as yourself with an account you were invited to |
| End of M2 | Your real rooms configured in the system |
| **Middle of M3** | The calendar grid with real rooms — **the most valuable review point**, because the booking flow is still cheap to change here |
| End of M3 | Make a booking, and move one as an admin |
| End of M4 | Real emails in your own inbox |
| End of M5 | Launch rehearsal |

## 5. Post-v1 backlog

Roughly in the order I would argue for them.

| Priority | Item | Why |
|----------|------|-----|
| 1 | **SSO / OIDC** | Removes a password, and makes offboarding automatic. Natural companion to the OAuth work already done in M4c |
| 2 | **Two-factor authentication** | Closes the main gap in [08](08-security.md#9-known-limitations-of-v1) |
| 3 | **Check-in and auto-release** | A booked room nobody shows up to is worse than no system. Release after 10 minutes without check-in — this is where the real utilization gain lives |
| 4 | **Free/busy lookup while scheduling** | "When are all five of us free?" Needs a broader calendar scope, hence opt-in |
| 5 | **Booking from within Outlook / Google** | With room resources mapped, the remaining step is an add-in |
| 6 | **Approval workflow** (D4) | For the boardroom and other premium rooms |
| 7 | **Slack or Teams notifications** | Faster than email for same-day changes |
| 8 | **Utilization dashboard** | Evidence for "we need more rooms" or "that room is never used" |
| 9 | **Room display tablets** | Shows the schedule outside the door with a check-in button |
| 10 | **Waitlist** | "Tell me if the boardroom frees up at 14:00" |
| 11 | **Desk and resource booking** | The same engine generalizes to desks, parking and equipment |
| 12 | **Multi-tenancy** | Already scoped by `organization_id`; needed only if this becomes a product |
| 13 | **Localization** | Needed if staff are not all comfortable in English |

## 6. Immediate next steps

1. **You review these documents**, particularly [01-requirements.md](01-requirements.md) and
   [04-business-rules.md](04-business-rules.md) — those two define what the product does.
2. **You answer the remaining open decisions** in
   [00-overview.md](00-overview.md#9-open-decisions). D1 is resolved — nothing now blocks a
   start. D2 (email transport) is needed by M4; the rest can be settled as we reach them.
3. **You send the real room list** so M2 configures the actual office rather than demo data.
4. I begin M0, and we review at the end of each milestone.
