# Meeting Room Booking System — Documentation

Version 1.3 (draft) · Last updated 2026-10-18 · Status: **awaiting sign-off before implementation**

This folder is the complete specification for the Meeting Room Booking System (internally
referred to as **RoomBook**). No application code is written yet; these documents define what
will be built.

**Architecture: a modular monolith.** Node.js + Express backend and a React 19 frontend, in one
repository with a shared schema package, built and deployed as a single process.
See [02-architecture.md](02-architecture.md).

**Estimate: 46–59 developer-days (~9–12 weeks).** See
[11-delivery-plan.md](11-delivery-plan.md) for the breakdown and three options for shipping
sooner.

### Changelog
- **1.3** — Decisions D3, D4, D6, D7, D8, D11, D12, D13, D17 resolved. Added the **approval
  workflow** ([15](15-approvals.md)) and **no-JavaScript display views**
  ([07 §8](07-ui-screens.md#8-display-views--the-no-javascript-path)); organizers may now end
  their own in-progress booking early; RoomBook email is organizer-only for v1; both calendar
  providers in scope. Estimate rose from 46–59 to **52–66 days**.
- **1.2** — Three features added: **recurring meetings** with full per-occurrence control
  ([12](12-recurrence.md)), **two-way calendar sync** with Google and Microsoft 365
  ([13](13-calendar-sync.md)), and **multiple locations** as a first-class concept with
  location-scoped admins ([14](14-multi-location.md)). All other documents updated to match.
  Estimate rose from 24–32 to **46–59 days**.
- **1.1** — Decision D1 resolved: Node + React monolith. Rewrote [02](02-architecture.md);
  updated the technology summary in [00](00-overview.md), the client routes and query keys in
  [05](05-api-spec.md), the component architecture in [07](07-ui-screens.md), the frontend
  security controls in [08](08-security.md), the build and Docker setup in
  [09](09-configuration.md), the component test layer in [10](10-testing.md), and the
  estimates in [11](11-delivery-plan.md) (now 24–32 days).
- **1.0** — Initial specification.

## Document index

| # | Document | What it covers | Primary audience |
|---|----------|----------------|------------------|
| 00 | [Project Overview](00-overview.md) | Problem, goals, scope, glossary, assumptions | Everyone |
| 01 | [Requirements](01-requirements.md) | Roles, user stories, functional & non-functional requirements | Everyone |
| 02 | [Architecture](02-architecture.md) | Monolith structure, backend + React stack, shared package, request flow | Developers |
| 03 | [Data Model](03-data-model.md) | Entities, ERD, schema, indexes, migrations | Developers |
| 04 | [Business Rules](04-business-rules.md) | Conflict detection, cancellation, moves, time handling | Everyone |
| 05 | [API Specification](05-api-spec.md) | Every endpoint, payloads, status codes, errors | Developers |
| 06 | [Email & Notifications](06-email-notifications.md) | Triggers, templates, outbox, calendar invites | Everyone |
| 07 | [UI & Screens](07-ui-screens.md) | Screen inventory, layouts, flows, states | Everyone |
| 08 | [Security & Privacy](08-security.md) | Auth, authorization matrix, threats, data handling | Developers, IT |
| 09 | [Configuration & Deployment](09-configuration.md) | Env vars, setup, backups, runbook | Developers, IT |
| 10 | [Testing Strategy](10-testing.md) | Test layers, critical cases, acceptance criteria | Developers, QA |
| 11 | [Delivery Plan](11-delivery-plan.md) | Milestones, estimates, out-of-scope backlog | Everyone |
| 12 | [Recurring Meetings](12-recurrence.md) | Series model, per-occurrence exceptions, the three edit scopes, DST | Everyone |
| 13 | [Calendar Integration](13-calendar-sync.md) | Two-way Google / Microsoft 365 sync, OAuth, conflict resolution | Developers, IT |
| 14 | [Multiple Locations](14-multi-location.md) | Locations as first-class, scoped admins, settings inheritance, timezones | Everyone |
| 15 | [Approval Workflow](15-approvals.md) | Rooms that need sign-off: holding slots, expiry, approvers | Everyone |

## How to review this

Read **00**, **01** and **04** if you are approving scope and behaviour.
Read **02**, **03**, **05** and **08** if you are reviewing the technical design.

Anything marked **[DECISION NEEDED]** is an open question that needs your answer before
implementation starts. A consolidated list of them is at the bottom of
[00-overview.md](00-overview.md#open-decisions).
