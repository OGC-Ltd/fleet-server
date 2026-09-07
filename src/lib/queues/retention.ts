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
 * Nothing scans the raw payload across a long window, which is what lets that
 * table go to seven days.
 *
 * `vehicle_telemetries` is now a target too, at thirty. Its readers were
 * measured the same way and none exceeds that: probe health 30, fuel
 * adjudication's repeat window 30 and profile 21, tank-state trend 14, fuel
 * rates 7, machine operations and the dozer area one fleet day, fleet-state
 * 24 h, the fleet snapshot a single row. `/track` already refuses a window
 * longer than TRACK_MAX_WINDOW_DAYS outright, so this enforces a limit the API
 * has published all along rather than inventing one. The two long windows in
 * the codebase — maintenance history at 366 days and the driver overview at 90
 * — read `trips` and `vehicle_alerts`, not fixes.
 *
 * ## What the payload actually is
 *
 * Worth knowing before trusting the window. Averaged over 200,000 rows on
 * 2026-08-31 the payload is 716 bytes, of which 21 carry anything not already
 * held as a column: `odometer_km`. `pos` (141 B) duplicates four columns,
 * `flags` (214 B) is ten booleans, `name` duplicates `vehicles.name`, and
 * `ignition_known` and `engine_hours` were promoted to columns long ago by
 * backfill-telemetry-ignition. `doorStatus` has ONE distinct value across the
 * sample and `panicButtonPressed` was never once true.
 *
 * Ten gigabytes to carry one integer per row. Promoting `odometer_km` to a
 * column the same way ignition was would make this table disposable outright —
 * that is the real fix, and this target is the interim.
 *
 * Measured 2026-08-31: 10.4 M of 12.9 M rows are already older than seven days.
 * Note what this does and does not do — it CAPS growth, it does not shrink the
 * database below where it is today, because Postgres reuses freed pages rather
 * than returning them.
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
import { recordIncidentDailyStats } from '../../modules/analytics/incident-daily-stats.service.js'
import { sweepAllOrgs } from '../../modules/telemetry/sensor-fault-sweep.service.js'
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
const INCIDENT_STATS_JOB = 'vehicle:incident-daily-stats'
const SENSOR_FAULT_JOB   = 'sensor:fault-sweep'

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
    name: 'speeding_incidents',
    days: env.INCIDENT_RETENTION_DAYS,
    // Write-once rows, so there is no open/closed distinction to respect here —
    // unlike vehicle_alerts, every incident in this table is already finished.
    prune: async (cutoff, limit) => {
      const doomed = await prisma.speedingIncident.findMany({
        where:  { startedAt: { lt: cutoff } },
        select: { id: true },
        take:   limit,
      })
      if (doomed.length === 0) return 0
      const { count } = await prisma.speedingIncident.deleteMany({
        where: { id: { in: doomed.map(d => d.id) } },
      })
      return count
    },
  },
  {
    name: 'sensor_fault_episodes',
    days: env.INCIDENT_RETENTION_DAYS,
    // Only RECOVERED episodes age out, for the same reason vehicle_alerts keeps
    // its open rows: an episode still open after 90 days is a sensor that has
    // been dead for 90 days, and this row is the only record of it.
    prune: async (cutoff, limit) => {
      const doomed = await prisma.sensorFaultEpisode.findMany({
        where:  { startedAt: { lt: cutoff }, recoveredAt: { not: null } },
        select: { id: true },
        take:   limit,
      })
      if (doomed.length === 0) return 0
      const { count } = await prisma.sensorFaultEpisode.deleteMany({
        where: { id: { in: doomed.map(d => d.id) } },
      })
      return count
    },
  },
  {
    name: 'vehicle_incident_daily_stats',
    days: env.INCIDENT_ROLLUP_RETENTION_DAYS,
    // The whole point of the rollup is to outlive the detail, so this window is
    // deliberately four times the others'.
    prune: async (cutoff, limit) => {
      const doomed = await prisma.vehicleIncidentDailyStat.findMany({
        where:  { day: { lt: cutoff } },
        select: { id: true },
        take:   limit,
      })
      if (doomed.length === 0) return 0
      const { count } = await prisma.vehicleIncidentDailyStat.deleteMany({
        where: { id: { in: doomed.map(d => d.id) } },
      })
      return count
    },
  },
  {
    name: 'vehicle_telemetry_raws',
    days: env.TELEMETRY_RAW_RETENTION_DAYS,
    // 3 M rows a sweep against ~887 k created a day: comfortably enough to hold
    // the line, with headroom for the fleet to grow again.
    //
    // It does NOT clear the opening backlog in one night, and that is the right
    // trade rather than an oversight. Measured 2026-08-31, 10,393,736 rows are
    // already older than seven days, so the first four sweeps each hit this
    // ceiling and log the warning below before the table reaches its window.
    // Deleting 10 M rows in one 70-minute burst would leave a dead-tuple
    // backlog autovacuum could not keep up with on an instance this size;
    // spreading it over four nights costs nothing but patience.
    //
    // One batch's selection costs 521 ms while rows are plentiful, so a full
    // sweep is ~11 minutes, most of it the deliberate pause. Steady-state
    // sweeps are far cheaper: `vehicle_telemetries_captured_at_idx` already
    // exists, and once the predicate is selective again the planner uses it
    // instead of the parallel seq scan it picks while a large share matches.
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
  {
    name: 'vehicle_telemetries',
    days: env.TELEMETRY_RETENTION_DAYS,
    // 1.7 M rows are over 30 days old, so the opening backlog clears in one
    // sweep. Smaller batches than the raws target because this table carries
    // five indexes — a primary key, two composite btrees, a unique on
    // (device_id, captured_at) and a partial on moving fixes — and every
    // deleted row has to be removed from all of them.
    batchSize:  1_000,
    maxBatches: 3_000,
    /**
     * Deletes the fix AND its raw envelope, in one statement.
     *
     * ## Why both, when the raws have their own target
     *
     * Nothing in the database references `vehicle_telemetries` — there is not
     * one foreign key pointing at it, checked against the live schema. That
     * makes this delete unconstrained, and it makes an orphan possible: the
     * raws sweep finds its victims by JOINING through telemetry, so a raw
     * whose parent row has gone is unreachable by it forever. It would leak
     * quietly, at 817 bytes a time.
     *
     * Today the windows make that impossible — raws go at 7 days, fixes at 30,
     * so the envelope is always gone first. But those are two independent env
     * vars, and the day someone raises the raw window above this one is the day
     * the leak starts. Deleting both here costs nothing when the raw is already
     * gone and removes the failure mode entirely.
     *
     * ## The same newest-ping guard as the raws target, for a sharper reason
     *
     * There the concern was an INNER JOIN dropping a vehicle from the map.
     * Here it is worse: age alone would delete a vehicle's ONLY remaining fix,
     * and with it the record of where it last was. Measured 2026-08-31, 195
     * vehicles have a newest ping older than thirty days — units retired, sold,
     * or silent. "Where did it stop reporting" is precisely the question asked
     * about a machine that has gone quiet, and it is the one this would erase.
     */
    prune: async (cutoff, limit) => prisma.$executeRaw`
      WITH doomed AS (
        SELECT t.id
          FROM vehicle_telemetries t
         WHERE t.captured_at < ${cutoff}
           AND EXISTS (
             SELECT 1
               FROM vehicle_telemetries newer
              WHERE newer.vehicle_id  = t.vehicle_id
                AND newer.captured_at > t.captured_at
           )
         LIMIT ${limit}
      ), envelopes AS (
        DELETE FROM vehicle_telemetry_raws r
         USING doomed d
         WHERE r.telemetry_id = d.id
      )
      DELETE FROM vehicle_telemetries t
       USING doomed d
       WHERE t.id = d.id`,
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

  // Two independent decisions, and conflating them was a real outage of the
  // quiet kind.
  //
  // Six schedulers live on this queue. Exactly ONE deletes anything (the prune
  // below); the other five COMPUTE — vehicle_daily_stats, fuel_daily_trends,
  // burn rates, and the probe and sensor reports. They were all gated by
  // RETENTION_SWEEP_ENABLED, so turning the sweep off — which is the right
  // call for an instance you do not want pruning shared data, and exactly what
  // af-south-1 was set to during the migration — silently stopped every
  // rollup with it.
  //
  // Nothing failed. The jobs simply never ran, `vehicle_daily_stats` stopped
  // gaining days, and the three analytics that read it (the daily-activity
  // heatmap, fuel per unit of work, and the distance series) went empty with
  // no error anywhere to explain why. A flag named for deletion now gates only
  // deletion.
  const sweep   = env.RETENTION_SWEEP_ENABLED
  const rollups = env.NIGHTLY_ROLLUPS_ENABLED

  if (!sweep) {
    logger.warn('RETENTION_SWEEP_ENABLED=false — the notification retention sweep is NOT scheduled')
  }
  if (!rollups) {
    logger.warn('NIGHTLY_ROLLUPS_ENABLED=false — daily stats, fuel trends, burn rates and the probe/sensor reports are NOT scheduled; the analytics that read those tables will stop gaining days')
  }
  if (!sweep && !rollups) return noop

  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — maintenance jobs NOT started; notifications will accumulate and the nightly rollups will not run')
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

  if (sweep) await queue.add(PRUNE_JOB, {}, {
    // 03:17 UTC — off the hour, so it doesn't coincide with every other
    // cron on the box, and outside Kenyan working hours (UTC+3).
    repeat:            { pattern: '17 3 * * *' },
    removeOnComplete:  { count: 30 },   // a month of history, then discard
    removeOnFail:      { count: 30 },
    attempts:          3,
    backoff:           { type: 'exponential', delay: 60_000 },
  })

  if (rollups) await queue.add(PROBE_JOB, {}, {
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

  if (rollups) await queue.add(SENSOR_JOB, {}, {
    // 04:11 UTC — after the filling pass and BEFORE the probe sweep at 04:23,
    // so the day's fault list is built against configuration read the same
    // morning rather than yesterday's.
    repeat:            { pattern: '11 4 * * *' },
    removeOnComplete:  { count: 30 },
    removeOnFail:      { count: 30 },
    attempts:          3,
    backoff:           { type: 'exponential', delay: 60_000 },
  })

  if (rollups) await queue.add(TREND_JOB, {}, {
    // 21:20 UTC = 00:20 EAT, i.e. twenty minutes into the NEXT fleet day, so
    // the day being recorded has actually finished. `recordFuelTrends` is given
    // a timestamp inside the day it should write, not "now".
    repeat:            { pattern: '20 21 * * *' },
    removeOnComplete:  { count: 30 },
    removeOnFail:      { count: 30 },
    attempts:          3,
    backoff:           { type: 'exponential', delay: 60_000 },
  })

  if (rollups) await queue.add(STATS_JOB, {}, {
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

  if (rollups) await queue.add(INCIDENT_STATS_JOB, {}, {
    // 21:50 UTC — ten minutes after the daily stats job, same fleet day, same
    // one-at-a-time worker. This one is a GROUP BY over two small tables rather
    // than a telemetry scan, so it is cheap; the spacing is about keeping the
    // ordering obvious, not about load.
    repeat:            { pattern: '50 21 * * *' },
    removeOnComplete:  { count: 30 },
    removeOnFail:      { count: 30 },
    attempts:          3,
    backoff:           { type: 'exponential', delay: 60_000 },
  })

  if (rollups) await queue.add(SENSOR_FAULT_JOB, {}, {
    // Every fifteen minutes, not nightly: this is the ONLY detector that can
    // see a silent tracker or a dead channel, and an operator asking "what is
    // broken right now" should not be reading an answer from last night. It
    // reads a warm 10-minute cache and a small index, so the cost is trivial.
    repeat:            { pattern: '*/15 * * * *' },
    removeOnComplete:  { count: 20 },
    removeOnFail:      { count: 20 },
    attempts:          2,
    backoff:           { type: 'exponential', delay: 30_000 },
  })

  if (rollups) await queue.add(RATE_JOB, {}, {
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
    if (job.name === INCIDENT_STATS_JOB) return recordIncidentDailyStats(lastCompleteFleetDay())
    if (job.name === SENSOR_FAULT_JOB) return sweepAllOrgs()
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
    queue: RETENTION_QUEUE,
    sweep, rollups,
    cron:      sweep   ? '17 3 * * *'  : null,
    probeCron: rollups ? '23 4 * * *'  : null,
    sensorCron: rollups ? '11 4 * * *' : null,
    trendCron: rollups ? '20 21 * * *' : null,
    statsCron: rollups ? '40 21 * * *' : null,
    rateCron:  rollups ? '40 2 * * 0'  : null,
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
