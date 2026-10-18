/**
 * Test environment.
 *
 * Set before any module reads config, so the server never starts a real SMTP
 * transport or enforces production-only guards during tests.
 */

process.env.NODE_ENV = 'test'
process.env.TZ = 'UTC'
process.env.MAIL_TRANSPORT ??= 'console'
process.env.LOG_LEVEL ??= 'silent'
// Rate limits are exercised by their own dedicated tests; leaving them on for
// every test would make unrelated suites fail once they tripped.
process.env.RATE_LIMIT_DISABLED ??= 'true'
process.env.APP_URL ??= 'http://localhost:5173'
process.env.SESSION_SECRET ??= 'test-session-secret-at-least-32-chars-long'
process.env.DATABASE_URL ??=
  'postgresql://roombook:roombook_dev@localhost:5432/roombook_test?schema=public'
