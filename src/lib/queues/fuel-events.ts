/**
 * Fuel events — a BullMQ repeatable job that puts Wialon's fillings and drains
 * on the Live Feed, in-process.
 *
 * ## Why this exists rather than a cron running the CLI
 *
 * `prisma/sync-fuel-events.ts` writes the same rows perfectly well, and on the
 * production box its feed items were still invisible. The read path serves the
 * first page from the Redis cache whenever the cache holds enough items and
 * never falls through to Postgres (notification.reader), and the CLI cannot
 * write that cache — it has no Redis. Measured 2026-08-02 against the live
 * box: the same request returned 21 fuel items with `?before=` and 0 without.
 *
 * Running inside the server means `publishNotification` does all three writes
 * at once — SSE to connected dashboards, the Redis first page, and Postgres —
 * so the feed, the cache and the history cannot disagree.
 *
 * ## Why it is affordable at this cadence
 *
 * One report execution per vehicle takes seconds, and Wialon serialises calls
 * per session, so sweeping every instrumented vehicle takes tens of minutes.
 * That is a nightly batch, not a quarter-hourly one. So the job does not sweep:
 * it asks our own telemetry which tanks actually moved (findFuelCandidates) and
 * executes a report only for those. On a normal cycle that is a handful of
 * vehicles, and when nothing moved it makes no Wialon calls at all.
 *
 * The threshold is a TRIGGER, never a measurement — every volume, time and
 * place on the feed still comes from Wialon's own report.
 *
 * ## Everything here is optional
 *
 * No REDIS_URL means no queue and no job, exactly like the retention sweep.
 * The backfill CLI remains the way to populate history.
 */

import { Queue, Worker, type Job } from 'bullmq'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { WialonClient } from '../../providers/wialon/wialon.client.js'
import {
  resolveOrgFuelSources, findFuelCandidates, syncVehicleFuelEvents,
} from '../../modules/fuel/fuel-sync.service.js'

export const FUEL_QUEUE = 'fuel'
const SYNC_JOB = 'fuel:sync'

/**
 * How far back each cycle looks.
 *
 * Wider than the interval on purpose. Wialon's report only recognises a
 * filling or a drain once enough settled readings follow it, so an event is
 * not visible the instant it happens; a window equal to the interval would
 * miss events that matured a few minutes late, permanently. Overlap is free —
 * the ledger dedupes on vehicle+timestamp and the feed upserts on `feedId`.
 */
const WINDOW_MS = 3 * 60 * 60_000

/**
 * How far back the CANDIDATE check looks — deliberately much shorter than the
 * report window.
 *
 * These answer different questions. "Whose tank moved recently?" wants a short
 * window, or every cycle re-asks Wialon about the same vehicles: measured on
 * the live data, a 3-hour trigger window returns 47 vehicles, and at a
 * quarter-hourly cadence that re-executes each of their reports about twelve
 * times for the same events. "What exactly happened?" wants a long one, so
 * Wialon has the settled readings either side of the event to compute it.
 *
 * Three cycles' worth, so a vehicle is still caught if one cycle is missed.
 */
const CANDIDATE_WINDOW_MS = 45 * 60_000

/**
 * Feed items are published for events inside this age. Slightly tighter than
 * the window: the extra window depth exists to catch late-maturing events, not
 * to re-announce old ones on every cycle.
 */
const NOTIFY_AGE_MS = 2 * 60 * 60_000

/** A tank whose level moved less than this cannot have been filled or drained. */
const CANDIDATE_THRESHOLD_ML = 15_000

/** Stop one cycle running away — a bad window should not hold the session for hours. */
const MAX_CANDIDATES_PER_CYCLE = 60

/**
 * Warn when a cycle takes longer than the interval it is scheduled on.
 *
 * The default cadence is quarter-hourly; a cycle that exceeds it means the next
 * tick is already queued behind this one. Hardcoded against the DEFAULT rather
 * than parsed out of FUEL_SYNC_CRON — a cron expression does not reduce to a
 * single interval, and being approximately right about "this is too slow" is
 * all the threshold needs to be.
 */
const CYCLE_OVERRUN_WARN_MS = 15 * 60_000

export interface FuelSyncResult {
  candidates: number
  fillings:   number
  thefts:     number
  published:  number
  /** Re-offered events suppressed as exact republishes — see SyncOutcome. */
  deduped:    number
  /** Ledger rows rewritten because the provider revised the event. */
  corrected:  number
  failed:     number
  /** Wall clock, so an overrunning cycle is visible rather than inferred. */
  ms:         number
}

