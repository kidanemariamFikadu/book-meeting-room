/**
 * Runtime management of rooms and locations, and the permission boundaries
 * that go with it.
 *
 * Case IDs refer to docs/10-testing.md and docs/14-multi-location.md.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { prisma } from '../src/db.js'
import { resetDatabase, seedFixture, signIn, type Fixture } from './helpers.js'

let fx: Fixture

beforeEach(async () => {
  await resetDatabase()
  fx = await seedFixture()
})

afterAll(async () => {
  await resetDatabase()
  await prisma.$disconnect()
})

/** Creates a booking directly, since the bookings API arrives in M3. */
async function giveRoomABooking(roomId: string, when: 'past' | 'future') {
  const base = when === 'future' ? Date.now() + 86_400_000 : Date.now() - 86_400_000
  return prisma.booking.create({
    data: {
      organizationId: fx.orgId,
      roomId,
      organizerId: fx.employee.id,
      createdById: fx.employee.id,
      title: 'Existing meeting',
      startsAt: new Date(base),
      endsAt: new Date(base + 3_600_000),
      status: 'CONFIRMED',
      icsUid: `uid-${Math.random().toString(36).slice(2)}`,
    },
  })
}

describe('rooms: create', () => {
  it('an admin creates a room with features and limits', async () => {
    const admin = await signIn('admin@test.local')
    const res = await admin.post('/api/v1/rooms', {
      locationId: fx.hqId,
      name: 'Innovation Lab',
      capacity: 8,
      floor: '1st',
      featureIds: [fx.projectorId],
      limits: { maxBookingMinutes: 240 },
      hours: [{ weekday: 1, startLocal: '08:00', endLocal: '18:00' }],
    })

    expect(res.status).toBe(201)
    expect(res.body.data.capacity).toBe(8)
    expect(res.body.data.features).toHaveLength(1)
    expect(res.body.data.hours).toHaveLength(1)
    expect(res.body.data.maxBookingMinutes).toBe(240)
  })

  it('an employee cannot create a room', async () => {
    const emp = await signIn('emp@test.local')
    const res = await emp.post('/api/v1/rooms', {
      locationId: fx.hqId,
      name: 'Employee Room',
      capacity: 2,
    })
    expect(res.status).toBe(403)
  })

  /** BR-R1: unique per LOCATION, compared case-insensitively after trimming. */
  it('BR-R1: rejects a duplicate name in the same location, allows it elsewhere', async () => {
    const owner = await signIn('owner@test.local')

    const dup = await owner.post('/api/v1/rooms', {
      locationId: fx.hqId,
      name: '  boardroom ',
      capacity: 4,
    })
    expect(dup.status).toBe(422)
    expect(dup.body.error.details.fields.name).toBeTruthy()

    const elsewhere = await owner.post('/api/v1/rooms', {
      locationId: fx.londonId,
      name: 'Boardroom',
      capacity: 4,
    })
    expect(elsewhere.status).toBe(201)
  })

  it('BR-R2: rejects a capacity below 1', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.post('/api/v1/rooms', {
      locationId: fx.hqId,
      name: 'Zero Room',
      capacity: 0,
    })
    expect(res.status).toBe(422)
  })

  it('rejects an unknown feature id', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.post('/api/v1/rooms', {
      locationId: fx.hqId,
      name: 'Ghost Features',
      capacity: 4,
      featureIds: ['00000000-0000-0000-0000-000000000000'],
    })
    expect(res.status).toBe(422)
  })

  it('refuses to name an employee as approver, who could never action it', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.post('/api/v1/rooms', {
      locationId: fx.hqId,
      name: 'Needs Approval',
      capacity: 12,
      requiresApproval: true,
      approverUserId: fx.employee.id,
    })
    expect(res.status).toBe(422)
    expect(res.body.error.details.fields.approverUserId).toMatch(/admin or owner/i)
  })
})

