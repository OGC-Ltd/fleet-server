/**
 * Keep the trips table filled — a BullMQ repeatable that turns newly-completed
 * dispatches into measured Trip rows.
 *
 * The backfill lives in `prisma/build-trips.ts`; this is the steady state. It
 * exists for the same reason the fuel sync moved in-process: the analytics that
 * read `trips` are served from warm caches inside the server, and a cron
 * running a CLI would fill the database while the dashboard kept serving the
 * cached zeroes until the next sweep.
 *
 * Cheap by construction. It looks only at dispatches CLOSED inside a short
 * trailing window, and `Trip.dispatchId` is unique, so a cycle that finds
 * nothing new does one indexed query per org and stops.
 *
 * Optional in exactly the way the retention sweep and the fuel sync are: no
 * REDIS_URL means no queue and no job.
 */

import { Queue, Worker, type Job } from 'bullmq'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { prisma } from '../prisma.js'
import { buildTripsForOrg } from '../trip-builder.js'

export const TRIP_QUEUE = 'trips'
const BUILD_JOB = 'trips:build'

/**
 * How far back each cycle looks for newly-closed dispatches.
 *
 * Wider than the interval on purpose, exactly like the fuel sync's window: a
 * dispatch closed while a cycle was mid-flight would otherwise be missed
 * permanently. Overlap is free — the unique dispatchId makes a re-read a no-op.
 */
const WINDOW_MS = 6 * 60 * 60_000

export interface TripBuildCycle {
  built:   number
  skipped: number
  failed:  number
  ms:      number
}

/** Run one cycle. Exported so it can be invoked by hand or from a test. */
export async function runTripBuild(): Promise<TripBuildCycle> {
  const startedAt = Date.now()
  const result: TripBuildCycle = { built: 0, skipped: 0, failed: 0, ms: 0 }

  const to   = new Date()
  const from = new Date(to.getTime() - WINDOW_MS)

  const orgs = await prisma.organisation.findMany({ select: { id: true, code: true } })
  for (const org of orgs) {
    try {
      const out = await buildTripsForOrg(org.id, { from, to, apply: true })
      result.built   += out.built
      result.skipped += out.skipped
    } catch (err) {
      // One org failing must not abandon the others.
      result.failed++
      logger.warn({ err, org: org.code }, 'Trip build failed for organisation')
    }
  }

  result.ms = Date.now() - startedAt
  const log = result.built > 0 || result.failed > 0 ? logger.info.bind(logger) : logger.debug.bind(logger)
  log(result, 'Trip build cycle complete')
  return result
}

let queue:  Queue  | null = null
let worker: Worker | null = null
let running = false

export interface TripBuildHandle { stop: () => Promise<void> }

export async function startTripBuild(): Promise<TripBuildHandle> {
  const noop: TripBuildHandle = { stop: async () => {} }

  if (!env.TRIP_BUILD_ENABLED) {
    logger.warn('TRIP_BUILD_ENABLED=false — trip build NOT started')
    return noop
  }

  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — trip build NOT started; trips reach the database only via `npm run build:trips`')
    return noop
  }

  queue = new Queue(TRIP_QUEUE, { connection })

  // Repeatable jobs accumulate in Redis when their schedule changes, so old
  // schedulers are cleared first — see lib/queues/fuel-events.
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === BUILD_JOB) await queue.removeRepeatableByKey(r.key)
  }

  await queue.add(BUILD_JOB, {}, {
    repeat:           { pattern: env.TRIP_BUILD_CRON },
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 50 },
    attempts:         2,
    backoff:          { type: 'exponential', delay: 60_000 },
  })

  worker = new Worker(TRIP_QUEUE, async (job: Job) => {
    if (job.name !== BUILD_JOB) return
    if (running) {
      logger.warn({ jobId: job.id }, 'Trip build: previous cycle still running — skipping this tick')
      return
    }
    running = true
    try { return await runTripBuild() } finally { running = false }
  }, { connection, concurrency: 1 })

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Trip build job failed'))

  logger.info({ queue: TRIP_QUEUE, cron: env.TRIP_BUILD_CRON, windowMs: WINDOW_MS }, 'Trip build scheduled')

  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue  = null
    },
  }
}
