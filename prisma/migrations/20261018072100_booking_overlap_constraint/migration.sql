-- Prevent overlapping bookings in the same room, AT THE DATABASE LEVEL.
--
-- This is the single most important object in the schema. Application-level
-- "check then insert" is not sufficient: two concurrent requests can both pass
-- the check before either inserts. An exclusion constraint makes the overlap
-- physically impossible, whatever the application does, and converts the race
-- into a constraint violation that the service catches and returns as 409.
--
-- Prisma cannot express this, so it is hand-written. Do not regenerate it.
--
-- Specification: docs/03-data-model.md section 6, docs/04-business-rules.md
-- section 3, test T-20 (50 parallel attempts on one slot -> exactly 1 success).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- '[)' is the half-open interval: a booking 09:00-10:00 and one 10:00-11:00 do
-- NOT conflict (BR-T2). Using '[]' here would be the most user-visible bug the
-- system could ship.
--
-- The WHERE predicate is the set of statuses that OCCUPY a room. It must stay
-- identical to OCCUPYING_BOOKING_STATUSES in shared/src/enums.ts -- if the two
-- disagree, the database and the application disagree about whether a room is
-- free. PENDING_APPROVAL is included because an approval request holds its slot
-- (BR-A2); ENDED_EARLY because the booking really did use the room up to its
-- truncated end (BR-M2b).
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "roomId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE (status IN ('PENDING_APPROVAL', 'CONFIRMED', 'ENDED_EARLY'));

-- Rooms are also unbookable during a closure. Closures may not overlap each
-- other on the same room, which keeps the "why is this room closed" answer
-- unambiguous (BR-R8).
ALTER TABLE "room_closures"
  ADD CONSTRAINT "room_closures_no_overlap"
  EXCLUDE USING gist (
    "roomId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  );

-- Cheap integrity rules the application also enforces, kept here so that no
-- code path -- including a future script or a manual fix -- can violate them.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_ends_after_starts" CHECK ("endsAt" > "startsAt");

ALTER TABLE "room_closures"
  ADD CONSTRAINT "room_closures_ends_after_starts" CHECK ("endsAt" > "startsAt");

ALTER TABLE "rooms"
  ADD CONSTRAINT "rooms_capacity_positive" CHECK ("capacity" >= 1);
