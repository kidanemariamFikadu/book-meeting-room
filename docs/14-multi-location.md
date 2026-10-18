# 14 — Multiple Locations

> **Change from v1.0:** locations are now **first-class**. The original spec had a `locations`
> table but treated the organization as effectively single-site. Multi-site is now a core
> assumption that shapes permissions, settings, timezones and the UI.

---

## 1. What changes

| Area | Single-site (v1.0) | Multi-site (v1.2) |
|------|--------------------|-------------------|
| Locations | A label on a room | An entity with its own address, timezone, business hours, settings and admins |
| Admin role | Organization-wide | **Scopable to specific locations** |
| Settings | Organization only | Organization → **location** → room, three-level inheritance |
| Timezone | Effectively one | Genuinely per-location, and now exercised rather than theoretical |
| Calendar UI | A room list | A **location switcher**, with the user's home location remembered |
| Search | All rooms | Scoped to a location by default, with an explicit cross-location option |
| Reporting | Per room | Per room, **per location**, and organization-wide |

Assumption **A2** in [00](00-overview.md#7-assumptions) is upgraded: multiple locations in
**different timezones** are now expected, not merely tolerated.

---

## 2. Data model

### `locations` — expanded

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `organization_id` | uuid FK | |
| `name` | text | Unique per org. "Head Office", "Bole Branch", "London" |
| `code` | text null | Short label for dense UI, e.g. `HQ`, `BOL` |
| `address` | text null | Appears in emails and `.ics` `LOCATION`, so visitors can find the building |
| `timezone` | text | IANA. **Authoritative for every room in this location** |
| `country` | text null | Drives the holiday calendar (section 6) |
| `business_hours_start` / `_end` | time null | Null inherits from the organization |
| `business_days` | int[] null | Null inherits. **Essential**: a Dubai office works Sunday–Thursday while a London office works Monday–Friday |
| `max_advance_days`, `min_notice_minutes`, `min_booking_minutes`, `max_booking_minutes` | int null | Null inherits |
| `reminder_lead_minutes` | int null | Null inherits |
| `is_active` | bool | Deactivating hides it and its rooms from new bookings |
| `sort_order` | int | Controls switcher order |

### `user_location_access` — new

Supports location-scoped administration.

| Column | Notes |
|--------|-------|
| `user_id` | FK |
| `location_id` | FK |
| `role` | `ADMIN` — the only scoped role |

Composite PK (`user_id`, `location_id`).

### `users` — additions

| Column | Notes |
|--------|-------|
| `home_location_id` | uuid FK null. The default location in the switcher, and the fallback display timezone |
| `role` | Unchanged, but now interpreted alongside `user_location_access` (section 3) |

---

## 3. Permissions across locations

This is the substantive decision. In a multi-site organization, the office manager in Addis
should not be able to cancel meetings in London.

| Role | Scope |
|------|-------|
| `EMPLOYEE` | Sees and books rooms in **every** active location. Staff travel between offices, and restricting this would create more support requests than it prevents problems |
| `ADMIN` with rows in `user_location_access` | Full admin powers — move, cancel, manage rooms, closures — **only within those locations** |
| `ADMIN` with no rows | Organization-wide admin. This keeps the single-site case simple: do nothing and it behaves exactly as before |
| `OWNER` | Everything, everywhere. Only an owner creates locations or assigns location admins |

The shared `can()` function gains a location dimension:

```ts
can(actor, 'booking:move', booking)
// → actor.role === 'OWNER'
//   || (actor.role === 'ADMIN' && actorAdministers(actor, booking.room.locationId))
```

Because `can()` lives in `shared/` ([02 §3](02-architecture.md#the-shared-package--why-this-is-the-real-win)),
the React UI hides out-of-scope admin controls using the same logic the server enforces.

**Rules:**

| ID | Rule |
|----|------|
| BR-L1 | A location admin may act only on rooms, bookings and closures in their locations |
| BR-L2 | A location admin may **not** move a booking **into** a location they do not administer — the move dialog lists only in-scope rooms |
| BR-L3 | Only an owner creates, edits or deactivates a location |
| BR-L4 | Only an owner grants or revokes location admin access |
| BR-L5 | An employee may book in any active location |
| BR-L6 | Deactivating a location requires resolving future bookings across all its rooms, by the same flow as BR-R4 |
| BR-L7 | The audit log records the location of every action, so an owner can review per site |

---

## 4. Settings inheritance

Three levels, resolved in order. `NULL` means inherit; an explicit value — **including `0`** —
means override.

```
organization default  →  location override  →  room override  →  effective value
```

Worked example for `business_days`:

| Level | Value | Result |
|-------|-------|--------|
| Organization | `Mon–Fri` | |
| Location "Dubai" | `Sun–Thu` | Dubai rooms are bookable Sunday to Thursday |
| Location "London" | `NULL` | London inherits Mon–Fri |
| Room "London Boardroom" | `Mon–Thu` | That one room excludes Friday |

Every settings screen shows the inherited value in muted text next to the field —
*"Inherited from Head Office: 08:00"* — so an admin always knows whether they are reading a
default or an override, and a "reset to inherited" control clears it back to `NULL`.

---

## 5. Timezones in practice

Multi-site is where the timezone design from [02 §11](02-architecture.md#11-timezone-strategy)
stops being theoretical.

1. A booking's time is **always** interpreted in its **room's location timezone**. Booking a
   London room means London time, whoever is booking and wherever they are.
2. Times are **displayed** in the viewer's zone — their profile setting, else their home
   location's zone — and **always** labelled.
3. When the viewer's zone differs from the room's, the UI shows **both**:

   > **14:00 – 15:00 GMT** · 17:00 – 18:00 EAT your time

   This dual display is not decoration. Booking a cross-timezone meeting with only one time
   shown is how people end up dialling in an hour late.
4. The location switcher shows each location's **current local time**, so the user can see at a
   glance that London is three hours behind.
5. Emails render in the **recipient's** timezone, with the room's local time alongside.
6. `.ics` files carry the room's `TZID`, so the recipient's calendar client converts correctly.
7. The day calendar grid is drawn on the **selected location's** timezone axis — not the
   viewer's — because an axis mixing two zones is unreadable. A note states which zone the
   axis is in.

---

## 6. Holidays and closures

Different offices close on different days, and this is a common source of ghost bookings.

- A location carries a `country`, which seeds a **holiday calendar** at setup.
- An owner can add location-specific non-working days (local public holidays, office
  shutdowns, Eid, Christmas).
- A holiday behaves as an all-day closure across every room in that location.
- **This matters most for recurring meetings** ([12 §4](12-recurrence.md#4-creating-a-series)):
  a weekly series spanning a holiday reports it in the preview as a skipped date, rather than
  booking a room in a closed building.

Holiday data is seeded from a static dataset, not a live API — a booking system should not
fail because a holiday service is down. An owner can edit the list.

---

## 7. User interface

### Location switcher — in the header, on every screen

```
┌──────────────────────────────────────────────────────────────┐
│ ▣ Acme Rooms   Calendar  Find a room  My bookings            │
│                                                              │
│   📍 Head Office ▾                                           │
│      ┌──────────────────────────────────────────┐            │
│      │ ● Head Office      Addis Ababa  11:42 ✓  │            │
│      │ ○ Bole Branch      Addis Ababa  11:42    │            │
│      │ ○ London           London       08:42    │            │
│      │ ──────────────────────────────────────── │            │
│      │ ○ All locations                          │            │
│      └──────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────┘
```

- Defaults to the user's `home_location_id`, falling back to the first active location.
- The choice persists in `localStorage` and in the URL (`?location=`), so a shared link opens
  on the right site.
- Current local time per location, updating live.
- **"All locations"** is available on the room finder and on the admin bookings table, but
  **not** on the day calendar grid — a grid spanning three timezones has no coherent time
  axis. Selecting it on the calendar prompts a location choice instead.

### Affected screens

| Screen | Change |
|--------|--------|
| S-05 Day calendar | Location switcher; the time axis and its zone label follow the selected location |
| S-06 Find a room | Location filter, plus "search all locations"; results grouped by location with local times |
| S-07 New booking | Room picker scoped to the location; dual-timezone display when the viewer's zone differs |
| S-08 Booking detail | Shows location name and address; dual timezone |
| S-11/S-12 Rooms | Grouped by location; the room editor shows inherited settings with their source |
| S-13 Admin bookings | Location filter; a location admin sees only their locations |
| S-16 Users | Shows home location and location-admin grants; owners edit them here — see below |
| **S-23 Locations (new)** | Owner-only CRUD: name, code, address, timezone, country, hours overrides, holidays, admins, active flag |
| S-20 Reports | Utilization per location, and comparison across locations |

---

### Attaching locations when setting up an admin (D17)

When an owner sets a user's role to **Admin**, a multi-select appears in the same form —
appointing an admin and scoping them is one action, not two:

```
┌──────────────────────────────────────────────────────────┐
│  Edit user — Sara Mengistu                               │
│                                                          │
│  Role        [ Admin ▾ ]                                 │
│                                                          │
│  Administers these locations                             │
│    ☑ Head Office                                         │
│    ☑ Bole Branch                                         │
│    ☐ London                                              │
│                                                          │
│    ☐ All locations, including any added later            │
│      Leave every box unchecked for organization-wide     │
│      access.                                             │
│                                                          │
│  Home location  [ Head Office ▾ ]                        │
│                                 [ Cancel ]  [ Save ]     │
└──────────────────────────────────────────────────────────┘
```

| Rule | Behaviour |
|------|-----------|
| One or more boxes ticked | Admin powers in exactly those locations (BR-L1) |
| No boxes ticked | **Organization-wide admin** — this keeps single-site setups unchanged |
| "All locations, including any added later" | A standing grant. Differs from ticking every box: a location created next year is included automatically, which is what an operations lead usually wants |
| Role changed away from Admin | Grants are retained but inactive, so restoring the role does not lose the configuration |
| Grants changed | An audit row is written, and the user is emailed that their access changed |

The multi-select appears on the invitation form too, so a new admin is scoped at the moment
they are invited rather than in a second pass that is easy to forget.

## 8. Effect on other features

| Feature | Interaction |
|---------|-------------|
| **Recurrence** ([12](12-recurrence.md)) | A series is evaluated in its **room's location timezone**, and skips that location's holidays. A series cannot span locations — moving one to another location is a `THIS_AND_FOLLOWING` split |
| **Calendar sync** ([13](13-calendar-sync.md)) | Provider events carry the room's `TZID` and the location address in `LOCATION`. Room-resource mappings are per room, so each site maps to its own provider resources |
| **Email** ([06](06-email-notifications.md)) | Every booking email names the location and its address, and the footer uses the location's address rather than a generic organization one |
| **Conflict suggestions** (BR-C4) | Alternatives are offered **within the same location** by default. A free room in another city is not a useful suggestion. An explicit "search other locations" control exists |
| **Reporting** | Utilization is only comparable within a location, since bookable hours differ. Cross-location views show rates, not raw hours |

---

## 9. Test cases

| # | Case | Expected |
|---|------|----------|
| T-160 | Location admin moves a booking in their location | Succeeds |
| T-161 | Location admin moves a booking in another location | 403 (BR-L1) |
| T-162 | Location admin moves a booking **into** a location they do not administer | 403; that room never appears in the move dialog (BR-L2) |
| T-163 | Admin with no location rows | Behaves as organization-wide admin — the single-site case is unchanged |
| T-164 | Employee books in a location that is not their home | Succeeds (BR-L5) |
| T-165 | Dubai location set to Sun–Thu | Friday booking rejected in Dubai, accepted in London |
| T-166 | Room override beats location override beats org default; `NULL` inherits, `0` does not | Correct three-level resolution |
| T-167 | London viewer books an Addis room | Stored correctly; both zones displayed; the email shows the viewer's zone with the room's alongside |
| T-168 | DST in one location only | Only that location's bookable hours shift in UTC; the other is unaffected |
| T-169 | Weekly series spanning a location holiday | The holiday date is reported as skipped in the preview |
| T-170 | Deactivating a location with future bookings | Blocked until they are resolved (BR-L6) |
| T-171 | Day calendar with "All locations" selected | Prompts for a location rather than rendering a mixed-timezone axis |
| T-172 | Location switcher | Shows correct current local time per location |
