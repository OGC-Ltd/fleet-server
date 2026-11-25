/**
 * Back-fill the dashcam days the vss-worker missed (worker down, a deploy
 * gap, VSS busy): every past fleet day in the last VSS_BACKFILL_DAYS (13,
 * inside VSS's two weeks) that has no dashcam_capture_days row, or one marked
 * partial, is captured again into dashcam_alarms and the Redis day cache.
 *
 * Runs once when the worker starts, then on VSS_BACKFILL_CRON (hourly). The
 * oldest days go first: VSS drops them soonest. One organisation-day at a
 * time, BACKFILL_GAP_MS apart, through the worker's own VSS search queue, so
 * the 5-minute sync of today keeps its turn. A "too frequent" answer ends the
 * run; the next one carries on where it stopped. Replaces running
 * `npm run dashcam:backfill` by hand.
 */

import { Queue, type Job } from 'bullmq'
import { TracedWorker as Worker } from '../tracing.js'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { VssError, VSS_TOO_FREQUENT, VSS_LOGIN_LIMITED } from '../../providers/vss/index.js'
import { captureDay, dashcamTablesReady, missedDays, organisationsWithCameras } from '../../modules/dashcam/dashcam-capture.js'
import { lastDays } from '../../modules/dashcam/fleet-day.js'

export const VSS_BACKFILL_QUEUE = 'vss-backfill'
const BACKFILL_JOB = 'vss-backfill:missed'
const STARTUP_JOB = 'vss-backfill:startup'
let BACKFILL_GAP_MS = 15_000

export interface VssBackfillRun {
  window: string[]
  captured: Array<{ org: string; day: string; alarms: number; added: number; partial: boolean }>
  failed: Array<{ org: string; day: string; error: string }>
  /** Still missing when the run ended (VSS asked us to slow down). */
  left: number
  skipped?: 'no-tables'
  ms: number
}

/** One run. Exported to run by hand or from a test. */
export async function runVssBackfill(now = Date.now()): Promise<VssBackfillRun> {
  const startedAt = Date.now()
  const window = lastDays(env.VSS_BACKFILL_DAYS, now)
  const run: VssBackfillRun = { window, captured: [], failed: [], left: 0, ms: 0 }
  if (!(await dashcamTablesReady())) {
    run.skipped = 'no-tables'
    logger.warn('VSS back-fill: dashcam tables not there yet (migration not run) — nothing captured')
    return run
  }

  // Every organisation's missed days, oldest first across organisations.
  const todo: Array<{ id: string; code: string; day: string }> = []
  for (const o of await organisationsWithCameras()) {
    for (const day of await missedDays(o.id, window)) todo.push({ ...o, day })
  }
  todo.sort((a, b) => a.day.localeCompare(b.day) || a.code.localeCompare(b.code))
  if (!todo.length) {
    run.ms = Date.now() - startedAt
    logger.info({ window: [window[0], window.at(-1)] }, 'VSS back-fill: nothing missed')
    return run
  }
  logger.info({ missed: todo.length, oldest: todo[0]!.day }, 'VSS back-fill: capturing missed days')

  for (let i = 0; i < todo.length; i++) {
    const t = todo[i]!
    if (i > 0 && BACKFILL_GAP_MS) await new Promise((r) => setTimeout(r, BACKFILL_GAP_MS))
    try {
      const r = await captureDay(t.id, t.day, { now: Date.now() })
      run.captured.push({ org: t.code, day: t.day, alarms: r.alarms, added: r.added, partial: r.partial })
    } catch (err) {
      run.failed.push({ org: t.code, day: t.day, error: err instanceof Error ? err.message : String(err) })
      if (err instanceof VssError && (err.status === VSS_TOO_FREQUENT || err.status === VSS_LOGIN_LIMITED)) {
        run.left = todo.length - i       // VSS wants a rest: the next run carries on
        logger.warn({ err, org: t.code, day: t.day, left: run.left }, 'VSS back-fill: VSS asked us to slow down — rest left to the next run')
        break
      }
      logger.warn({ err, org: t.code, day: t.day }, 'VSS back-fill: day not captured — tried again next run')
    }
  }
  run.ms = Date.now() - startedAt
  logger.info({
    captured: run.captured.length,
    alarms: run.captured.reduce((s, c) => s + c.alarms, 0),
    added: run.captured.reduce((s, c) => s + c.added, 0),
    partial: run.captured.filter((c) => c.partial).length,
    failed: run.failed.length, left: run.left, ms: run.ms,
  }, 'VSS back-fill run complete')
  return run
}

let queue:  Queue  | null = null
let worker: Worker | null = null
let running = false

export interface VssBackfillHandle { stop: () => Promise<void> }

export async function startVssBackfill(): Promise<VssBackfillHandle> {
  const noop: VssBackfillHandle = { stop: async () => {} }
  if (env.VSS_SYNC === 'off') {
    logger.warn('VSS_SYNC=off — VSS back-fill NOT started')
    return noop
  }
  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — VSS back-fill NOT started')
    return noop
  }

  queue = new Queue(VSS_BACKFILL_QUEUE, { connection })
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === BACKFILL_JOB) await queue.removeRepeatableByKey(r.key)
  }
  await queue.add(BACKFILL_JOB, {}, {
    repeat:           { pattern: env.VSS_BACKFILL_CRON },
    removeOnComplete: { count: 20 },
    removeOnFail:     { count: 20 },
    attempts:         1,      // the next run is the retry
  })
  // And once now: a worker that was down has days to catch up before VSS drops them.
  await queue.add(STARTUP_JOB, {}, { removeOnComplete: { count: 5 }, removeOnFail: { count: 5 }, attempts: 1 })

  worker = new Worker(VSS_BACKFILL_QUEUE, async (job: Job) => {
    if (job.name !== BACKFILL_JOB && job.name !== STARTUP_JOB) return
    if (running) {
      logger.warn({ jobId: job.id }, 'VSS back-fill: previous run still going — skipping this one')
      return
    }
    running = true
    try { return await runVssBackfill() } finally { running = false }
  }, { connection, concurrency: 1 })

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'VSS back-fill job failed'))

  logger.info({ queue: VSS_BACKFILL_QUEUE, cron: env.VSS_BACKFILL_CRON, days: env.VSS_BACKFILL_DAYS }, 'VSS back-fill scheduled (and running once now)')

  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue  = null
    },
  }
}

/** For tests: no wait between days. */
export function setBackfillGap(ms: number): void { BACKFILL_GAP_MS = ms }
