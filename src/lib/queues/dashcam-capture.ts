/**
 * Save the dashcam alarms of the last few days each night (modules/dashcam/
 * dashcam-capture), a BullMQ repeatable like the Wialon registry sync.
 *
 * VSS keeps alarms about two weeks; this keeps their numbers for good. Each
 * night it captures the last DASHCAM_CAPTURE_DAYS fleet days again for every
 * organisation with dashcams: cameras offline for a while upload late, and an
 * alarm VSS gave no type yesterday takes it today. Re-capturing is safe.
 *
 * Runs in the vss-worker process (src/vss-worker.ts) beside the 5-minute sync
 * (lib/queues/vss-sync), sharing its VSS queue (one search at a time, 10 s
 * apart). Each captured day is cached for the Alarms page as well.
 *
 * DASHCAM_CAPTURE: 'apply' (default) or 'off'. Until the migration has made
 * the tables, each cycle logs that and writes nothing.
 */

import { Queue, type Job } from 'bullmq'
import { TracedWorker as Worker } from '../tracing.js'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { captureDay, dashcamTablesReady, lastDays, organisationsWithCameras, type DayCapture } from '../../modules/dashcam/dashcam-capture.js'

export const DASHCAM_CAPTURE_QUEUE = 'dashcam-capture'
const CAPTURE_JOB = 'dashcam-capture:nightly'

export interface DashcamCaptureCycle {
  days: string[]
  orgs: Array<{ org: string; days: Array<Omit<DayCapture, 'orgId'>>; error?: string }>
  skipped?: 'no-tables'
  ms: number
}

/** One cycle: the last `days` fleet days for every organisation with dashcams. Exported to run by hand or from a test. */
export async function runDashcamCapture(days = env.DASHCAM_CAPTURE_DAYS, now = Date.now()): Promise<DashcamCaptureCycle> {
  const startedAt = Date.now()
  const list = lastDays(days, now)
  const cycle: DashcamCaptureCycle = { days: list, orgs: [], ms: 0 }
  if (!(await dashcamTablesReady())) {
    cycle.skipped = 'no-tables'
    logger.warn('Dashcam capture: tables not there yet (migration not run) — nothing captured')
    return cycle
  }
  for (const o of await organisationsWithCameras()) {
    const entry: DashcamCaptureCycle['orgs'][number] = { org: o.code, days: [] }
    for (const day of list) {
      try {
        const { orgId: _o, ...r } = await captureDay(o.id, day, { now })
        entry.days.push(r)
      } catch (err) {
        // One day failing (VSS busy) must not abandon the rest; the next night captures it again.
        entry.error = err instanceof Error ? err.message : String(err)
        logger.warn({ err, org: o.code, day }, 'Dashcam capture: day not captured — tried again next cycle')
      }
    }
    cycle.orgs.push(entry)
  }
  cycle.ms = Date.now() - startedAt
  logger.info({
    days: list,
    orgs: cycle.orgs.map((o) => ({ org: o.org, alarms: o.days.reduce((s, d) => s + d.alarms, 0), added: o.days.reduce((s, d) => s + d.added, 0), untyped: o.days.reduce((s, d) => s + d.untyped, 0), partial: o.days.filter((d) => d.partial).length, error: o.error })),
    ms: cycle.ms,
  }, 'Dashcam capture cycle complete')
  return cycle
}

let queue:  Queue  | null = null
let worker: Worker | null = null
let running = false

export interface DashcamCaptureHandle { stop: () => Promise<void> }

export async function startDashcamCapture(): Promise<DashcamCaptureHandle> {
  const noop: DashcamCaptureHandle = { stop: async () => {} }
  if (env.DASHCAM_CAPTURE === 'off') {
    logger.warn('DASHCAM_CAPTURE=off — dashcam capture NOT started')
    return noop
  }
  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — dashcam capture NOT started; run `npm run dashcam:backfill -- --apply` by hand')
    return noop
  }

  queue = new Queue(DASHCAM_CAPTURE_QUEUE, { connection })
  // Repeatable jobs accumulate in Redis when their schedule changes.
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === CAPTURE_JOB) await queue.removeRepeatableByKey(r.key)
  }
  await queue.add(CAPTURE_JOB, {}, {
    repeat:           { pattern: env.DASHCAM_CAPTURE_CRON },
    removeOnComplete: { count: 30 },
    removeOnFail:     { count: 30 },
    attempts:         2,
    backoff:          { type: 'exponential', delay: 600_000 },
  })

  worker = new Worker(DASHCAM_CAPTURE_QUEUE, async (job: Job) => {
    if (job.name !== CAPTURE_JOB) return
    if (running) {
      logger.warn({ jobId: job.id }, 'Dashcam capture: previous cycle still running — skipping this tick')
      return
    }
    running = true
    try { return await runDashcamCapture() } finally { running = false }
  }, { connection, concurrency: 1 })

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Dashcam capture job failed'))

  logger.info({ queue: DASHCAM_CAPTURE_QUEUE, cron: env.DASHCAM_CAPTURE_CRON, days: env.DASHCAM_CAPTURE_DAYS }, 'Dashcam capture scheduled')

  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue  = null
    },
  }
}
