/**
 * Retention sweep — BullMQ repeatable job that deletes notifications past
 * NOTIFICATION_RETENTION_DAYS.
 *
 * ## Why BullMQ and not another setInterval
 *
 * The poll loops in lib/poll-loop.ts are the right tool for "do this every N
 * seconds while I am running". Retention is different in three ways that the
 * queue actually solves:
 *
 *   • It must run ONCE across the fleet, not once per instance. A repeatable
 *     job is keyed in Redis, so two instances sharing a Redis schedule one
 *     sweep between them rather than two racing DELETEs.
 *   • A missed run must be caught up, not skipped. If the box is down at
 *     03:00 the sweep runs when it comes back; an interval timer just loses
 *     that day.
 *   • Failures need visible state. A sweep that errors is retried with
 *     backoff and its failure is inspectable, rather than being one warn line
 *     in a log nobody greps.
 *
 * ## Everything here is optional
 *
 * No REDIS_URL means no queue, no worker, and no sweep — the same posture as
 * the cache. The box is a t3.micro that is already swapping, so Redis only
 * appears after a resize, and this file must be inert until then.
 *
 * ## Adding targets
 *
 * `RETENTION_TARGETS` is the whole policy.
 *
 * `vehicle_telemetry_raws` is now one of them. That note used to say the
 * telemetry tables were deliberately absent because "nothing has confirmed how
 * far back they look", and sized the raws at 156 MB. Both have moved: the table
 * is 9,968 MB — two thirds of the database, and larger than the parsed rows it
 * backs — and the lookbacks have now been read off every consumer:
 *
 *   dashboard.repository  · telemetry.repository · db-follower
 *   fuel-tank-state       · probe-report                         LATEST row per vehicle
 *   fuel-adjudication     drain window: -30 min to +3 h
 *
 * Nothing scans the raw payload across a long window. That is what makes a
 * short retention safe here and NOT on `vehicle_telemetries`, which trips,
 * analytics and playback do scan across weeks — that table stays unpruned, and
 * confirming its readers is a separate job.
 *
 * Measured 2026-08-31: 1.7 M of 12.9 M telemetry rows are over 30 days old.
 * Note what this does and does not do — it CAPS growth, it does not shrink the
 * database below where it is today.
 */

import { Queue, Worker, type Job } from 'bullmq'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { fleetDayStart } from '../provider-time.js'
import { prisma } from '../prisma.js'
import { trimCachedNotifications } from '../notifications/notification-cache.js'
import { syncSensorInventory } from '../../modules/fuel/sensor-inventory.service.js'
import { sweepProbeHealth } from '../../modules/fuel/fuel-probe-health.service.js'
import { recordFuelTrendsWithCatchUp } from '../../modules/fuel/fuel-trend.service.js'
import { recordVehicleDailyStats } from '../../modules/analytics/vehicle-daily-stats.service.js'
import { deriveFuelRates } from '../../modules/fuel/fuel-rate.service.js'
import { persistMeasuredBurnRates } from '../../modules/fuel/fuel-burn-rate.service.js'

export const RETENTION_QUEUE = 'maintenance'
const PRUNE_JOB = 'notifications:prune'
/**
 * The fuel-probe health sweep rides on this queue rather than on the fuel
 * sync's.
 *
 * The fuel queue cycles every 15 minutes around a Wialon session; this reads
 * a 30-day window of our own telemetry and needs to run once a day. Every
 * reason the header gives for retention living here applies to it unchanged —
 * once across the fleet, caught up rather than skipped, failures inspectable —
 * and it is a maintenance job in the literal sense: its output is a list of
 * machines that need a fitter.
 */
const PROBE_JOB = 'fuel:probe-health'
/**
 * What the provider says is FITTED to each unit — see sensor-inventory.service.
 *
 * Daily and here rather than on the Wialon poll, for the same reason the probe
 * sweep is: it is a maintenance job whose output is a list of records to fix,
 * and it belongs nowhere near the 15-minute session. Sensor configuration
 * changes when an engineer edits the account, so a day's staleness costs
 * nothing — but without this the inventory is only ever as fresh as the last
 * time somebody ran it by hand, and a probe report built on a stale inventory
 * would call a newly-fitted sensor missing.
 */
