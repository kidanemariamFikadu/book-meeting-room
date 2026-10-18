# RoomBook

A meeting room booking system for a single organization with multiple sites.

Employees sign in, see which rooms are free, and book them. Office admins configure rooms and
can move or cancel any booking, with a reason that reaches the organizer by email. Bookings
sync two-way with Google Calendar and Microsoft 365.

> **Status: M0 — scaffolding.** The full specification is agreed and lives in
> [`docs/`](docs/README.md). Start there: it is the source of truth, and the code follows it.

## Documentation

| Read this | If you are |
|-----------|------------|
| [docs/README.md](docs/README.md) | New here — it indexes all 17 documents |
| [docs/01-requirements.md](docs/01-requirements.md) · [docs/04-business-rules.md](docs/04-business-rules.md) | Deciding what the product does |
| [docs/02-architecture.md](docs/02-architecture.md) · [docs/03-data-model.md](docs/03-data-model.md) · [docs/05-api-spec.md](docs/05-api-spec.md) | Writing code |
| [docs/11-delivery-plan.md](docs/11-delivery-plan.md) | Tracking progress |

## Quick start

Requires **Node.js 22+** and **Docker** (for PostgreSQL).

```bash
npm install
cp .env.example .env
npm run docker:up          # PostgreSQL + Mailpit
npm run db:migrate         # apply migrations
npm run seed               # demo organization, rooms, users, bookings
npm run dev                # API on :3000, web on :5173
```

Then open <http://localhost:5173> and sign in as `owner@acme.test` / `Password123!`.

Email needs no credentials in development: everything the system would send is captured and
viewable at <http://localhost:8025> (Mailpit), and `/dev/emails` in the app.

Or in one step: `npm run setup`.

## Layout

```
shared/     Zod schemas, types and the permission matrix — imported by BOTH sides
server/     Express 5: JSON API, services, workers, server-rendered display views
client/     React 19 + Vite SPA
prisma/     Schema, migrations, seed
docs/       The specification
```

`shared/` is the point of the monorepo: one Zod schema validates the request on the server and
the form in the browser, so the contract cannot drift. See
[docs/02-architecture.md](docs/02-architecture.md#the-shared-package--why-this-is-the-real-win).

## Commands

| Command | Does |
|---------|------|
| `npm run dev` | Server and client together, both watching |
| `npm run build` | Build all three workspaces (shared first — the others import it) |
| `npm start` | Run the built app as one process |
| `npm run typecheck` | `tsc` across all workspaces |
| `npm test` | Unit, integration and component tests |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm run db:migrate` / `db:deploy` / `db:studio` / `db:reset` | Prisma |
| `npm run seed` | Reseed demo data (refuses to run in production) |

## Working on this

### Branches

`main` is always releasable. Work happens on short-lived branches merged by pull request.

```
feat/booking-conflict-detection
fix/dst-recurrence-drift
docs/clarify-approval-expiry
chore/bump-prisma
```

### Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`.

Types: `feat` · `fix` · `docs` · `refactor` · `test` · `chore` · `perf` · `build` · `ci`

Write the subject in the imperative, under 72 characters. **Explain the why in the body** —
the diff already shows the what. Where a change implements or changes a specified rule, cite
its ID (`BR-M2a`, `US-C6`, `T-140`) so the code and the specification stay connected.

```
feat(booking): hold the slot while an approval is pending

A pending request now participates in the exclusion constraint, so nobody
can book over a room that is awaiting a decision (BR-A2). Without this,
requesters wait a day and then lose the room anyway.

Pairs with the expiry worker so a forgotten request cannot sterilize the
room indefinitely.
```

### Before opening a pull request

```bash
npm run typecheck && npm run lint && npm test
```

CI enforces the gates in [docs/10-testing.md](docs/10-testing.md#6-quality-gates-in-ci),
including coverage of `shared/` and `server/src/services/`, the layering rules, and a client
bundle-size budget.

### Specification changes

The docs are the contract. If the code needs to diverge from them, **change the document in
the same pull request** — a spec that quietly stops matching the code is worse than no spec.
Decisions belong in the table in
[docs/00-overview.md](docs/00-overview.md#9-open-decisions).

## Licence

Proprietary — internal use.