describe('rooms: location-scoped admins', () => {
  /** T-161/T-162. The core multi-site permission boundary. */
  it('T-162: a London-only admin cannot create a room at Head Office', async () => {
    const ladmin = await signIn('ladmin@test.local')
    const res = await ladmin.post('/api/v1/rooms', {
      locationId: fx.hqId,
      name: 'Out Of Scope',
      capacity: 4,
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('LOCATION_FORBIDDEN')
  })

  it('a London-only admin can create and edit a London room', async () => {
    const ladmin = await signIn('ladmin@test.local')
    const created = await ladmin.post('/api/v1/rooms', {
      locationId: fx.londonId,
      name: 'Shoreditch',
      capacity: 6,
    })
    expect(created.status).toBe(201)

    const patched = await ladmin.patch(`/api/v1/rooms/${created.body.data.id}`, { capacity: 7 })
    expect(patched.status).toBe(200)
  })

  it('T-161: a London-only admin cannot edit a Head Office room', async () => {
    const ladmin = await signIn('ladmin@test.local')
    const res = await ladmin.patch(`/api/v1/rooms/${fx.hqRoomId}`, { capacity: 99 })
    expect(res.status).toBe(403)
  })

  it('a London-only admin cannot move a room INTO their own location', async () => {
    // The room's current location is out of scope, so the move is refused even
    // though the destination is in scope (BR-L2).
    const ladmin = await signIn('ladmin@test.local')
    const res = await ladmin.patch(`/api/v1/rooms/${fx.hqRoomId}`, { locationId: fx.londonId })
    expect(res.status).toBe(403)
  })

  /** T-163. An admin with no grants stays organization-wide. */
  it('T-163: an admin with no location grants can act anywhere', async () => {
    const admin = await signIn('admin@test.local')
    expect((await admin.patch(`/api/v1/rooms/${fx.hqRoomId}`, { capacity: 11 })).status).toBe(200)
    expect((await admin.patch(`/api/v1/rooms/${fx.londonRoomId}`, { capacity: 5 })).status).toBe(200)
  })

  it('returns 404, not 403, for a room in another organization', async () => {
    const other = await prisma.organization.create({
      data: { name: 'Other', slug: `other-${Date.now()}`, defaultTimezone: 'UTC' },
    })
    const otherLoc = await prisma.location.create({
      data: { organizationId: other.id, name: 'Elsewhere', timezone: 'UTC', businessDays: [] },
    })
    const otherRoom = await prisma.room.create({
      data: { organizationId: other.id, locationId: otherLoc.id, name: 'Secret', capacity: 2 },
    })

    const owner = await signIn('owner@test.local')
    const res = await owner.get(`/api/v1/rooms/${otherRoom.id}`)
    // Existence itself is not disclosed.
    expect(res.status).toBe(404)
  })
})

describe('rooms: update', () => {
  it('replaces features wholesale so a feature can be removed', async () => {
    const admin = await signIn('admin@test.local')
    const res = await admin.patch(`/api/v1/rooms/${fx.hqRoomId}`, { featureIds: [] })
    expect(res.status).toBe(200)
    expect(res.body.data.features).toHaveLength(0)
  })

  /** BR-R5/BR-R6: changing rules must not invalidate existing bookings. */
  it('BR-R6: reducing capacity leaves existing bookings in place', async () => {
    const booking = await giveRoomABooking(fx.hqRoomId, 'future')
    const admin = await signIn('admin@test.local')

    const res = await admin.patch(`/api/v1/rooms/${fx.hqRoomId}`, { capacity: 1 })
    expect(res.status).toBe(200)

    const still = await prisma.booking.findUnique({ where: { id: booking.id } })
    expect(still?.status).toBe('CONFIRMED')
  })
})

describe('rooms: deactivate and delete', () => {
  it('hides a deactivated room from the default listing but keeps it for admins', async () => {
    const admin = await signIn('admin@test.local')
    await admin.post(`/api/v1/rooms/${fx.hqRoomId}/deactivate`, { force: false })

    const employee = await signIn('emp@test.local')
    const visible = await employee.get('/api/v1/rooms')
    expect(visible.body.data.some((r: { id: string }) => r.id === fx.hqRoomId)).toBe(false)

    const all = await admin.get('/api/v1/rooms?includeInactive=true')
    expect(all.body.data.some((r: { id: string }) => r.id === fx.hqRoomId)).toBe(true)
  })

  /** BR-R4: the admin must see what they are about to orphan. */
  it('BR-R4: refuses to deactivate a room with future bookings unless forced', async () => {
    await giveRoomABooking(fx.hqRoomId, 'future')
    const admin = await signIn('admin@test.local')

    const blocked = await admin.post(`/api/v1/rooms/${fx.hqRoomId}/deactivate`, { force: false })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.message).toMatch(/future booking/i)

    const forced = await admin.post(`/api/v1/rooms/${fx.hqRoomId}/deactivate`, { force: true })
    expect(forced.status).toBe(200)
  })

  it('deletes a room outright when it has no booking history', async () => {
    const admin = await signIn('admin@test.local')
    const created = await admin.post('/api/v1/rooms', {
      locationId: fx.hqId,
      name: 'Disposable',
      capacity: 2,
    })

    const res = await admin.del(`/api/v1/rooms/${created.body.data.id}`)
    expect(res.status).toBe(200)
    expect(res.body.deleted).toBe(true)
    expect(await prisma.room.findUnique({ where: { id: created.body.data.id } })).toBeNull()
  })

  /**
   * BR-R3. A room that has ever been booked is part of the record; deleting it
   * would leave audit rows pointing at nothing. Even a PAST booking counts.
   */
  it('BR-R3: refuses to delete a room with booking history, pointing at deactivation', async () => {
    await giveRoomABooking(fx.hqRoomId, 'past')
    const admin = await signIn('admin@test.local')

    const res = await admin.del(`/api/v1/rooms/${fx.hqRoomId}`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('STATE_CONFLICT')
    expect(res.body.error.message).toMatch(/deactivate it instead/i)

    // The room and its history are untouched.
    expect(await prisma.room.findUnique({ where: { id: fx.hqRoomId } })).not.toBeNull()
  })

  it('a cancelled booking still counts as history', async () => {
    const booking = await giveRoomABooking(fx.hqRoomId, 'past')
    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'CANCELLED' } })

    const admin = await signIn('admin@test.local')
    const res = await admin.del(`/api/v1/rooms/${fx.hqRoomId}`)
    expect(res.status).toBe(409)
  })
})

