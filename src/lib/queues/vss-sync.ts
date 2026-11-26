/**
 * Every organisation's dashcam alarms for today, from VSS into dashcam_alarms
 * and the Redis day cache, every 5 minutes (VSS_SYNC_CRON). Runs only in the
 * vss-worker process (src/vss-worker.ts), a BullMQ repeatable like the nightly
 * capture beside it.
 *
 * Each organisation in its own lane, VSS_ORG_CONCURRENCY at once
 * (modules/dashcam/org-lanes): the type lookups and writes overlap, while the
 * searches still take turns, one every 10 s for the whole VSS account. In the first hour of a fleet day the day before is
 * captured too, so its last minutes are not left to the nightly re-capture.
 * A cycle still running when the next tick comes skips that tick.
 *
 * VSS_SYNC: 'apply' (default) or 'off'.
 */

import { Queue, type Job } from 'bullmq'
import { TracedWorker as Worker } from '../tracing.js'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { captureDay, dashcamTablesReady, organisationsWithCameras, type DayCapture } from '../../modules/dashcam/dashcam-capture.js'
import { dayWindow, fleetDayOf } from '../../modules/dashcam/fleet-day.js'
import { inLanes } from '../../modules/dashcam/org-lanes.js'
import { orgDevices } from '../../modules/dashcam/dashcam.service.js'
import { storeCameras } from '../../modules/dashcam/dashcam-store.js'

export const VSS_SYNC_QUEUE = 'vss-sync'
const SYNC_JOB = 'vss-sync:today'
/** How long into a fleet day the day before is still captured on each cycle. */
const YESTERDAY_FOR_MS = 60 * 60_000

export interface VssSyncCycle {
  days: string[]
  orgs: Array<{ org: string; days: Array<Omit<DayCapture, 'orgId'>>; error?: string }>
  skipped?: 'no-tables'
  ms: number
}

/** The fleet days one cycle captures: today, and yesterday in today's first hour. */
export function syncDays(now = Date.now()): string[] {
  const today = fleetDayOf(now)
  const start = dayWindow(today).from
  return now - start < YESTERDAY_FOR_MS ? [fleetDayOf(start - 1), today] : [today]
}

/** One cycle over every organisation with dashcams. Exported to run by hand or from a test. */
export async function runVssSync(now = Date.now()): Promise<VssSyncCycle> {
  const startedAt = Date.now()
  const days = syncDays(now)
  const cycle: VssSyncCycle = { days, orgs: [], ms: 0 }
  if (!(await dashcamTablesReady())) {
    cycle.skipped = 'no-tables'
    logger.warn('VSS sync: dashcam tables not there yet (migration not run) — nothing captured')
    return cycle
  }
  const orgs = await organisationsWithCameras()
  const entries = orgs.map((o) => ({ o, entry: { org: o.code, days: [] } as VssSyncCycle['orgs'][number] }))
  await inLanes(entries, env.VSS_ORG_CONCURRENCY, async ({ o, entry }) => {
    // Which vehicles have a camera, for readers that must not ask VSS (getAlarms)
    try {
      await storeCameras(o.id, [...(await orgDevices(o.id, null)).values()].map((d) => d.vehicleId))
    } catch (err) {
      logger.warn({ err, org: o.code }, 'VSS sync: camera list not refreshed')
    }
    for (const day of days) {
      try {
        const { orgId: _o, ...r } = await captureDay(o.id, day, { now: Date.now() })
        entry.days.push(r)
      } catch (err) {
        // VSS busy for one organisation: the others still go, and the next tick tries it again.
        entry.error = err instanceof Error ? err.message : String(err)
        logger.warn({ err, org: o.code, day }, 'VSS sync: day not captured — tried again next tick')
      }
    }
  })
  cycle.orgs = entries.map((e) => e.entry)
  cycle.ms = Date.now() - startedAt
  logger.info({
    days,
    orgs: cycle.orgs.map((o) => ({ org: o.org, alarms: o.days.reduce((s, d) => s + d.alarms, 0), added: o.days.reduce((s, d) => s + d.added, 0), partial: o.days.filter((d) => d.partial).length, error: o.error })),
    ms: cycle.ms,
  }, 'VSS sync cycle complete')
  return cycle
}

let queue:  Queue  | null = null
let worker: Worker | null = null
let running = false

export interface VssSyncHandle { stop: () => Promise<void> }

export async function startVssSync(): Promise<VssSyncHandle> {
  const noop: VssSyncHandle = { stop: async () => {} }
  if (env.VSS_SYNC === 'off') {
    logger.warn('VSS_SYNC=off — VSS sync NOT started')
    return noop
  }
  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — VSS sync NOT started (it caches into Redis)')
    return noop
  }

  queue = new Queue(VSS_SYNC_QUEUE, { connection })
  // Repeatable jobs accumulate in Redis when their schedule changes.
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === SYNC_JOB) await queue.removeRepeatableByKey(r.key)
  }
  await queue.add(SYNC_JOB, {}, {
    repeat:           { pattern: env.VSS_SYNC_CRON },
    removeOnComplete: { count: 20 },
    removeOnFail:     { count: 20 },
    attempts:         1,      // the next tick is the retry
  })

  worker = new Worker(VSS_SYNC_QUEUE, async (job: Job) => {
    if (job.name !== SYNC_JOB) return
    if (running) {
      logger.warn({ jobId: job.id }, 'VSS sync: previous cycle still running — skipping this tick')
      return
    }
    running = true
    try { return await runVssSync() } finally { running = false }
  }, { connection, concurrency: 1 })

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'VSS sync job failed'))

  logger.info({ queue: VSS_SYNC_QUEUE, cron: env.VSS_SYNC_CRON, cacheDays: env.VSS_CACHE_DAYS }, 'VSS sync scheduled')

  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue  = null
    },
  }
}
