/**
 * Entry point: build the app, verify the database, start listening, then start
 * the background workers.
 *
 * The ordering matters. Workers start only after the listener is up, so a
 * worker crash-loop cannot stop the app from reporting its own health.
 *
 * Specification: docs/09-configuration.md section 3.
 */

import { config } from './config.js'
import { createApp } from './app.js'
import { disconnect, prisma } from './db.js'
import { startOutboxWorker, stopOutboxWorker } from './mail/OutboxWorker.js'
import { logger } from './middleware/requestContext.js'
import { startReminderWorker, stopReminderWorker } from './workers/ReminderWorker.js'

async function main(): Promise<void> {
  logger.info(
    {
      env: config.NODE_ENV,
      port: config.PORT,
      appUrl: config.APP_URL,
      mail: config.MAIL_TRANSPORT,
      workers: config.WORKERS_ENABLED,
      calendarSync: config.CALENDAR_SYNC_ENABLED,
    },
    'Starting RoomBook',
  )

  // Fail fast and loudly: a server that accepts traffic it cannot serve is
  // harder to diagnose than one that refuses to start.
  try {
    await prisma.$queryRaw`SELECT 1`
    logger.info('Database connection verified')
  } catch (err) {
    logger.fatal(
      { err },
      'Cannot reach the database. Is PostgreSQL running? Try: npm run docker:up',
    )
    process.exit(1)
  }

  const app = createApp()
  const server = app.listen(config.PORT, () => {
    logger.info(`API listening on http://localhost:${config.PORT}`)
    if (config.isDevelopment) {
      logger.info('UI (Vite dev server) expected at http://localhost:5173')
      logger.info('Captured email at http://localhost:8025')
    }
  })

  /*
   * Workers run in this process, after the listener is up so a worker
   * crash-loop cannot stop the app reporting its own health.
   *
   * The flag lets additional instances run with WORKERS_ENABLED=false, which
   * is how the single-instance assumption (A6) is honoured without job leases.
   * Two instances both running the reminder worker would duplicate reminders.
   */
  if (config.WORKERS_ENABLED) {
    startOutboxWorker()
    startReminderWorker()
  } else {
    logger.info('Workers disabled on this instance')
  }

  /**
   * Graceful shutdown. Stop accepting connections, let in-flight requests
   * finish, then close the pool. The 15-second cap stops a hung request from
   * blocking a deploy indefinitely.
   */
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'Shutting down')

    const forceExit = setTimeout(() => {
      logger.error('Shutdown timed out after 15s - exiting')
      process.exit(1)
    }, 15_000)
    forceExit.unref()

    stopOutboxWorker()
    stopReminderWorker()

    server.close(async closeErr => {
      if (closeErr) logger.error({ err: closeErr }, 'Error closing HTTP server')
      try {
        await disconnect()
        logger.info('Shutdown complete')
        process.exit(0)
      } catch (err) {
        logger.error({ err }, 'Error during shutdown')
        process.exit(1)
      }
    })
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  // An unhandled rejection leaves the process in an unknown state. Log it and
  // exit so the orchestrator restarts cleanly, rather than limping on.
  process.on('unhandledRejection', reason => {
    logger.fatal({ reason }, 'Unhandled promise rejection')
    void shutdown('unhandledRejection')
  })
  process.on('uncaughtException', err => {
    logger.fatal({ err }, 'Uncaught exception')
    process.exit(1)
  })
}

void main()
