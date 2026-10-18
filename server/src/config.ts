/**
 * Environment configuration, parsed and validated once at boot.
 *
 * A missing or malformed required variable stops the process immediately with a
 * readable message. The system never starts half-configured — the failure mode
 * that produces is far worse: an app that runs but silently does not send email.
 *
 * Specification: docs/09-configuration.md.
 */

import { z } from 'zod'

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform(v => (v === undefined ? fallback : v === 'true' || v === '1'))

const int = (fallback: number) =>
  z.coerce.number().int().optional().transform(v => v ?? fallback)

const base64Key = z
  .string()
  .refine(v => Buffer.from(v, 'base64').length === 32, 'Must decode to exactly 32 bytes')

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(3000),
    /** Every link in every email is built from this. */
    APP_URL: z.string().url(),
    DATABASE_URL: z.string().min(1),
    SESSION_SECRET: z.string().min(32, 'Use at least 32 characters of randomness'),

    TZ: z.string().default('UTC'),
    // 'silent' is a real pino level and is what the test setup uses.
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: int(0),

    MAIL_TRANSPORT: z.enum(['smtp', 'console']).default('console'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: int(587),
    SMTP_SECURE: bool(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    MAIL_FROM_NAME: z.string().default('RoomBook'),
    MAIL_FROM_ADDRESS: z.string().email().default('rooms@example.com'),

    WORKERS_ENABLED: bool(true),
    OUTBOX_POLL_MS: int(15_000),
    REMINDER_POLL_MS: int(60_000),

    RECURRENCE_HORIZON_DAYS: int(365),
    RECURRENCE_MAX_OCCURRENCES: int(500),

    CALENDAR_SYNC_ENABLED: bool(false),
    CALENDAR_TOKEN_KEY: base64Key.optional(),
    CALENDAR_TOKEN_KEY_PREVIOUS: base64Key.optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_TENANT_ID: z.string().default('common'),
    CALENDAR_WEBHOOK_BASE_URL: z.string().url().optional(),
    CALENDAR_SYNC_POLL_MS: int(10_000),
    CALENDAR_RECONCILE_HOURS: int(6),

    RATE_LIMIT_DISABLED: bool(false),
  })
  // Guards against the configurations that are individually valid but
  // collectively wrong. Each of these would otherwise fail silently in
  // production rather than loudly at boot.
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message })

    if (env.NODE_ENV === 'production') {
      if (env.MAIL_TRANSPORT === 'console') {
        fail('MAIL_TRANSPORT', 'The console mailer must not be used in production')
      }
      if (env.RATE_LIMIT_DISABLED) {
        fail('RATE_LIMIT_DISABLED', 'Rate limiting cannot be disabled in production')
      }
      if (env.APP_URL.startsWith('http://')) {
        fail('APP_URL', 'APP_URL must use HTTPS in production')
      }
      if (/change-me|example|secret|password/i.test(env.SESSION_SECRET)) {
        fail('SESSION_SECRET', 'Replace the placeholder session secret')
      }
    }

    if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) {
      fail('SMTP_HOST', 'SMTP_HOST is required when MAIL_TRANSPORT is "smtp"')
    }

    // Calendar sync has several interdependent settings; checking them together
    // is the only way to catch a half-configured integration before it fails
    // against a live provider.
    if (env.CALENDAR_SYNC_ENABLED) {
      if (!env.CALENDAR_TOKEN_KEY) {
        fail('CALENDAR_TOKEN_KEY', 'A 32-byte base64 key is required to encrypt OAuth tokens')
      }
      const hasGoogle = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
      const hasMicrosoft = Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET)
      if (!hasGoogle && !hasMicrosoft) {
        fail(
          'GOOGLE_CLIENT_ID',
          'Configure at least one calendar provider, or set CALENDAR_SYNC_ENABLED=false',
        )
      }
      if (!env.CALENDAR_WEBHOOK_BASE_URL) {
        fail(
          'CALENDAR_WEBHOOK_BASE_URL',
          'A publicly reachable HTTPS base URL is required; providers will not deliver to localhost',
        )
      }
    }
  })

export type Config = z.infer<typeof schema> & {
  isProduction: boolean
  isDevelopment: boolean
  isTest: boolean
}

/**
 * An environment variable that is present but empty means "not set".
 *
 * `.env` files conventionally list every key with a blank value as
 * documentation, so without this an unused optional setting such as
 * `GOOGLE_CLIENT_ID=` fails validation and the process refuses to start.
 */
function withoutEmptyStrings(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    out[key] = value === '' ? undefined : value
  }
  return out
}

function load(): Config {
  const parsed = schema.safeParse(withoutEmptyStrings(process.env))

  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    // Written to stderr rather than the logger: the logger is configured from
    // this very object, so it may not exist yet.
    process.stderr.write(
      `\nRoomBook cannot start - invalid configuration:\n${lines.join('\n')}\n\n` +
        `Check your .env against .env.example (see docs/09-configuration.md).\n\n`,
    )
    process.exit(1)
  }

  const env = parsed.data
  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isDevelopment: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
  }
}

export const config = load()