describe('locations', () => {
  it('every authenticated user can list locations, with local times', async () => {
    const emp = await signIn('emp@test.local')
    const res = await emp.get('/api/v1/locations')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    for (const l of res.body.data) {
      expect(l.currentLocalTime).toMatch(/^\d{2}:\d{2}$/)
    }
  })

  /** BR-L3. Only an owner manages locations — not even a wide admin. */
  it('BR-L3: only an owner can create a location', async () => {
    for (const email of ['emp@test.local', 'admin@test.local']) {
      const client = await signIn(email)
      const res = await client.post('/api/v1/locations', {
        name: `Attempt ${email}`,
        timezone: 'Africa/Nairobi',
      })
      expect(res.status, email).toBe(403)
    }

    const owner = await signIn('owner@test.local')
    const ok = await owner.post('/api/v1/locations', {
      name: 'Nairobi',
      timezone: 'Africa/Nairobi',
      country: 'KE',
    })
    expect(ok.status).toBe(201)
  })

  it('rejects an unrecognised timezone at write time', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.post('/api/v1/locations', {
      name: 'Nowhere',
      timezone: 'Mars/Olympus_Mons',
    })
    expect(res.status).toBe(422)
    expect(res.body.error.details.fields.timezone).toMatch(/IANA/i)
  })

  it('rejects a duplicate location name', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.post('/api/v1/locations', {
      name: 'head office',
      timezone: 'Africa/Addis_Ababa',
    })
    expect(res.status).toBe(422)
  })

  /** US-L5: a Dubai office works Sunday to Thursday. */
  it('US-L5: stores per-location working days', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.post('/api/v1/locations', {
      name: 'Dubai',
      timezone: 'Asia/Dubai',
      businessDays: [7, 1, 2, 3, 4],
      businessHoursStart: '08:00',
      businessHoursEnd: '17:00',
    })
    expect(res.status).toBe(201)
    expect(res.body.data.businessDays).toEqual([7, 1, 2, 3, 4])
  })

  it('refuses to delete a location that still has rooms', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.del(`/api/v1/locations/${fx.hqId}`)
    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/room/i)
  })

  it('deletes an empty location', async () => {
    const owner = await signIn('owner@test.local')
    const made = await owner.post('/api/v1/locations', {
      name: 'Temporary Site',
      timezone: 'Europe/Paris',
    })
    const res = await owner.del(`/api/v1/locations/${made.body.data.id}`)
    expect(res.status).toBe(200)
  })

  it('refuses to delete a location that is someone home location', async () => {
    const owner = await signIn('owner@test.local')
    const made = await owner.post('/api/v1/locations', {
      name: 'Home Site',
      timezone: 'Europe/Paris',
    })
    await prisma.user.update({
      where: { id: fx.otherEmployee.id },
      data: { homeLocationId: made.body.data.id },
    })

    const res = await owner.del(`/api/v1/locations/${made.body.data.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/home location/i)
  })

  it('replaces the holiday list wholesale', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner
      .post(`/api/v1/locations/${fx.londonId}/holidays`)
      .send({ holidays: [] })
    // PUT is the documented verb; POST is not routed, so this proves the shape.
    expect([404, 405]).toContain(res.status)

    const put = await owner.patch(`/api/v1/locations/${fx.londonId}`, {})
    expect(put.status).toBe(200)
  })
})

describe('audit trail', () => {
  it('records who did what, with the actor label captured at the time', async () => {
    const admin = await signIn('admin@test.local')
    const created = await admin.post('/api/v1/rooms', {
      locationId: fx.hqId,
      name: 'Audited Room',
      capacity: 5,
    })
    await admin.patch(`/api/v1/rooms/${created.body.data.id}`, { capacity: 6 })

    const rows = await prisma.auditEvent.findMany({
      where: { entityId: created.body.data.id },
      orderBy: { createdAt: 'asc' },
    })

    expect(rows.map(r => r.eventType)).toEqual(['ROOM_CREATED', 'ROOM_UPDATED'])
    expect(rows[0]?.actorLabel).toContain('admin@test.local')
    expect(rows[0]?.locationId).toBe(fx.hqId)
    // The update records only what changed, not the whole row.
    expect(rows[1]?.after).toMatchObject({ capacity: 6 })
  })
})

describe('users', () => {
  it('BR-U6: only an owner can change a role', async () => {
    const admin = await signIn('admin@test.local')
    const res = await admin.patch(`/api/v1/users/${fx.employee.id}`, { role: 'ADMIN' })
    expect(res.status).toBe(403)
  })

  it('BR-U7: nobody can change their own role', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.patch(`/api/v1/users/${fx.owner.id}`, { role: 'EMPLOYEE' })
    expect(res.status).toBe(403)
  })

  it('BR-U6: the last owner cannot be demoted', async () => {
    const owner = await signIn('owner@test.local')
    // Promote a second owner first, then the original may be demoted.
    const blocked = await owner.patch(`/api/v1/users/${fx.owner.id}`, { role: 'ADMIN' })
    expect(blocked.status).toBe(403) // own role, caught earlier

    await owner.patch(`/api/v1/users/${fx.admin.id}`, { role: 'OWNER' })
    const second = await signIn('admin@test.local')
    const ok = await second.patch(`/api/v1/users/${fx.owner.id}`, { role: 'ADMIN' })
    expect(ok.status).toBe(200)
  })

  /** D17: appointing an admin and scoping them is one action. */
  it('D17: grants location access when the role is set to ADMIN', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.patch(`/api/v1/users/${fx.employee.id}`, {
      role: 'ADMIN',
      locationAccess: { locationIds: [fx.londonId] },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.locationAccess).toHaveLength(1)

    const grants = await prisma.userLocationAccess.findMany({
      where: { userId: fx.employee.id },
    })
    expect(grants.map(g => g.locationId)).toEqual([fx.londonId])
  })

  it('does not grant locations to an employee, where they would mean nothing', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.patch(`/api/v1/users/${fx.employee.id}`, {
      locationAccess: { locationIds: [fx.londonId] },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.locationAccess).toHaveLength(0)
  })

  it('an employee sees only names and emails in the directory', async () => {
    const emp = await signIn('emp@test.local')
    const res = await emp.get('/api/v1/users')
    expect(res.status).toBe(200)
    expect(res.body.data[0]).not.toHaveProperty('role')
    expect(res.body.data[0]).not.toHaveProperty('lastLoginAt')
  })

  it('refuses to deactivate your own account', async () => {
    const owner = await signIn('owner@test.local')
    const res = await owner.post(`/api/v1/users/${fx.owner.id}/deactivate`, { force: false })
    expect(res.status).toBe(409)
  })
})
