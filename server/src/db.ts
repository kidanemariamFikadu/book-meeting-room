/**
 * The Prisma client singleton.
 *
 * A single instance per process: Prisma manages its own connection pool, and
 * creating a client per request exhausts the database long before anything else.
 */

import { PrismaClient } from '@prisma/client'

import { config } from './config.js'
import { logger } from './middleware/requestContext.js'

/**
 * Declared `as const` and unconditionally, because Prisma infers the valid
 * `$on` event names from this tuple. A ternary here collapses the union to
 * `never` and every `$on` call stops type-checking. Which events are actually
 * *logged* is decided below instead.
 */
const logConfig = [
  { emit: 'event', level: 'query' },
  { emit: 'event', level: 'warn' },
  { emit: 'event', level: 'error' },
] as const

/**
 * `tsx watch` reloads modules on save. Without stashing the client on
 * globalThis, every reload would open a fresh pool and the database would
 * start refusing connections after a few dozen edits.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createClient() {
  const client = new PrismaClient({ log: [...logConfig] })

  // Only slow queries, and only in development, or the log is unreadable.
  client.$on('query', e => {
    if (config.isDevelopment && e.duration >= 50) {
      logger.debug({ durationMs: e.duration, query: e.query }, 'Slow query')
    }
  })

  client.$on('warn', e => logger.warn({ target: e.target }, e.message))
  client.$on('error', e => logger.error({ target: e.target }, e.message))

  return client
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient()

if (config.isDevelopment) {
  globalForPrisma.prisma = prisma
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
}
