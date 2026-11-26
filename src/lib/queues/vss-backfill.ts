/**
 * Back-fill the dashcam days the vss-worker missed (worker down, a deploy
 * gap, VSS busy): every past fleet day in the last VSS_BACKFILL_DAYS (13,
 * inside VSS's two weeks) that has no dashcam_capture_days row, or one marked
 * partial, is captured again into dashcam_alarms and the Redis day cache.
 *
 * Runs once when the worker starts, then on VSS_BACKFILL_CRON (hourly). Each
 * organisation has its own lane, VSS_ORG_CONCURRENCY lanes at once
 * (modules/dashcam/org-lanes), each taking its days oldest first: VSS drops
 * them soonest. The searches still take turns, 10 s apart for the whole VSS
 * account (VSS refuses anything faster), and the 5-minute sync of today takes
 * its turn among them. A "too frequent" answer rests every lane until VSS
 * listens again (its 90 s backoff), then the same day is tried again, up to
 * MAX_RESTS rests a run; past that the next run carries on where it stopped.
 * Replaces running `npm run dashcam:backfill` by hand.
 */

import { Queue, type Job } from 'bullmq'
import { TracedWorker as Worker } from '../tracing.js'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { VssError, VSS_TOO_FREQUENT, VSS_LOGIN_LIMITED, vssRestMs } from '../../providers/vss/index.js'
import { captureDay, dashcamTablesReady, missedDays, organisationsWithCameras } from '../../modules/dashcam/dashcam-capture.js'
import { lastDays } from '../../modules/dashcam/fleet-day.js'
import { inLanes } from '../../modules/dashcam/org-lanes.js'

export const VSS_BACKFILL_QUEUE = 'vss-backfill'
const BACKFILL_JOB = 'vss-backfill:missed'
const STARTUP_JOB = 'vss-backfill:startup'
let BACKFILL_GAP_MS = 0
/** Waited beyond VSS's own backoff before asking again. */
let REST_PAD_MS = 5_000
/** Rests a run may take before leaving the rest to the next run. */
const MAX_RESTS = 8

export interface VssBackfillRun {
  window: string[]
  captured: Array<{ org: string; day: string; alarms: number; added: number; partial: boolean }>
  failed: Array<{ org: string; day: string; error: string }>
  /** Still missing when the run ended (VSS kept asking us to slow down). */
  left: number
  /** Times the run waited for VSS to listen again. */
  rests: number
  skipped?: 'no-tables'
  ms: number
}

/** One run. Exported to run by hand or from a test. */
export async function runVssBackfill(now = Date.now()): Promise<VssBackfillRun> {
  const startedAt = Date.now()
  const window = lastDays(env.VSS_BACKFILL_DAYS, now)
  const run: VssBackfillRun = { window, captured: [], failed: [], left: 0, rests: 0, ms: 0 }
  if (!(await dashcamTablesReady())) {
    run.skipped = 'no-tables'
    logger.warn('VSS back-fill: dashcam tables not there yet (migration not run) — nothing captured')
    return run
  }

  // Each organisation's missed days (lastDays is oldest first).
  const lanes: Array<{ id: string; code: string; days: string[] }> = []
  for (const o of await organisationsWithCameras()) {
    const days = await missedDays(o.id, window)
    if (days.length) lanes.push({ ...o, days })
  }
  const total = lanes.reduce((s, l) => s + l.days.length, 0)
  if (!total) {
    run.ms = Date.now() - startedAt
    logger.info({ window: [window[0], window.at(-1)] }, 'VSS back-fill: nothing missed')
    return run
  }
  logger.info({
    missed: total, orgs: lanes.length, lanes: Math.min(lanes.length, env.VSS_ORG_CONCURRENCY),
    oldest: lanes.map((l) => l.days[0]!).sort()[0],
  }, 'VSS back-fill: capturing missed days')

  // VSS asked us to slow down: every lane waits for the same rest, then carries on.
  let resting: Promise<void> | null = null
  let givenUp = false
  const rest = (): Promise<void> => {
    resting ??= (async () => {
      run.rests++
      const ms = vssRestMs() + REST_PAD_MS
      logger.warn({ rest: run.rests, ms }, 'VSS back-fill: VSS asked us to slow down — resting, then carrying on')
      await new Promise((r) => setTimeout(r, ms))
    })().finally(() => { resting = null })
    return resting
  }

  await inLanes(lanes, env.VSS_ORG_CONCURRENCY, async (lane) => {
    for (let i = 0; i < lane.days.length; i++) {
      const day = lane.days[i]!
      if (givenUp) { run.left += lane.days.length - i; return }
      if (resting) await resting
      if (i > 0 && BACKFILL_GAP_MS) await new Promise((r) => setTimeout(r, BACKFILL_GAP_MS))
      try {
        const r = await captureDay(lane.id, day, { now: Date.now() })
        run.captured.push({ org: lane.code, day, alarms: r.alarms, added: r.added, partial: r.partial })
      } catch (err) {
        if (err instanceof VssError && (err.status === VSS_TOO_FREQUENT || err.status === VSS_LOGIN_LIMITED)) {
          if (!givenUp && run.rests < MAX_RESTS) {
            await rest()
            i--                      // the same day again
            continue
          }
          if (!givenUp) logger.warn({ org: lane.code, day, rests: run.rests }, 'VSS back-fill: VSS still refusing — rest left to the next run')
          givenUp = true
          run.failed.push({ org: lane.code, day, error: err.message })
          run.left += lane.days.length - i
          return
        }
        run.failed.push({ org: lane.code, day, error: err instanceof Error ? err.message : String(err) })
        logger.warn({ err, org: lane.code, day }, 'VSS back-fill: day not captured — tried again next run')
      }
    }
  })
  run.ms = Date.now() - startedAt
  logger.info({
    captured: run.captured.length,
    alarms: run.captured.reduce((s, c) => s + c.alarms, 0),
    added: run.captured.reduce((s, c) => s + c.added, 0),
    partial: run.captured.filter((c) => c.partial).length,
    failed: run.failed.length, left: run.left, rests: run.rests, ms: run.ms,
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

/** For tests, or to space one lane's days out. */
export function setBackfillGap(ms: number, restPadMs = REST_PAD_MS): void { BACKFILL_GAP_MS = ms; REST_PAD_MS = restPadMs }
