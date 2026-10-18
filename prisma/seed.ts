/**
 * Development seed.
 *
 * Creates a usable environment with the awkward cases already present —
 * multiple timezones, a location-scoped admin, a location with different
 * working days — so that cross-timezone and permission bugs surface during
 * development rather than after launch.
 *
 * Specification: docs/03-data-model.md section 7.
 */

import { PrismaClient } from '@prisma/client'
import { Algorithm, hash } from '@node-rs/argon2'

const prisma = new PrismaClient()

/** The one guard that matters: never run this against real data. */
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV is production.')
  process.exit(1)
}

const DEV_PASSWORD = 'Password123!'

async function main(): Promise<void> {
  const passwordHash = await hash(DEV_PASSWORD, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  })

  // Idempotent: clearing the organization cascades to everything beneath it,
  // so `npm run seed` can be run repeatedly.
  await prisma.organization.deleteMany({ where: { slug: 'acme' } })

  const org = await prisma.organization.create({
    data: {
      name: 'Acme Corp',
      slug: 'acme',
      defaultTimezone: 'Africa/Addis_Ababa',
      settings: {
        create: {
          // D6: organizer-only email in v1. Flipping this enables the attendee
          // templates, which are built and tested but gated.
          notifyAttendees: false,
        },
      },
    },
  })

  const headOffice = await prisma.location.create({
    data: {
      organizationId: org.id,
      name: 'Head Office',
      code: 'HQ',
      address: 'Bole Road, Addis Ababa',
      timezone: 'Africa/Addis_Ababa',
      country: 'ET',
      businessDays: [],
      sortOrder: 0,
    },
  })

  const boleBranch = await prisma.location.create({
    data: {
      organizationId: org.id,
      name: 'Bole Branch',
      code: 'BOL',
      address: 'Airport Road, Addis Ababa',
      timezone: 'Africa/Addis_Ababa',
      country: 'ET',
      businessDays: [],
      sortOrder: 1,
    },
  })

  /*
   * A second timezone, with different working hours. This is what makes a
   * cross-timezone regression visible locally (T-167, T-168).
   */
  const london = await prisma.location.create({
    data: {
      organizationId: org.id,
      name: 'London',
      code: 'LDN',
      address: '12 Finsbury Square, London',
      timezone: 'Europe/London',
      country: 'GB',
      businessHoursStart: '09:00',
      businessHoursEnd: '17:30',
      businessDays: [1, 2, 3, 4, 5],
      sortOrder: 2,
      holidays: {
        create: [
          { date: '2026-12-25', name: 'Christmas Day' },
          { date: '2026-12-26', name: 'Boxing Day' },
          { date: '2027-01-01', name: 'New Year' },
        ],
      },
    },
  })

  const features = await Promise.all(
    [
      { name: 'Projector', icon: 'projector', sortOrder: 0 },
      { name: 'TV / Screen', icon: 'tv', sortOrder: 1 },
      { name: 'Video conference', icon: 'video', sortOrder: 2 },
      { name: 'Whiteboard', icon: 'pen', sortOrder: 3 },
      { name: 'Conference phone', icon: 'phone', sortOrder: 4 },
      { name: 'Wheelchair accessible', icon: 'accessible', sortOrder: 5 },
      { name: 'Natural light', icon: 'sun', sortOrder: 6 },
    ].map(f => prisma.roomFeature.create({ data: { ...f, organizationId: org.id } })),
  )
  const feature = (name: string) => features.find(f => f.name === name)!

  const owner = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: 'owner@acme.test',
      fullName: 'Owner Example',
      role: 'OWNER',
      status: 'ACTIVE',
      passwordHash,
      homeLocationId: headOffice.id,
    },
  })

  await prisma.user.create({
    data: {
      organizationId: org.id,
      email: 'admin@acme.test',
      fullName: 'Sara Mengistu',
      role: 'ADMIN',
      status: 'ACTIVE',
      passwordHash,
      homeLocationId: headOffice.id,
      // No location grants: an organization-wide admin, which is how a
      // single-site setup behaves (BR-L1).
    },
  })

  /*
   * A LOCATION-SCOPED admin. Exists specifically so that BR-L1 and BR-L2 can be
   * exercised by hand: this account must not be able to touch Addis rooms.
   */
  await prisma.user.create({
    data: {
      organizationId: org.id,
      email: 'london.admin@acme.test',
      fullName: 'Jo Fairbairn',
      role: 'ADMIN',
      status: 'ACTIVE',
      passwordHash,
      homeLocationId: london.id,
      locationAccess: { create: [{ locationId: london.id }] },
    },
  })

  await prisma.user.createMany({
    data: [
      {
        organizationId: org.id,
        email: 'alice@acme.test',
        fullName: 'Alice Bekele',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        passwordHash,
        homeLocationId: headOffice.id,
      },
      {
        organizationId: org.id,
        email: 'bob@acme.test',
        fullName: 'Bob Tesfaye',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        passwordHash,
        homeLocationId: headOffice.id,
      },
      {
        organizationId: org.id,
        email: 'invited@acme.test',
        fullName: 'Not Yet Accepted',
        role: 'EMPLOYEE',
        status: 'INVITED',
        homeLocationId: london.id,
      },
    ],
  })

  const weekdayHours = (start: string, end: string) =>
    [1, 2, 3, 4, 5].map(weekday => ({ weekday, startLocal: start, endLocal: end }))

  const rooms: Array<{
    locationId: string
    name: string
    capacity: number
    floor: string
    colour: string
    featureNames: string[]
    requiresApproval?: boolean
    hours?: Array<{ weekday: number; startLocal: string; endLocal: string }>
  }> = [
    {
      locationId: headOffice.id,
      name: 'Boardroom',
      capacity: 14,
      floor: '3rd floor',
      colour: '#2f5fd0',
      featureNames: ['Projector', 'Video conference', 'Conference phone', 'Natural light'],
      // The one room that needs sign-off. Kept to a single room deliberately:
      // marking many of them makes people route around the system (docs/15 §10).
      requiresApproval: true,
    },
    {
      locationId: headOffice.id,
      name: 'Meeting Room C',
      capacity: 6,
      floor: '2nd floor',
      colour: '#0f7a6c',
      featureNames: ['TV / Screen', 'Whiteboard'],
    },
    {
      locationId: headOffice.id,
      name: 'Focus 1',
      capacity: 2,
      floor: '2nd floor',
      colour: '#9a4f14',
      featureNames: ['Natural light'],
    },
    {
      locationId: headOffice.id,
      name: 'Training Room',
      capacity: 24,
      floor: 'Ground',
      colour: '#7a3fa8',
      featureNames: ['Projector', 'Whiteboard', 'Wheelchair accessible'],
    },
    {
      locationId: boleBranch.id,
      name: 'Boardroom',
      capacity: 10,
      floor: '1st floor',
      colour: '#19627f',
      // Same name as the Head Office room: proves names are unique per
      // LOCATION, not per organization (BR-R1).
      featureNames: ['Video conference', 'TV / Screen'],
    },
    {
      locationId: boleBranch.id,
      name: 'Huddle',
      capacity: 4,
      floor: '1st floor',
      colour: '#9c2a62',
      featureNames: ['Whiteboard'],
    },
    {
      locationId: london.id,
      name: 'Thames',
      capacity: 8,
      floor: '4th floor',
      colour: '#4a6b14',
      featureNames: ['Video conference', 'TV / Screen', 'Natural light'],
      hours: weekdayHours('09:00', '17:30'),
    },
    {
      locationId: london.id,
      name: 'Barbican',
      capacity: 4,
      floor: '4th floor',
      colour: '#0b6ea8',
      featureNames: ['Whiteboard'],
      hours: weekdayHours('09:00', '17:30'),
    },
  ]

  for (const room of rooms) {
    await prisma.room.create({
      data: {
        organizationId: org.id,
        locationId: room.locationId,
        name: room.name,
        capacity: room.capacity,
        floor: room.floor,
        colour: room.colour,
        requiresApproval: room.requiresApproval ?? false,
        ...(room.requiresApproval ? { approverUserId: owner.id } : {}),
        features: { create: room.featureNames.map(n => ({ featureId: feature(n).id })) },
        ...(room.hours ? { hours: { create: room.hours } } : {}),
      },
    })
  }

  const counts = {
    locations: await prisma.location.count({ where: { organizationId: org.id } }),
    rooms: await prisma.room.count({ where: { organizationId: org.id } }),
    users: await prisma.user.count({ where: { organizationId: org.id } }),
    features: features.length,
  }

  console.log('Seeded Acme Corp:', counts)
  console.log('')
  console.log('  Sign in with password:', DEV_PASSWORD)
  console.log('    owner@acme.test          OWNER')
  console.log('    admin@acme.test          ADMIN, organization-wide')
  console.log('    london.admin@acme.test   ADMIN, London only  <- for testing BR-L1')
  console.log('    alice@acme.test          EMPLOYEE')
  console.log('    bob@acme.test            EMPLOYEE')
  console.log('    invited@acme.test        INVITED, cannot sign in yet')
  console.log('')
  console.log('  Bookings and recurring series are seeded in M3/M4b.')
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
