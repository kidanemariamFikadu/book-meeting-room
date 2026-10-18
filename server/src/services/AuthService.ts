/**
 * Authentication: login, lockout, invitations, password reset.
 *
 * Services take plain arguments and throw typed errors. They never touch `req`
 * or `res`, which is what lets the workers reuse them and lets tests exercise
 * the rules without HTTP.
 *
 * Specification: docs/01-requirements.md FR-1, docs/08-security.md section 2.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { TokenPurpose } from '@prisma/client'

import { config } from '../config.js'
import { prisma } from '../db.js'
import {
  InvalidCredentialsError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '../domain/errors.js'
import {
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
  verifyPasswordDummy,
} from '../domain/password.js'
import { getMailer } from '../mail/Mailer.js'
import { logger } from '../middleware/requestContext.js'
import { destroyUserSessions } from '../middleware/session.js'
import * as audit from './AuditService.js'

/** FR-1.4: 5 failures per email in 15 minutes, then a 15-minute lock. */
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  INVITE: 72 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
  EMAIL_CHANGE: 24 * 60 * 60 * 1000,
}

/**
 * Tokens are 256-bit random values. Only the SHA-256 is stored, so a database
 * dump cannot be used to accept invitations or reset passwords — the raw token
 * exists only in the email that was sent.
 */
function newToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url')
  return { raw, hash: hashToken(raw) }
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export interface LoginResult {
  userId: string
  organizationId: string
}

/**
 * Verifies credentials.
 *
 * Every failure path returns the SAME error and spends comparable CPU, so the
 * endpoint cannot be used to discover whether an address is registered, or
 * whether an account is disabled (T-91). That is why the no-such-user branch
 * still runs an Argon2 verification against a dummy hash.
 */
export async function login(
  email: string,
  plainPassword: string,
  ip?: string,
): Promise<LoginResult> {
  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase() },
    select: {
      id: true,
      organizationId: true,
      email: true,
      fullName: true,
      passwordHash: true,
      status: true,
      failedLoginCount: true,
      lockedUntil: true,
    },
  })

  if (!user) {
    await verifyPasswordDummy(plainPassword)
    throw new InvalidCredentialsError()
  }

  // The lock holds even for the correct password — otherwise an attacker who
  // guesses correctly on attempt six is rewarded (T-90).
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000)
    throw new RateLimitError(seconds, 'Too many failed attempts - please try again later')
  }

  // An INVITED user has no password yet; a DISABLED user must not sign in.
  // Both must be indistinguishable from a wrong password (BR-U4).
  if (user.status !== 'ACTIVE' || !user.passwordHash) {
    await verifyPasswordDummy(plainPassword)
    throw new InvalidCredentialsError()
  }

  const ok = await verifyPassword(user.passwordHash, plainPassword)

  if (!ok) {
    const failed = user.failedLoginCount + 1
    const lock = failed >= MAX_FAILED_ATTEMPTS
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MS) : null,
      },
    })
    await audit.record({
      actor: { id: user.id, organizationId: user.organizationId, email: user.email },
      eventType: 'LOGIN_FAILED',
      entityType: 'user',
      entityId: user.id,
      ip: ip ?? null,
      after: { failedAttempts: failed, locked: lock },
    })
    throw new InvalidCredentialsError()
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  })

  await audit.record({
    actor: {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      fullName: user.fullName,
    },
    eventType: 'LOGIN_SUCCEEDED',
    entityType: 'user',
    entityId: user.id,
    ip: ip ?? null,
  })

  return { userId: user.id, organizationId: user.organizationId }
}

/** Issues a single-use token and returns the raw value for the email link. */
async function issueToken(userId: string, purpose: TokenPurpose, newEmail?: string) {
  // Any outstanding token of the same purpose is consumed, so resending an
  // invitation invalidates the previous link (BR-U3, T-92).
  await prisma.authToken.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  })

  const { raw, hash } = newToken()
  await prisma.authToken.create({
    data: {
      userId,
      purpose,
      tokenHash: hash,
      newEmail: newEmail ?? null,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS[purpose]),
    },
  })
  return raw
}

async function consumeToken(raw: string, purpose: TokenPurpose) {
  const row = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: {
      user: {
        select: { id: true, organizationId: true, email: true, fullName: true, status: true },
      },
    },
  })

  // One message for every failure mode: wrong, expired, already used, or for
  // the wrong purpose. Distinguishing them would tell an attacker which part of
  // a guessed token was right.
  const invalid = new ValidationError('That link is no longer valid. Please request a new one.')

  if (!row) throw invalid
  if (!constantTimeEqual(row.tokenHash, hashToken(raw))) throw invalid
  if (row.purpose !== purpose) throw invalid
  if (row.consumedAt) throw invalid
  if (row.expiresAt.getTime() <= Date.now()) throw invalid

  await prisma.authToken.update({ where: { id: row.id }, data: { consumedAt: new Date() } })
  return row
}

