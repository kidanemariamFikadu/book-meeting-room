/**
 * Authentication and session behaviour.
 *
 * Case IDs refer to docs/10-testing.md.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { prisma } from '../src/db.js'
import * as auth from '../src/services/AuthService.js'
import { anon, mailer, resetDatabase, seedFixture, signIn, TEST_PASSWORD, type Fixture } from './helpers.js'

let fx: Fixture

beforeAll(async () => {
  await resetDatabase()
})

beforeEach(async () => {
  await resetDatabase()
  mailer.clear()
  fx = await seedFixture()
})

afterAll(async () => {
  await resetDatabase()
  await prisma.$disconnect()
})

describe('login', () => {
  it('signs in an active user and returns their role', async () => {
    const res = await anon().post('/api/v1/auth/login', {
      email: 'owner@test.local',
      password: TEST_PASSWORD,
    })
    expect(res.status).toBe(200)
    expect(res.body.user.role).toBe('OWNER')
    // The hash must never leave the server.
    expect(JSON.stringify(res.body)).not.toContain('passwordHash')
  })

  it('is case-insensitive on the email address', async () => {
    const res = await anon().post('/api/v1/auth/login', {
      email: 'OWNER@TEST.LOCAL',
      password: TEST_PASSWORD,
    })
    expect(res.status).toBe(200)
  })

  /**
   * T-91. The three failure modes must be indistinguishable, or the endpoint
   * becomes a way to discover who has an account and whose is disabled.
   */
  it('T-91: returns an identical response for unknown, wrong-password and disabled accounts', async () => {
    await prisma.user.create({
      data: {
        organizationId: fx.orgId,
        email: 'disabled@test.local',
        fullName: 'Disabled User',
        role: 'EMPLOYEE',
        status: 'DISABLED',
        passwordHash: 'x',
      },
    })

    const results = await Promise.all([
      anon().post('/api/v1/auth/login', { email: 'nobody@test.local', password: 'WrongPassword1' }),
      anon().post('/api/v1/auth/login', { email: 'emp@test.local', password: 'WrongPassword1' }),
      anon().post('/api/v1/auth/login', { email: 'disabled@test.local', password: 'WrongPassword1' }),
    ])

    for (const r of results) {
      expect(r.status).toBe(401)
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS')
    }
    // Byte-identical bodies apart from the request id.
    const shapes = results.map(r => ({ code: r.body.error.code, message: r.body.error.message }))
    expect(new Set(shapes.map(s => JSON.stringify(s))).size).toBe(1)
  })

  it('refuses an INVITED user who has not set a password yet', async () => {
    await prisma.user.create({
      data: {
        organizationId: fx.orgId,
        email: 'pending@test.local',
        fullName: 'Pending',
        role: 'EMPLOYEE',
        status: 'INVITED',
      },
    })
    const res = await anon().post('/api/v1/auth/login', {
      email: 'pending@test.local',
      password: TEST_PASSWORD,
    })
    expect(res.status).toBe(401)
  })

  /** T-90. The lock must hold even when the password is right. */
  it('T-90: locks after 5 failures, and the lock holds for the correct password', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await anon().post('/api/v1/auth/login', {
        email: 'emp@test.local',
        password: 'DefinitelyWrong1',
      })
      expect(r.status).toBe(401)
    }

    const locked = await anon().post('/api/v1/auth/login', {
      email: 'emp@test.local',
      password: TEST_PASSWORD,
    })
    expect(locked.status).toBe(429)
    expect(locked.headers['retry-after']).toBeDefined()

    const row = await prisma.user.findUniqueOrThrow({ where: { id: fx.employee.id } })
    expect(row.lockedUntil).not.toBeNull()
  })

  it('resets the failure counter after a successful login', async () => {
    await anon().post('/api/v1/auth/login', { email: 'emp@test.local', password: 'Wrong1Wrong1' })
    await anon().post('/api/v1/auth/login', { email: 'emp@test.local', password: TEST_PASSWORD })
    const row = await prisma.user.findUniqueOrThrow({ where: { id: fx.employee.id } })
    expect(row.failedLoginCount).toBe(0)
    expect(row.lastLoginAt).not.toBeNull()
  })

  /** T-94. A session value planted before login must not survive it. */
  it('T-94: rotates the session identifier on login', async () => {
    const before = await anon().get('/api/v1/auth/csrf')
    const firstCookie = (before.headers['set-cookie'] as unknown as string[] | undefined)?.[0]

    const login = await anon().post('/api/v1/auth/login', {
      email: 'emp@test.local',
      password: TEST_PASSWORD,
    })
    const secondCookie = (login.headers['set-cookie'] as unknown as string[])[0]

    expect(secondCookie).toBeDefined()
    if (firstCookie) expect(secondCookie).not.toBe(firstCookie)
  })

  it('sets an HttpOnly, SameSite=Lax cookie and no client-readable token', async () => {
    const login = await anon().post('/api/v1/auth/login', {
      email: 'emp@test.local',
      password: TEST_PASSWORD,
    })
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0] ?? ''
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
  })
})