/** Run one cycle. Exported so it can be invoked by hand or from a test. */
export async function runFuelSync(): Promise<FuelSyncResult> {
  const startedAt = Date.now()
  const result: FuelSyncResult = { candidates: 0, fillings: 0, thefts: 0, published: 0, deduped: 0, corrected: 0, failed: 0, ms: 0 }

  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  if (!token) {
    logger.warn('Fuel sync: no WIALON_TOKEN — skipping cycle')
    return result
  }

  const to     = new Date()
  const from   = new Date(to.getTime() - WINDOW_MS)
  const cutoff = new Date(to.getTime() - NOTIFY_AGE_MS)

  const client = new WialonClient(token, env.WIALON_API_URL)

  try {
    const sources = await resolveOrgFuelSources(client)

    for (const source of sources) {
      const candidates = await findFuelCandidates(
        source.orgId,
        new Date(to.getTime() - CANDIDATE_WINDOW_MS),
        CANDIDATE_THRESHOLD_ML,
      )
      result.candidates += candidates.length

      if (candidates.length > MAX_CANDIDATES_PER_CYCLE) {
        logger.warn(
          { org: source.code, candidates: candidates.length, cap: MAX_CANDIDATES_PER_CYCLE },
          'Fuel sync: more candidates than one cycle will process — the rest are picked up next cycle',
        )
      }

      for (const vehicle of candidates.slice(0, MAX_CANDIDATES_PER_CYCLE)) {
        try {
          const out = await syncVehicleFuelEvents(client, source, vehicle, {
            from, to, apply: true, notify: true, notifyCutoff: cutoff,
          })
          result.fillings  += out.fillings
          result.thefts    += out.thefts
          result.published += out.published
          result.deduped   += out.deduped
          result.corrected += out.corrected
        } catch (err) {
          // One unit's report failing must not abandon the rest of the cycle.
          result.failed++
          logger.warn({ err, plate: vehicle.registrationPlate }, 'Fuel sync: report failed for vehicle')
        }
      }
    }
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }

  result.ms = Date.now() - startedAt

  const log = result.published > 0 || result.fillings > 0 || result.thefts > 0 || result.corrected > 0
    ? logger.info.bind(logger)
    : logger.debug.bind(logger)
  log(result, 'Fuel sync cycle complete')

  // A cycle that outlasts its own interval means the next tick is already
  // waiting, and BullMQ will run it the moment this one lands — which turns a
  // slow Wialon session into back-to-back cycles rather than a paused one.
  // Nothing here can fix that; it just must not be silent.
  if (result.ms > CYCLE_OVERRUN_WARN_MS) {
    logger.warn({ ms: result.ms, candidates: result.candidates, cron: env.FUEL_SYNC_CRON },
      'Fuel sync cycle overran its interval — the next tick was already due')
  }

  return result
}

// ─── queue wiring ──────────────────────────────────────────────────────────

let queue:  Queue  | null = null
let worker: Worker | null = null
/** One cycle at a time — see the worker handler. */
let running = false

export interface FuelSyncHandle {
  stop: () => Promise<void>
}

export async function startFuelSync(): Promise<FuelSyncHandle> {
  const noop: FuelSyncHandle = { stop: async () => {} }

  if (!env.FUEL_SYNC_ENABLED) {
    logger.warn('FUEL_SYNC_ENABLED=false — fuel event sync NOT started')
    return noop
  }

  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — fuel event sync NOT started; fillings and drains reach the feed only via `npm run sync:fuel`')
    return noop
  }

  queue = new Queue(FUEL_QUEUE, { connection })

  // Repeatable jobs accumulate in Redis when their schedule changes, so old
  // schedulers are cleared first — otherwise changing the cadence leaves the
  // previous one firing forever alongside the new one.
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === SYNC_JOB) await queue.removeRepeatableByKey(r.key)
  }

  await queue.add(SYNC_JOB, {}, {
    repeat:           { pattern: env.FUEL_SYNC_CRON },
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 50 },
    // Deliberately few: a failed cycle is not worth hammering Wialon over,
    // because the next cycle's window overlaps and will pick the events up.
    attempts:         2,
    backoff:          { type: 'exponential', delay: 60_000 },
  })

  worker = new Worker(FUEL_QUEUE, async (job: Job) => {
    if (job.name !== SYNC_JOB) return
    // Concurrency 1 stops two cycles running at once, but it does not stop
    // ticks QUEUEING behind a slow one: a cycle that overran by an hour would
    // land, then immediately run the four ticks that piled up behind it, each
    // re-executing the same reports over an overlapping window. Skip instead —
    // the next scheduled tick's window covers anything this one missed.
    if (running) {
      logger.warn({ jobId: job.id }, 'Fuel sync: previous cycle still running — skipping this tick')
      return
    }
    running = true
    try { return await runFuelSync() } finally { running = false }
  }, {
    connection,
    // Strictly one at a time: two concurrent cycles would open two Wialon
    // sessions and duplicate every report execution for no benefit.
    concurrency: 1,
  })

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Fuel sync job failed'))

  logger.info({ queue: FUEL_QUEUE, cron: env.FUEL_SYNC_CRON, windowMs: WINDOW_MS }, 'Fuel event sync scheduled')

  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue  = null
    },
  }
}
