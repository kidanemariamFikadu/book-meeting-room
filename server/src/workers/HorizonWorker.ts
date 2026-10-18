/**
 * Rolls recurring series forward.
 *
 * Materialized occurrences exist only so far into the future, so an
 * open-ended series needs its window extended as time passes. Without this a
 * weekly standup would simply stop appearing a year out.
 *
 * Specification: docs/12-recurrence.md section 1.
 */

import { logger } from '../middleware/requestContext.js'
import { rollHorizon } from '../services/SeriesService.js'

let timer: NodeJS.Timeout | null = null
let running = false

/**
 * Hourly rather than nightly.
 *
 * The work is idempotent and cheap - only series whose horizon falls within
 * 30 days are touched - and running more often means a restart cannot leave
 * the window short until the small hours.
 */
const INTERVAL_MS = 60 * 60 * 1000

export function startHorizonWorker(): void {
  if (timer) return

  const tick = async () => {
    if (running) return
    running = true
    try {
      const result = await rollHorizon()
      if (result.occurrencesAdded > 0) logger.info(result, 'Recurring series extended')
    } catch (err) {
      logger.error({ err }, 'Horizon roll failed')
    } finally {
      running = false
    }
  }

  timer = setInterval(() => void tick(), INTERVAL_MS)
  timer.unref()
  logger.info('Horizon worker started')
  void tick()
}

export function stopHorizonWorker(): void {
  if (timer) clearInterval(timer)
  timer = null
}
