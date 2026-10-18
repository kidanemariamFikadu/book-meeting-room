# 09 — Configuration & Deployment

## 1. Environment variables

Parsed and validated by Zod in `src/config.ts` at boot. **A missing or malformed required
variable stops the process immediately** with a readable message — the system never starts in a
half-configured state where, for example, email silently does not send.

### Required

| Variable | Example | Notes |
|----------|---------|-------|
| `NODE_ENV` | `production` | `development` \| `test` \| `production` |
| `PORT` | `3000` | |
| `APP_URL` | `https://rooms.acme.com` | Used to build every link in every email. Getting this wrong breaks all of them |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/roombook` | `file:./dev.db` in development |
| `SESSION_SECRET` | 32+ random bytes, base64 | Rotating it logs everyone out |

### Email

| Variable | Default | Notes |
|----------|---------|-------|
| `MAIL_TRANSPORT` | `smtp` | `smtp` \| `console`. `console` is refused when `NODE_ENV=production` |
| `SMTP_HOST` | | Required when transport is `smtp` |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for port 465 implicit TLS |
| `SMTP_USER` / `SMTP_PASS` | | Omit both for an unauthenticated internal relay |
| `MAIL_FROM_NAME` | `Acme Rooms` | |
| `MAIL_FROM_ADDRESS` | `rooms@acme.com` | Must be a domain with SPF/DKIM configured |
| `MAIL_REPLY_TO` | | Optional global fallback; booking mail sets the organizer instead |

### Calendar integration ([13](13-calendar-sync.md))

| Variable | Default | Notes |
|----------|---------|-------|
| `CALENDAR_SYNC_ENABLED` | `false` | **Feature flag.** Ships off; enabled per organization after the `.ics` path is proven |
| `CALENDAR_TOKEN_KEY` | | 32-byte base64 AES-256-GCM key. **Stored outside the database.** Losing it forces every user to reconnect |
| `CALENDAR_TOKEN_KEY_PREVIOUS` | | Second key during rotation, so tokens re-encrypt without reconnection |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | | From Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `${APP_URL}/api/v1/calendar/callback/google` | Must match the registered URI **exactly** |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | | From the Entra ID app registration |
| `MICROSOFT_TENANT_ID` | `common` | A specific tenant ID locks sign-in to your organization |
| `MICROSOFT_REDIRECT_URI` | `${APP_URL}/api/v1/calendar/callback/microsoft` | |
| `CALENDAR_WEBHOOK_BASE_URL` | `${APP_URL}` | Must be **publicly reachable over HTTPS** — providers will not deliver to localhost |
| `CALENDAR_SYNC_POLL_MS` | `10000` | Outbound sync worker |
| `CALENDAR_RECONCILE_HOURS` | `6` | Backstop sweep when a webhook is missed |

> **Local development:** webhooks cannot reach `localhost`. Use a tunnel (`cloudflared`,
> `ngrok`) and set `CALENDAR_WEBHOOK_BASE_URL` to the tunnel URL, or leave
> `CALENDAR_SYNC_ENABLED=false` and work against the `.ics` path, which is the default.

### Recurrence ([12](12-recurrence.md))

| Variable | Default | Notes |
|----------|---------|-------|
| `RECURRENCE_HORIZON_DAYS` | `365` | How far ahead occurrences materialize |
| `RECURRENCE_MAX_OCCURRENCES` | `500` | Hard ceiling per series |

### Optional

| Variable | Default | Notes |
|----------|---------|-------|
| `TZ` | `UTC` | **Leave as UTC.** Display zones come from the data, not the host clock |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `OUTBOX_POLL_MS` | `15000` | |
| `REMINDER_POLL_MS` | `60000` | |
| `WORKERS_ENABLED` | `true` | Set `false` on extra instances to keep workers single-instance (A6) |
| `TRUST_PROXY` | `1` | Hops to trust for the client IP behind a load balancer |
| `RATE_LIMIT_DISABLED` | `false` | Test use only; refused in production |

### A note on client-side configuration

The React client needs **no environment variables**. It calls `/api/v1/...` relatively, on its
own origin, so there is no API base URL to configure and no build-time branching between
environments. Anything prefixed `VITE_` is **embedded in the JavaScript bundle and publicly
readable** — no secret ever goes there. The one exception is `VITE_DEV_MAILBOX=true`, set only
in development to expose S-21.

`.env.example` ships with every name present and dummy values, so a new developer can copy it
and be running in a minute.

## 2. Local development

```bash
git clone <repo> && cd book-meeting-room
npm install                   # installs all three workspaces: shared, server, client
cp .env.example .env          # defaults use SQLite and the console mailer
npx prisma migrate dev        # create the database and apply migrations
npm run seed                  # demo org, rooms, users, bookings
npm run dev                   # API on :3000, Vite on :5173 — open http://localhost:5173
```

In development there are **two processes**: Express on `:3000` and the Vite dev server on
`:5173`. Vite proxies `/api` to `:3000`, so the browser sees a single origin and session
cookies behave exactly as they will in production. In production there is **one** process
serving both on one port.

Sign in as `owner@acme.test`, `admin@acme.test` or `alice@acme.test`, password
`Password123!`. **No SMTP credentials are needed** — every email the system would send appears
at `http://localhost:5173/dev/emails`, fully rendered, including its `.ics`.