describe('authorization gate', () => {
  it('refuses unauthenticated access to every protected route', async () => {
    for (const path of ['/api/v1/rooms', '/api/v1/locations', '/api/v1/users', '/api/v1/auth/me']) {
      const res = await anon().get(path)
      expect(res.status, path).toBe(401)
      expect(res.body.error.code).toBe('UNAUTHENTICATED')
    }
  })

  /** T-97. Every mutating request needs a CSRF token. */
  it('T-97: rejects a mutating request with no CSRF token', async () => {
    const client = await signIn('admin@test.local')
    const res = await request_without_csrf(client.cookie)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('CSRF_FAILED')
  })

  it('rejects a forged CSRF token', async () => {
    const client = await signIn('admin@test.local')
    const res = await (await import('supertest'))
      .default(( await import('./helpers.js')).app)
      .post('/api/v1/rooms')
      .set('cookie', client.cookie)
      .set('x-csrf-token', 'not-a-real-token')
      .send({ locationId: fx.hqId, name: 'Nope', capacity: 2 })
    expect(res.status).toBe(403)
  })
})

async function request_without_csrf(cookie: string) {
  const supertest = (await import('supertest')).default
  const { app } = await import('./helpers.js')
  return supertest(app).post('/api/v1/rooms').set('cookie', cookie).send({ name: 'X', capacity: 1 })
}

