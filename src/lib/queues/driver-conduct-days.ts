/**
 * Driver Conduct built a fleet day at a time each night (modules/reports/
 * driver-conduct-days), a BullMQ repeatable run by the report worker, off the
 * API: it reads only our own tables, after the dashcam capture has saved the
 * night's alarms (DASHCAM_CAPTURE_CRON, 01:30 EAT).
 *
 * Each cycle clears the days that have expired (a month's on the 5th of the
 * next) and builds every past day of the last month still kept that is
 * missing, the last few again, and any whose dashcam capture is newer. The
 * first cycle after a deploy builds the whole month.
 *
 * DRIVER_CONDUCT_DAYS: 'apply' (default) or 'off'. Until the migration has
 * made the tables, each cycle logs that and writes nothing; the page reads
 * every day live, as before.
 */

import { Queue, type Job } from 'bullmq'
import { TracedWorker as Worker } from '../tracing.js'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { runConductDays } from '../../modules/reports/driver-conduct-days.js'

export const DRIVER_CONDUCT_DAYS_QUEUE = 'driver-conduct-days'
const BUILD_JOB = 'driver-conduct-days:nightly'
const FIRST_JOB = 'driver-conduct-days:start'

let queue: Queue | null = null
let worker: Worker | null = null
let running = false

export interface DriverConductDaysHandle { stop: () => Promise<void> }

export async function startDriverConductDays(): Promise<DriverConductDaysHandle> {
  const noop: DriverConductDaysHandle = { stop: async () => {} }
  if (env.DRIVER_CONDUCT_DAYS === 'off') {
    logger.warn('DRIVER_CONDUCT_DAYS=off: driver conduct days NOT built')
    return noop
  }
  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL: driver conduct days NOT built; the Reports page reads every day live')
    return noop
  }

  queue = new Queue(DRIVER_CONDUCT_DAYS_QUEUE, { connection })
  // Repeatable jobs accumulate in Redis when their schedule changes.
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === BUILD_JOB) await queue.removeRepeatableByKey(r.key)
  }
  const opts = { removeOnComplete: { count: 30 }, removeOnFail: { count: 30 }, attempts: 2, backoff: { type: 'exponential' as const, delay: 600_000 } }
  await queue.add(BUILD_JOB, {}, { ...opts, repeat: { pattern: env.DRIVER_CONDUCT_DAYS_CRON } })
  // One cycle on start too: a deploy, or a migration run since, need not wait for the night.
  // A fixed id, so a restart loop does not queue one per start.
  await queue.add(FIRST_JOB, {}, { ...opts, jobId: `${FIRST_JOB}:${new Date().toISOString().slice(0, 13)}`, delay: 60_000 })

  worker = new Worker(DRIVER_CONDUCT_DAYS_QUEUE, async (job: Job) => {
    if (job.name !== BUILD_JOB && job.name !== FIRST_JOB) return
    if (running) {
      logger.warn({ jobId: job.id }, 'Driver conduct days: previous cycle still running; skipping this tick')
      return
    }
    running = true
    try {
      const c = await runConductDays({ rebuild: env.DRIVER_CONDUCT_DAYS_REBUILD })
      return { keepFrom: c.keepFrom, expired: c.expired, built: c.built.length, failed: c.failed, skipped: c.skipped, ms: c.ms }
    } finally { running = false }
  }, { connection, concurrency: 1 })

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Driver conduct days job failed'))
  logger.info({ queue: DRIVER_CONDUCT_DAYS_QUEUE, cron: env.DRIVER_CONDUCT_DAYS_CRON }, 'Driver conduct days scheduled')

  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue = null
    },
  }
}
