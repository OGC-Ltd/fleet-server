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
 * `RETENTION_TARGETS` is the whole policy. The obvious next entries are the
 * telemetry tables — `vehicle_telemetry_raws` is 156 MB against notifications'
 * 464 kB, so that is where a retention policy actually reclaims disk. They are
 * deliberately NOT enabled here: analytics, trip history and the odometer
 * views read those tables, and nothing has confirmed how far back they look.
 */

import { Queue, Worker, type Job } from 'bullmq'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { prisma } from '../prisma.js'
import { trimCachedNotifications } from '../notifications/notification-cache.js'
import { sweepProbeHealth } from '../../modules/fuel/fuel-probe-health.service.js'

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
  /** Deletes one batch, returns how many rows went. */
  prune: (cutoff: Date, limit: number) => Promise<number>
}

const RETENTION_TARGETS: RetentionTarget[] = [
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
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Run every retention target. Exported so it can be invoked by hand. */
export async function runRetentionSweep(): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {}

  for (const target of RETENTION_TARGETS) {
    const cutoff = new Date(Date.now() - target.days * 24 * 60 * 60_000)
    let total = 0
    let batches = 0

    try {
      for (; batches < MAX_BATCHES; batches++) {
        const n = await target.prune(cutoff, BATCH_SIZE)
        total += n
        if (n < BATCH_SIZE) break     // drained
        await sleep(BATCH_PAUSE_MS)
      }
      if (batches >= MAX_BATCHES) {
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
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === PRUNE_JOB || r.name === PROBE_JOB) await queue.removeRepeatableByKey(r.key)
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

  worker = new Worker(RETENTION_QUEUE, async (job: Job) => {
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
    queue: RETENTION_QUEUE, cron: '17 3 * * *', probeCron: '23 4 * * *',
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