/** Sends an invitation and returns the raw token (for tests and dev tooling). */
export async function sendInvitation(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, fullName: true, organization: { select: { name: true } } },
  })
  if (!user) throw new NotFoundError('That user')

  const token = await issueToken(user.id, 'INVITE')
  const link = `${config.APP_URL}/accept-invite?token=${token}`

  await getMailer().send({
    to: user.email,
    toName: user.fullName,
    subject: `You have been invited to ${user.organization.name} room booking`,
    text: [
      `Hello ${user.fullName},`,
      '',
      `You have been invited to use ${user.organization.name} room booking, where you can`,
      'see which meeting rooms are free and book them.',
      '',
      'Set your password to get started:',
      link,
      '',
      'This link can only be used once and expires in 72 hours.',
    ].join('\n'),
  })

  return token
}

export async function acceptInvitation(
  raw: string,
  fullName: string,
  plainPassword: string,
): Promise<LoginResult> {
  const token = await consumeToken(raw, 'INVITE')

  const strength = checkPasswordStrength(plainPassword, [fullName, token.user.email])
  if (!strength.ok) throw new ValidationError(strength.reason, { password: strength.reason! })

  const passwordHash = await hashPassword(plainPassword)

  await prisma.user.update({
    where: { id: token.user.id },
    data: { fullName, passwordHash, status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null },
  })

  logger.info({ userId: token.user.id }, 'Invitation accepted')

  return { userId: token.user.id, organizationId: token.user.organizationId }
}

/**
 * Starts a password reset.
 *
 * Returns nothing and reveals nothing: the endpoint responds 202 whether or not
 * the address exists, so it cannot be used to enumerate accounts.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase(), status: 'ACTIVE' },
    select: { id: true, email: true, fullName: true, organization: { select: { name: true } } },
  })

  if (!user) {
    logger.info({ email: maskEmail(email) }, 'Password reset requested for unknown address')
    return
  }

  const token = await issueToken(user.id, 'PASSWORD_RESET')
  const link = `${config.APP_URL}/reset-password?token=${token}`

  await getMailer().send({
    to: user.email,
    toName: user.fullName,
    subject: `Reset your ${user.organization.name} room booking password`,
    text: [
      `Hello ${user.fullName},`,
      '',
      'Use this link to choose a new password:',
      link,
      '',
      'The link can only be used once and expires in one hour.',
      '',
      'If you did not request this, you can ignore this email - your password',
      'has not changed.',
    ].join('\n'),
  })
}

export async function resetPassword(raw: string, plainPassword: string): Promise<LoginResult> {
  const token = await consumeToken(raw, 'PASSWORD_RESET')

  const strength = checkPasswordStrength(plainPassword, [
    token.user.fullName,
    token.user.email,
  ])
  if (!strength.ok) throw new ValidationError(strength.reason, { password: strength.reason! })

  await prisma.user.update({
    where: { id: token.user.id },
    data: {
      passwordHash: await hashPassword(plainPassword),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  })

  // Every other session is destroyed: if the reset was triggered because an
  // account was compromised, leaving the attacker signed in defeats the point.
  await destroyUserSessions(token.user.id)
  await notifyPasswordChanged(token.user.id)

  return { userId: token.user.id, organizationId: token.user.organizationId }
}

export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId?: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, fullName: true, passwordHash: true },
  })
  if (!user?.passwordHash) throw new NotFoundError('That user')

  if (!(await verifyPassword(user.passwordHash, currentPassword))) {
    throw new ValidationError('Your current password is not correct', {
      currentPassword: 'Your current password is not correct',
    })
  }

  const strength = checkPasswordStrength(newPassword, [user.fullName, user.email])
  if (!strength.ok) throw new ValidationError(strength.reason, { newPassword: strength.reason! })

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  })

  await destroyUserSessions(userId, keepSessionId)
  await notifyPasswordChanged(userId)
}

/**
 * A security notice, sent even when the user changed it themselves — that is
 * precisely how someone learns their account was taken over.
 */
async function notifyPasswordChanged(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, fullName: true },
  })
  if (!user) return

  await getMailer().send({
    to: user.email,
    toName: user.fullName,
    subject: 'Your password was changed',
    text: [
      `Hello ${user.fullName},`,
      '',
      `Your room booking password was changed on ${new Date().toUTCString()}.`,
      '',
      'If this was not you, contact your administrator immediately.',
    ].join('\n'),
  })
}

/**
 * The user as the client needs them, plus the permission-relevant fields the
 * SPA uses to decide what to render.
 *
 * Deliberately explicit about what it selects: a `select` rather than returning
 * the row means a column added later (a password hash field, an OAuth token)
 * cannot leak into an API response by accident.
 */
export async function describeUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      timezone: true,
      homeLocationId: true,
      emailOptOutReminders: true,
      lastLoginAt: true,
      organization: { select: { id: true, name: true, defaultTimezone: true } },
      homeLocation: { select: { id: true, name: true, timezone: true } },
      locationAccess: { select: { locationId: true } },
    },
  })
  if (!user) throw new NotFoundError('That user')

  const { locationAccess, ...rest } = user
  return {
    ...rest,
    adminLocationIds: locationAccess.map(a => a.locationId),
    // An ADMIN with no grants is organization-wide, so the client needs to know
    // which case it is looking at rather than inferring from an empty list.
    administersAllLocations: user.role !== 'EMPLOYEE' && locationAccess.length === 0,
  }
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  const shown = local.length <= 2 ? local.slice(0, 1) : `${local[0]}***${local.at(-1)}`
  return `${shown}@${domain}`
}