const SENSOR_JOB = 'fuel:sensor-inventory'
// Filling adjudication used to be a daily job here, at 04:05, and it has moved
// to the fuel cycle in lib/queues/fuel-events — every quarter hour, immediately
// BEFORE the drains.
//
// The reasoning this job's docstring gave was right and its schedule defeated
// it: judging fillings first is what stops a phantom one truncating a drain's
// evidence, but drains were judged 288 times for every once the fillings were.
// A filling recorded at 10:00 sat PENDING until the following morning, and
// `adjudicateDrain` counts a PENDING filling as real. Same order, one clock.
/**
 * The day's fuel trend row per vehicle — opening, closing, and the motion-slosh
 * moving average. See modules/fuel/fuel-trend.
 *
 * Runs LAST of the three and just after midnight EAT, so the day it records is
 * complete: a turbulence average taken at noon is not a trend point, and a
 * closing level taken before the day ends is not a close.
 */
const TREND_JOB = 'fuel:daily-trend'
/**
 * Per-vehicle litres-per-engine-hour, re-derived from the last few days.
 *
 * WEEKLY, alone among these — the others are daily. Two reasons, and both are
 * about the box rather than the fuel: the derivation sorts the full
 * fuel-carrying telemetry window per vehicle against a 1 GB RDS, and a
 * consumption rate does not move between Tuesday and Wednesday. The daily trend
 * rows read whatever this last wrote.
 */
const RATE_JOB = 'fuel:consumption-rates'

/**
 * The per-vehicle daily telemetry rollup, behind both the probe report and
 * fleet-state's idle ratio. Rolls up the day that just ended, so each reads
 * stored rows plus today rather than scanning weeks of raw telemetry — see
 * modules/analytics/vehicle-daily-stats.service for why an index could not have
 * done this instead.
 */
const STATS_JOB = 'vehicle:daily-stats'

/**
 * The last instant of the fleet day that has just finished.
 *
 * Both nightly rollups describe a COMPLETE day, and both take an `asOf` that
 * has to fall inside it. Deriving that from the fleet day boundary rather than
 * from a fixed offset means the answer does not depend on what time the job is
 * scheduled for.
 */
function lastCompleteFleetDay(): Date {
  return new Date(fleetDayStart(new Date()).getTime() - 1)
}

/**
 * Rows deleted per statement. Deliberately small: this runs against the same
 * remote pooler as the 2-second telemetry poll, and one unbounded
 * `DELETE ... WHERE occurred_at < cutoff` would hold locks and a connection
 * for as long as it takes, starving live traffic. Batches let the poll cycle
 * interleave.
 */
const BATCH_SIZE = 500

/** Pause between batches, so a large sweep yields the connection pool. */
const BATCH_PAUSE_MS = 250

/** Hard stop on one sweep, so a huge backlog spreads over several nights. */
const MAX_BATCHES = 200

interface RetentionTarget {
  name:  string
  days:  number
  /**
   * Overrides for a target whose churn the shared defaults cannot absorb.
   *
   * `BATCH_SIZE * MAX_BATCHES` is a per-sweep CEILING — 100,000 rows with the
   * defaults. That is ample for notifications, which accrue a few thousand a
   * day. It is nowhere near telemetry: measured 2026-08-31, after Menengai and
   * West Sugar the fleet writes ~887,000 fixes a day, so a target capped at
   * 100,000 would fall further behind every night and the ceiling warning
   * would be the only sign. A retention target that cannot keep up is worse
   * than none, because it looks like the problem is handled.
   */
  batchSize?:  number
  maxBatches?: number
  /** Deletes one batch, returns how many rows went. */
  prune: (cutoff: Date, limit: number) => Promise<number>
}

