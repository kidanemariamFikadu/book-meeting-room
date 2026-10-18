/**
 * Password hashing and strength.
 *
 * Argon2id at the OWASP-recommended floor: 19 MiB of memory, 2 iterations,
 * parallelism 1. Memory-hardness is the point — it is what makes offline
 * cracking of a stolen hash expensive rather than merely slow.
 *
 * Specification: docs/08-security.md section 2.
 */

import { hash, verify, Algorithm } from '@node-rs/argon2'

const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const

/**
 * A dummy hash of a random value, used to spend the same CPU time when no user
 * exists as when one does. Without it, login response time reveals whether an
 * email address is registered — the timing side of user enumeration (T-91).
 */
let dummyHash: string | null = null

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS)
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, OPTIONS)
  } catch {
    // A malformed hash in the database must read as "wrong password", never as
    // an error that behaves differently from a failed login.
    return false
  }
}

/**
 * Burn equivalent CPU when the account does not exist. Call this on the
 * no-such-user path so that path costs what the real one costs.
 */
export async function verifyPasswordDummy(plain: string): Promise<false> {
  dummyHash ??= await hash('a-value-no-user-will-ever-have', OPTIONS)
  await verify(dummyHash, plain, OPTIONS).catch(() => false)
  return false
}

/**
 * The most-breached passwords, by prefix and by exact match.
 *
 * A full Have-I-Been-Pwned corpus is the better answer and is noted for later;
 * this list blocks the passwords that actually appear in credential-stuffing
 * lists while adding no dependency and no network call to the signup path.
 */
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  'passw0rd', 'p@ssword', 'p@ssw0rd', 'passwordpassword',
  '123456789012', '1234567890123', '111111111111', '000000000000',
  'qwertyuiop12', 'qwerty123456', 'qwertyuiopas',
  'iloveyou1234', 'letmein12345', 'welcome12345', 'welcome123456',
  'administrator', 'adminadmin12', 'administrator1',
  'changeme1234', 'changeit1234', 'secret123456',
  'football1234', 'baseball1234', 'princess1234', 'sunshine1234',
  'trustno1nono', 'monkeymonkey', 'dragondragon',
  'abc123abc123', 'aaaaaaaaaaaa', 'zzzzzzzzzzzz',
  'roombook1234', 'meetingroom1', 'bookingroom1',
])

export interface PasswordCheck {
  ok: boolean
  reason?: string
}

/**
 * Length plus a breached-password check, with no composition rules and no
 * forced rotation. That is current NIST and OWASP guidance: complexity rules
 * produce predictable substitutions (Password1!) and rotation produces sticky
 * notes, while length does real work.
 */
export function checkPasswordStrength(plain: string, context: string[] = []): PasswordCheck {
  if (plain.length < 12) {
    return { ok: false, reason: 'Use at least 12 characters' }
  }
  if (plain.length > 200) {
    return { ok: false, reason: 'That password is unreasonably long' }
  }

  const normalized = plain.toLowerCase().replace(/[^a-z0-9@]/g, '')
  if (COMMON.has(normalized)) {
    return { ok: false, reason: 'That password is too common - please choose another' }
  }

  // A single repeated character, or a straight run of digits, passes a length
  // check but is trivially guessed.
  if (/^(.)\1+$/.test(plain)) {
    return { ok: false, reason: 'Use more than one repeated character' }
  }
  if (/^(?:0123456789|1234567890|9876543210)/.test(plain.replace(/\D/g, ''))) {
    return { ok: false, reason: 'Avoid sequential digits' }
  }

  // Reject the user's own name or email local-part: the first thing an attacker
  // who knows the target will try.
  for (const item of context) {
    const token = item.toLowerCase().split('@')[0]?.replace(/[^a-z0-9]/g, '') ?? ''
    if (token.length >= 4 && normalized.includes(token)) {
      return { ok: false, reason: 'Do not use your name or email address in your password' }
    }
  }

  return { ok: true }
}
