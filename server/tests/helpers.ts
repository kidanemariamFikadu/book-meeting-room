/**
 * Test fixtures and an authenticated HTTP client.
 *
 * Builders keep tests readable: a test that needs a London-only admin says so
 * in one line, rather than spending twenty lines constructing one.
 */

import { Algorithm, hash } from '@node-rs/argon2'
import type { Express } from 'express'
import request from 'supertest'

import { createApp } from '../src/app.js'
import { prisma } from '../src/db.js'
import { CapturingMailer, setMailer } from '../src/mail/Mailer.js'

export const TEST_PASSWORD = 'CorrectHorseBattery7'

let cachedHash: string | null = null
async function passwordHash(): Promise<string> {
  // Hashed once per run: Argon2 is deliberately slow, and every fixture user
  // sharing one hash turns minutes of setup into milliseconds.
  cachedHash ??= await hash(TEST_PASSWORD, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  })
  return cachedHash
}

export const mailer = new CapturingMailer()
setMailer(mailer)

export const app: Express = createApp()

/** Wipes everything. Cascades from the organization, so order does not matter. */
export async function resetDatabase(): Promise<void> {
  await prisma.organization.deleteMany({})
}

export interface Fixture {
  orgId: string
  hqId: string
  londonId: string
  owner: { id: string; email: string }
  admin: { id: string; email: string }
  londonAdmin: { id: string; email: string }
  employee: { id: string; email: string }
  otherEmployee: { id: string; email: string }
  hqRoomId: string
  londonRoomId: string
  projectorId: string
}

/**
 * The standard world: two locations in different timezones, an org-wide admin,
 * a location-scoped admin, and two employees. Deliberately includes the awkward
 * cases so permission boundaries are always testable.
 */
export async function seedFixture(): Promise<Fixture> {
  const pwd = await passwordHash()

  const org = await prisma.organization.create({
    data: {
      name: 'Test Org',
      slug: `test-${Date.now()}`,
      defaultTimezone: 'Africa/Addis_Ababa',
      settings: { create: {} },
    },
  })

  const hq = await prisma.location.create({
    data: {
      organizationId: org.id,
      name: 'Head Office',
      timezone: 'Africa/Addis_Ababa',
      businessDays: [],
    },
  })
  const london = await prisma.location.create({
    data: {
      organizationId: org.id,
      name: 'London',
      timezone: 'Europe/London',
      businessDays: [1, 2, 3, 4, 5],
    },
  })

  const mkUser = (
    email: string,
    fullName: string,
    role: 'OWNER' | 'ADMIN' | 'EMPLOYEE',
    extra: Record<string, unknown> = {},
  ) =>
    prisma.user.create({
      data: {
        organizationId: org.id,
        email,
        fullName,
        role,
        status: 'ACTIVE',
        passwordHash: pwd,
        ...extra,
      },
      select: { id: true, email: true },
    })

  const owner = await mkUser('owner@test.local', 'Owner One', 'OWNER', { homeLocationId: hq.id })
  const admin = await mkUser('admin@test.local', 'Admin Wide', 'ADMIN', { homeLocationId: hq.id })
  const londonAdmin = await mkUser('ladmin@test.local', 'Admin London', 'ADMIN', {
    homeLocationId: london.id,
    // A scoped grant: this account must not reach Head Office (BR-L1).
    locationAccess: { create: [{ locationId: london.id }] },
  })
  const employee = await mkUser('emp@test.local', 'Employee One', 'EMPLOYEE', {
    homeLocationId: hq.id,
  })
  const otherEmployee = await mkUser('emp2@test.local', 'Employee Two', 'EMPLOYEE', {
    homeLocationId: hq.id,
  })

  const projector = await prisma.roomFeature.create({
    data: { organizationId: org.id, name: 'Projector' },
  })

  const hqRoom = await prisma.room.create({
    data: {
      organizationId: org.id,
      locationId: hq.id,
      name: 'Boardroom',
      capacity: 10,
      features: { create: [{ featureId: projector.id }] },
    },
  })
  const londonRoom = await prisma.room.create({
    data: { organizationId: org.id, locationId: london.id, name: 'Thames', capacity: 6 },
  })

  return {
    orgId: org.id,
    hqId: hq.id,
    londonId: london.id,
    owner,
    admin,
    londonAdmin,
    employee,
    otherEmployee,
    hqRoomId: hqRoom.id,
    londonRoomId: londonRoom.id,
    projectorId: projector.id,
  }
}

export interface Client {
  get(path: string): request.Test
  post(path: string, body?: unknown): request.Test
  patch(path: string, body?: unknown): request.Test
  del(path: string, body?: unknown): request.Test
  cookie: string
}

/** Signs in and returns a client that carries the session and CSRF token. */
export async function signIn(email: string, password = TEST_PASSWORD): Promise<Client> {
  const agent = request.agent(app)
  const login = await agent
    .post('/api/v1/auth/login')
    .send({ email, password })
    .set('content-type', 'application/json')

  if (login.status !== 200) {
    throw new Error(`signIn(${email}) failed: ${login.status} ${JSON.stringify(login.body)}`)
  }

  const cookie = (login.headers['set-cookie'] as unknown as string[])
    .map(c => c.split(';')[0])
    .join('; ')

  const csrfRes = await request(app).get('/api/v1/auth/csrf').set('cookie', cookie)
  const token = csrfRes.body.csrfToken as string

  const withAuth = (t: request.Test) => t.set('cookie', cookie).set('x-csrf-token', token)

  return {
    cookie,
    get: path => withAuth(request(app).get(path)),
    post: (path, body) => withAuth(request(app).post(path).send(body as object)),
    patch: (path, body) => withAuth(request(app).patch(path).send(body as object)),
    del: (path, body) => withAuth(request(app).delete(path).send(body as object)),
  }
}

/** An unauthenticated client, for checking that routes are actually closed. */
export function anon() {
  return {
    get: (path: string) => request(app).get(path),
    post: (path: string, body?: unknown) => request(app).post(path).send(body as object),
  }
}