### Scripts

| Script | Does |
|--------|------|
| `npm run dev` | `concurrently`: `dev:server` + `dev:client` |
| `npm run dev:server` | `tsx watch` on `server/`, workers running |
| `npm run dev:client` | `vite` dev server with the `/api` proxy |
| `npm run build` | `build:shared` → `build:client` → `build:server` → `build:email` |
| `npm run build:shared` | `tsc` the shared workspace (must run first — both others import it) |
| `npm run build:client` | `vite build` → `client/dist` |
| `npm run build:server` | `tsc` the server workspace → `server/dist` |
| `npm run build:email` | Compile MJML templates to HTML |
| `npm start` | `node server/dist/index.js` — one process, API + bundle |
| `npm run typecheck` | `tsc --noEmit` across all three workspaces |
| `npm test` | Unit, integration and component tests |
| `npm run test:e2e` | Playwright against a built app |
| `npm run lint` / `npm run format` | ESLint (incl. boundary rules) / Prettier |
| `npm run seed` / `npm run seed:reset` | Seed / wipe and reseed |
| `npm run db:studio` | Prisma Studio |
| `npm run bootstrap-owner` | **Production**: interactively create the first owner account |

Build order matters: `shared/` compiles first because both `client/` and `server/` import its
types and Zod schemas.

### Prod-like local run

`docker compose up` starts PostgreSQL 16 and [Mailpit](https://mailpit.axllent.org/) (an SMTP
server with a web inbox at `:8025`). Point `DATABASE_URL` at the container and
`SMTP_HOST=localhost SMTP_PORT=1025` to exercise the **real** SMTP path, the real exclusion
constraint, and real `.ics` delivery before going anywhere near production.

## 3. Deployment

### Container

A multi-stage `Dockerfile` producing **one image containing both halves of the monolith**:

```dockerfile
# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci                       # all workspaces
COPY . .
RUN npx prisma generate && npm run build     # shared → client → server → email

# ---- runtime ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=UTC
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/server/dist   ./server/dist
COPY --from=build /app/client/dist   ./client/dist     # the React bundle
COPY --from=build /app/shared/dist   ./shared/dist
COPY --from=build /app/prisma        ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
USER node
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:3000/healthz || exit 1
CMD ["node", "server/dist/index.js"]
```

The built React bundle ships *inside* the server image. There is no separate web host, no CDN
to configure and no chance of the client and API being on mismatched versions.

**Static asset serving** (`server/src/static.ts`): `/assets/*` is served with
`Cache-Control: public, max-age=31536000, immutable` because Vite content-hashes every
filename; `index.html` is served `no-cache`; and any path that is neither `/api/*` nor an
existing file falls back to `index.html` so that deep links such as `/bookings/abc` survive a
hard refresh.

### Start sequence

1. `prisma migrate deploy` applies pending migrations.
2. Configuration is validated; the process exits non-zero on any problem.
3. The database connection is verified.
4. The HTTP listener starts.
5. The workers start if `WORKERS_ENABLED` is true.
6. `/readyz` begins reporting ready.

### Shutdown

On `SIGTERM`: stop accepting connections, let in-flight requests finish (15 s grace), let the
current outbox batch complete, disconnect Prisma, exit. The atomic outbox claim means a
worker killed mid-batch leaves rows in `SENDING`, which are returned to `QUEUED` after 10
minutes — no mail is lost and none is sent twice.

### Reverse proxy

Nginx or Caddy terminates TLS and forwards to the app. Required headers:
`X-Forwarded-For`, `X-Forwarded-Proto`, `Host`. Set `TRUST_PROXY` to match, or the rate
limiter will see every request as coming from the proxy.

### Sizing

For assumption A1 (≤ 500 users, ≤ 50 rooms): 1 vCPU and 512 MB of RAM for the app, plus a small
managed PostgreSQL instance. This is a modest workload; the database will be idle most of the
day.

## 4. Backup and restore

| Item | Policy |
|------|--------|
| Database | Nightly `pg_dump` at 02:00, 30 daily retained, plus a monthly kept for 12 months |
| Storage | Off the application host — object storage or a different machine |
| Encryption | Encrypted at rest; the key is not stored alongside the backup |
| Uploads (room photos) | Backed up with the same schedule |
| **Restore rehearsal** | **Quarterly, restoring to a scratch host and signing in.** A backup that has never been restored is a hypothesis, not a backup |
| RPO / RTO | 24 h / 4 h — appropriate for an internal scheduling tool, but confirm it suits you |

Restore drill:

```bash
createdb roombook_restore_test
pg_restore -d roombook_restore_test backup-2026-11-04.dump
DATABASE_URL=postgresql://…/roombook_restore_test npm start
# sign in, open the calendar, open a booking, confirm history is present
```