describe('invitations and password reset', () => {
  it('invites a user, who then sets their own password and is signed in', async () => {
    const owner = await signIn('owner@test.local')
    const invite = await owner.post('/api/v1/users/invite', {
      email: 'newcomer@test.local',
      fullName: 'New Comer',
      role: 'EMPLOYEE',
    })
    expect(invite.status).toBe(201)
    expect(invite.body.data.status).toBe('INVITED')

    // The raw token exists only in the email; the database stores a hash.
    const sent = mailer.find(m => m.to === 'newcomer@test.local')
    expect(sent).toBeDefined()
    const token = /accept-invite\?token=([\w-]+)/.exec(sent!.text)?.[1]
    expect(token).toBeTruthy()

    const stored = await prisma.authToken.findFirst({ where: { purpose: 'INVITE' } })
    expect(stored?.tokenHash).not.toBe(token)

    const accept = await anon().post('/api/v1/auth/accept-invite', {
      token,
      fullName: 'New Comer',
      password: 'a-perfectly-fine-passphrase',
    })
    expect(accept.status).toBe(201)
    expect(accept.body.user.status).toBe('ACTIVE')
  })

  /** T-92. Tokens are single use. */
  it('T-92: refuses a token that has already been used', async () => {
    const token = await auth.sendInvitation(
      (
        await prisma.user.create({
          data: {
            organizationId: fx.orgId,
            email: 'once@test.local',
            fullName: 'Once Only',
            role: 'EMPLOYEE',
            status: 'INVITED',
          },
        })
      ).id,
    )

    const first = await anon().post('/api/v1/auth/accept-invite', {
      token,
      fullName: 'Once Only',
      password: 'first-time-passphrase-ok',
    })
    expect(first.status).toBe(201)

    const second = await anon().post('/api/v1/auth/accept-invite', {
      token,
      fullName: 'Once Only',
      password: 'second-time-passphrase',
    })
    expect(second.status).toBe(422)
  })

  it('T-93: refuses an expired token', async () => {
    const user = await prisma.user.create({
      data: {
        organizationId: fx.orgId,
        email: 'stale@test.local',
        fullName: 'Stale',
        role: 'EMPLOYEE',
        status: 'INVITED',
      },
    })
    const token = await auth.sendInvitation(user.id)
    await prisma.authToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const res = await anon().post('/api/v1/auth/accept-invite', {
      token,
      fullName: 'Stale',
      password: 'expired-token-passphrase',
    })
    expect(res.status).toBe(422)
  })

  it('resending an invitation invalidates the previous link (BR-U3)', async () => {
    const user = await prisma.user.create({
      data: {
        organizationId: fx.orgId,
        email: 'resend@test.local',
        fullName: 'Re Send',
        role: 'EMPLOYEE',
        status: 'INVITED',
      },
    })
    const first = await auth.sendInvitation(user.id)
    const second = await auth.sendInvitation(user.id)
    expect(first).not.toBe(second)

    const withOld = await anon().post('/api/v1/auth/accept-invite', {
      token: first,
      fullName: 'Re Send',
      password: 'old-link-should-fail-x',
    })
    expect(withOld.status).toBe(422)

    const withNew = await anon().post('/api/v1/auth/accept-invite', {
      token: second,
      fullName: 'Re Send',
      password: 'new-link-should-work-x',
    })
    expect(withNew.status).toBe(201)
  })

  it('reveals nothing on forgot-password for an unknown address', async () => {
    const known = await anon().post('/api/v1/auth/forgot-password', { email: 'emp@test.local' })
    const unknown = await anon().post('/api/v1/auth/forgot-password', { email: 'ghost@test.local' })
    expect(known.status).toBe(202)
    expect(unknown.status).toBe(202)
    expect(known.body).toEqual(unknown.body)
    expect(mailer.find(m => m.to === 'ghost@test.local')).toBeUndefined()
  })

  /** T-95. A reset must not leave an attacker signed in. */
  it('T-95: a password reset destroys the user other sessions', async () => {
    const client = await signIn('emp@test.local')
    expect((await client.get('/api/v1/auth/me')).status).toBe(200)

    await anon().post('/api/v1/auth/forgot-password', { email: 'emp@test.local' })
    const mail = mailer.find(m => m.to === 'emp@test.local' && m.subject.includes('Reset'))
    const token = /reset-password\?token=([\w-]+)/.exec(mail!.text)?.[1]

    const reset = await anon().post('/api/v1/auth/reset-password', {
      token,
      password: 'brand-new-passphrase-99',
    })
    expect(reset.status).toBe(200)

    // The old session must now be rejected.
    expect((await client.get('/api/v1/auth/me')).status).toBe(401)
  })

  it('rejects a weak or personal password', async () => {
    const user = await prisma.user.create({
      data: {
        organizationId: fx.orgId,
        email: 'weak@test.local',
        fullName: 'Weak Choice',
        role: 'EMPLOYEE',
        status: 'INVITED',
      },
    })
    const token = await auth.sendInvitation(user.id)

    const tooShort = await anon().post('/api/v1/auth/accept-invite', {
      token,
      fullName: 'Weak Choice',
      password: 'short',
    })
    expect(tooShort.status).toBe(422)

    const common = await anon().post('/api/v1/auth/accept-invite', {
      token,
      fullName: 'Weak Choice',
      password: 'password1234',
    })
    expect(common.status).toBe(422)
    expect(common.body.error.details.fields.password).toMatch(/common/i)
  })
})

describe('session invalidation', () => {
  /** T-96. Deactivation must take effect on the very next request. */
  it('T-96: a deactivated user is rejected immediately', async () => {
    const victim = await signIn('emp@test.local')
    expect((await victim.get('/api/v1/auth/me')).status).toBe(200)

    const owner = await signIn('owner@test.local')
    const res = await owner.post(`/api/v1/users/${fx.employee.id}/deactivate`, { force: false })
    expect(res.status).toBe(200)

    expect((await victim.get('/api/v1/auth/me')).status).toBe(401)
  })

  it('logging out destroys the session', async () => {
    const client = await signIn('emp@test.local')
    expect((await client.post('/api/v1/auth/logout')).status).toBe(204)
    expect((await client.get('/api/v1/auth/me')).status).toBe(401)
  })
})