/** Exported so the safety properties of each target can be pinned by test. */
export const RETENTION_TARGETS: RetentionTarget[] = [
  {
    name: 'notifications',
    days: env.NOTIFICATION_RETENTION_DAYS,
    // deleteMany has no LIMIT, so the batch is expressed as an id sub-select.
    prune: async (cutoff, limit) => {
      const doomed = await prisma.notification.findMany({
        where:  { occurredAt: { lt: cutoff } },
        select: { id: true },
        take:   limit,
      })
      if (doomed.length === 0) return 0
      const { count } = await prisma.notification.deleteMany({
        where: { id: { in: doomed.map(d => d.id) } },
      })
      return count
    },
  },
  {
    name: 'provider_alerts',
    days: env.NOTIFICATION_RETENTION_DAYS,
    prune: async (cutoff, limit) => {
      const doomed = await prisma.providerAlert.findMany({
        where:  { createdAt: { lt: cutoff } },
        select: { id: true },
        take:   limit,
      })
      if (doomed.length === 0) return 0
      const { count } = await prisma.providerAlert.deleteMany({
        where: { id: { in: doomed.map(d => d.id) } },
      })
      return count
    },
  },
  {
    name: 'vehicle_alerts',
    days: env.NOTIFICATION_RETENTION_DAYS,
    // Only RESOLVED alerts age out. An alert still open after 90 days is a
    // vehicle that has been in trouble for 90 days — deleting that row would
    // erase the only record of an unresolved problem.
    prune: async (cutoff, limit) => {
      const doomed = await prisma.vehicleAlert.findMany({
        where:  { triggeredAt: { lt: cutoff }, resolvedAt: { not: null } },
        select: { id: true },
        take:   limit,
      })
      if (doomed.length === 0) return 0
      const { count } = await prisma.vehicleAlert.deleteMany({
        where: { id: { in: doomed.map(d => d.id) } },
      })
      return count
    },
  },
  {
    name: 'vehicle_telemetry_raws',
    days: env.TELEMETRY_RAW_RETENTION_DAYS,
    // 3 M rows a sweep against ~887 k created a day: enough to hold the line
    // and to clear the whole backlog in one night, with headroom for the fleet
    // to grow again.
    //
    // Measured against the live database 2026-08-31: the backlog is 1,707,874
    // rows — 854 batches — and one batch's selection costs 521 ms while rows
    // are plentiful. With the pause that is ~11 minutes at 03:17, most of it
    // deliberately idle so the live poll keeps its connections. Steady-state
    // sweeps are far cheaper: `vehicle_telemetries_captured_at_idx` already
    // exists, and once the predicate is selective again the planner uses it
    // instead of the parallel seq scan it picks while 13% of the table matches.
    batchSize:  2_000,
    maxBatches: 1_500,
    /**
     * Deletes the raw envelope, never the parsed row.
     *
     * ## The EXISTS clause is the whole safety property
     *
     * `dashboard.repository` and `telemetry.repository` reach a vehicle's
     * current position through an INNER JOIN onto this table. Delete the raw
     * behind a vehicle's newest ping and that vehicle does not go stale on the
     * map — it DISAPPEARS from the snapshot entirely, because an inner join
     * drops the row.
     *
     * Age alone cannot express that. A unit that last reported in January 2025
     * still has a newest ping, and it is that January row the map renders. So
     * the condition is not "old" but "old AND superseded": a raw row goes only
     * when the same vehicle has a later fix, which is exactly the row no
     * consumer is looking at. The subquery rides the
     * (vehicle_id, captured_at) index and stops at the first newer row.
     *
     * Written as one statement rather than the select-then-delete the targets
     * above use, because the id set here is millions of rows wide and the
     * LIMIT has to be applied where the planner can see it.
     *
     * The clause is not theoretical. Measured 2026-08-31, a 30-day cutoff put
     * 1,707,874 raw rows in scope and spared 195 — vehicles whose newest ping
     * is itself older than thirty days, mostly units retired or long silent.
     * Those 195 are precisely the rows the dashboard is joining to.
     */
    prune: async (cutoff, limit) => prisma.$executeRaw`
      DELETE FROM vehicle_telemetry_raws r
       USING (
         SELECT raw.telemetry_id
           FROM vehicle_telemetry_raws raw
           JOIN vehicle_telemetries t ON t.id = raw.telemetry_id
          WHERE t.captured_at < ${cutoff}
            AND EXISTS (
              SELECT 1
                FROM vehicle_telemetries newer
               WHERE newer.vehicle_id  = t.vehicle_id
                 AND newer.captured_at > t.captured_at
            )
          LIMIT ${limit}
       ) doomed
       WHERE r.telemetry_id = doomed.telemetry_id`,
  },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Run every retention target. Exported so it can be invoked by hand. */
export async function runRetentionSweep(): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {}

  for (const target of RETENTION_TARGETS) {
    const cutoff     = new Date(Date.now() - target.days * 24 * 60 * 60_000)
    const batchSize  = target.batchSize  ?? BATCH_SIZE
    const maxBatches = target.maxBatches ?? MAX_BATCHES
    let total = 0
    let batches = 0

    try {
      for (; batches < maxBatches; batches++) {
        const n = await target.prune(cutoff, batchSize)
        total += n
        if (n < batchSize) break      // drained
        await sleep(BATCH_PAUSE_MS)
      }
      if (batches >= maxBatches) {
        logger.warn(
          { target: target.name, deleted: total },
          'Retention sweep hit its batch ceiling — backlog continues next run',
        )
      }
    } catch (err) {
      // One failing target must not abort the others.
      logger.error({ err, target: target.name }, 'Retention sweep failed for target')
    }

    deleted[target.name] = total
  }

  // Keep the cache's horizon aligned with the store's, so it can never serve
  // an item Postgres has just deleted.
  deleted['cache_entries'] = await trimCachedNotifications()

  logger.info({ deleted, retentionDays: env.NOTIFICATION_RETENTION_DAYS }, 'Retention sweep complete')
  return deleted
}