## 5. Operational runbook

| Symptom | First checks | Likely fix |
|---------|--------------|------------|
| A user got the meeting **twice** in their calendar | Whether the organizer is connected; whether an `.ics` was also sent for that booking | A `useNativeInvites` bug — the single most important thing to get right ([06 §1b](06-email-notifications.md#1b-when-roombook-does-not-send-email)) |
| Calendar changes stopped flowing in | `calendar_connections.webhook_expires_at`; renewal worker logs | Expired channel. The 6-hourly reconcile should have caught it — check that worker is running |
| A user says their calendar edit "didn't work" | Whether they received `calendar_change_rejected` | Working as designed: the room was taken and RoomBook reverted it ([13 §7](13-calendar-sync.md#7-conflict-resolution-who-wins)) |
| Everyone needs to reconnect their calendar | Whether `CALENDAR_TOKEN_KEY` changed | Restore the previous key, or set it as `CALENDAR_TOKEN_KEY_PREVIOUS` |
| A recurring series is missing future dates | `booking_series.horizon_until`; `SeriesHorizonWorker` logs | The horizon worker is not running, or the series hit the 500-occurrence ceiling |
| A standup shifted by an hour after a clock change | Whether the series stores `dtstart_local` + duration, or a UTC start | A recurrence DST bug — T-120/T-121 should have caught it |
| A location admin cannot act on a booking | `user_location_access` rows; the room's location | Working as designed (BR-L1), or the grant is missing |
| Nobody receives email | `/admin/emails` for `FAILED` rows and `last_error`; `MAIL_TRANSPORT`; SMTP credentials; relay reachability | Fix credentials and use Resend on the failed rows |
| Email is slow | Oldest `QUEUED` age; worker logs; `WORKERS_ENABLED` | Confirm exactly one instance has workers enabled |
| Email lands in spam | SPF, DKIM, DMARC records; sending domain matches `MAIL_FROM_ADDRESS` | Fix DNS; warm the domain gradually |
| "Room already booked" when it looks free | Compare the viewer's timezone with the room's; look for a cancelled-but-visible stale page | Usually a stale page — reload. If genuinely wrong, it is a bug; capture the request ID |
| Times are off by an hour | Host `TZ`; the location's timezone; whether a DST transition just occurred | `TZ` must be `UTC`; fix the location zone |
| Users logged out unexpectedly | Whether `SESSION_SECRET` changed; session table size; recent deploy | Keep the secret stable across deploys |
| Login locked out | `users.locked_until` | Wait 15 minutes, or an owner clears the lock |
| Migration fails on deploy | Migration log; whether a previous deploy half-applied | Restore the pre-migration backup, fix the migration, redeploy |
| High CPU | Slow query log; availability queries over wide ranges | Confirm the indexes in [03](03-data-model.md#5-indexes) exist |

### Monitoring

| Signal | Alert when |
|--------|-----------|
| `/healthz` | Fails twice in a row |
| `/readyz` | Fails for 2 minutes |
| Oldest `QUEUED` outbox row | Older than 5 minutes |
| `FAILED` outbox rows | Any in the last hour |
| HTTP 5xx rate | Above 1% over 5 minutes |
| p95 latency | Above 1 s over 10 minutes |
| Disk | Above 80% |

## 6. First-run checklist for a new organization

> **Start the IT dependencies early.** Google Workspace app approval and Microsoft tenant admin
> consent have **lead times measured in days or weeks**, and Google may require app
> verification. Begin these during M2, not at launch — they are the most likely cause of a
> slipped date ([13 §6](13-calendar-sync.md#admin-consent)).

1. Deploy with configuration set; confirm `/healthz` and `/readyz`.
2. `npm run bootstrap-owner` to create the first owner account interactively — no seeded
   passwords in production.
3. Sign in; set organization name, timezone, business hours and reminder lead time.
4. Create **locations** — name, address, timezone, country, working days — then room features,
   then rooms. Assign location admins if you run more than one site.
5. Add each location's holiday calendar before anyone books a recurring meeting.
5. Send a test invitation to yourself; confirm the email arrives, looks right, and the link works.
6. Make a test booking; confirm the confirmation email and that the `.ics` opens correctly in
   the organization's calendar client.
7. Move the test booking as an admin; confirm the move email shows before and after, and that
   the calendar entry **updates rather than duplicating**.
8. Cancel it; confirm the cancellation email and that the entry leaves the calendar.
9. Invite the real staff in batches, not all at once — a bad `APP_URL` discovered after 300
   invitations is a bad morning.
10. Confirm backups ran and rehearse one restore.
11. **Calendar sync, last and gradually.** Leave `CALENDAR_SYNC_ENABLED=false` through initial
    rollout so everyone is on the proven `.ics` path. Then enable it and connect **your own**
    calendar first; verify a booking appears, a move updates it in place rather than
    duplicating, and a cancellation removes it. Then a handful of volunteers. Then everyone.
    It can be switched off at any point without anyone losing the ability to book a room.