// ─── queue wiring ──────────────────────────────────────────────────────────

let queue:  Queue  | null = null
let worker: Worker | null = null

export interface RetentionHandle {
  stop: () => Promise<void>
}

export async function startRetentionSweep(): Promise<RetentionHandle> {
  const noop: RetentionHandle = { stop: async () => {} }

  if (!env.RETENTION_SWEEP_ENABLED) {
    logger.warn('RETENTION_SWEEP_ENABLED=false — notification retention sweep NOT started')
    return noop
  }

  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — notification retention sweep NOT started; notifications will accumulate indefinitely')
    return noop
  }

  queue = new Queue(RETENTION_QUEUE, { connection })

  // Repeatable jobs accumulate in Redis when their cron changes, so the old
  // schedulers are cleared first — otherwise changing the time leaves the
  // previous one firing forever alongside the new one.
  //
  // Every scheduler on this queue, not a list of names we happen to remember.
  // The list version only removed jobs it already knew about, so RENAMING one
  // orphaned the old scheduler permanently: `fuel:probe-daily-stats` became
  // `vehicle:daily-stats` on 2026-08-20 and the old name kept its 21:40 slot,
  // firing into a dispatcher with no branch for it. Harmless that time, because
  // an unmatched name falls through and completes as a no-op — but it was one
  // rename away from being a job nobody could see running.
  //
  // This queue's schedulers are all declared immediately below, so clearing
  // them wholesale cannot drop one that belongs to somebody else.
  for (const r of await queue.getRepeatableJobs()) {
    await queue.removeRepeatableByKey(r.key)
  }

  await queue.add(PRUNE_JOB, {}, {
    // 03:17 UTC — off the hour, so it doesn't coincide with every other
    // cron on the box, and outside Kenyan working hours (UTC+3).
    repeat:            { pattern: '17 3 * * *' },
    removeOnComplete:  { count: 30 },   // a month of history, then discard
    removeOnFail:      { count: 30 },
    attempts:          3,
    backoff:           { type: 'exponential', delay: 60_000 },
  })

  await queue.add(PROBE_JOB, {}, {
    // 04:23 UTC — 07:23 in Nairobi, so the day's list of machines needing a
    // fitter is on the feed as the workshop opens rather than overnight where
    // it scrolls away before anyone reads it. Clear of the prune above, which
    // holds a connection to the same pooler in batches.
    repeat:            { pattern: '23 4 * * *' },
    removeOnComplete:  { count: 30 },
    removeOnFail:      { count: 30 },
    attempts:          3,
    backoff:           { type: 'exponential', delay: 60_000 },
  })

  await queue.add(SENSOR_JOB, {}, {
    // 04:11 UTC — after the filling pass and BEFORE the probe sweep at 04:23,
    // so the day's fault list is built against configuration read the same
    // morning rather than yesterday's.
    repeat:            { pattern: '11 4 * * *' },
    removeOnComplete:  { count: 30 },
    removeOnFail:      { count: 30 },
    attempts:          3,
    backoff:           { type: 'exponential', delay: 60_000 },
  })

  await queue.add(TREND_JOB, {}, {
    // 21:20 UTC = 00:20 EAT, i.e. twenty minutes into the NEXT fleet day, so
    // the day being recorded has actually finished. `recordFuelTrends` is given
    // a timestamp inside the day it should write, not "now".
    repeat:            { pattern: '20 21 * * *' },
    removeOnComplete:  { count: 30 },
    removeOnFail:      { count: 30 },
    attempts:          3,
    backoff:           { type: 'exponential', delay: 60_000 },
  })

  await queue.add(STATS_JOB, {}, {
    // 21:40 UTC — twenty minutes after the trend job, which reads the same
    // fleet day. Sequential rather than concurrent: the worker runs one job at
    // a time anyway, and spacing them keeps two full-day scans off the same
    // 1 GB instance at once.
    repeat:            { pattern: '40 21 * * *' },
    removeOnComplete:  { count: 30 },
    removeOnFail:      { count: 30 },
    attempts:          3,
    backoff:           { type: 'exponential', delay: 60_000 },
  })

  await queue.add(RATE_JOB, {}, {
    // 02:40 UTC on SUNDAY. Weekly because a consumption rate moves over weeks,
    // and clear of every daily job above — this one sorts the whole
    // fuel-carrying telemetry window against a 1 GB RDS, so it must not land
    // beside the prune holding batched connections to the same pooler.
    repeat:            { pattern: '40 2 * * 0' },
    removeOnComplete:  { count: 10 },
    removeOnFail:      { count: 10 },
    attempts:          3,
    backoff:           { type: 'exponential', delay: 60_000 },
  })

  worker = new Worker(RETENTION_QUEUE, async (job: Job) => {
    // Records the day that just ended, not the one starting.
    // WithCatchUp: three attempts inside five minutes is not enough to survive
    // a busy hour, and a day lost that way stayed lost — see 2026-08-17.
    // The day that just ENDED, computed rather than guessed at with an offset.
    //
    // Both of these used `Date.now() - 30 minutes`, which is not a statement
    // about which day is meant — it is a bet that the job fires less than
    // thirty minutes after the fleet day rolls at 21:00 UTC. The trend job at
    // 21:20 won that bet; the stats job at 21:40 lost it, landed at 21:10, and
    // on 2026-08-20 recorded the day that had just STARTED with forty minutes
    // of data in it, while the completed day went unrecorded.
    //
    // `lastCompleteFleetDay` is the final instant of the previous fleet day, so
    // it is right whatever time the job runs and survives anyone rescheduling
    // it.
    if (job.name === TREND_JOB) return recordFuelTrendsWithCatchUp(lastCompleteFleetDay())
    if (job.name === STATS_JOB) return recordVehicleDailyStats(lastCompleteFleetDay())
    // Both figures refresh together, so a row never carries a fresh derivation
    // beside a stale balance. The measured half only ever updates rows the
    // derivation created, so it must run second.
    if (job.name === RATE_JOB) {
      const derived = await deriveFuelRates({ apply: true })
      await persistMeasuredBurnRates()
      return derived
    }
    if (job.name === SENSOR_JOB) return syncSensorInventory()
    if (job.name === PROBE_JOB) return sweepProbeHealth({ notify: true })
    if (job.name !== PRUNE_JOB) return
    return runRetentionSweep()
  }, {
    connection,
    // In-process, and strictly one at a time. The box has 2 vCPU and under
    // 300 MB free; a separate worker process would cost another ~70 MB of
    // Node for a job that runs once a day for a few seconds.
    concurrency: 1,
  })

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Retention job failed'))

  logger.info({
    queue: RETENTION_QUEUE, cron: '17 3 * * *',
    probeCron: '23 4 * * *', trendCron: '20 21 * * *',
    rateCron: '40 2 * * 0', statsCron: '40 21 * * *',
    retentionDays: env.NOTIFICATION_RETENTION_DAYS,
  }, 'Maintenance jobs scheduled')

  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue  = null
    },
  }
}
