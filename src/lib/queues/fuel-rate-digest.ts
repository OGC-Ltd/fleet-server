/**
 * FUEL RATE and FUEL DOWN, once a day — see `modules/fuel/fuel-rate-digest`.
 *
 * The adjudicator still judges every drain and writes its cause to the ledger
 * as it always did; with `FUEL_RATE_ALERTS=digest` it just no longer posts
 * these two one by one. This job reads the fleet day that has just closed
 * back off the ledger and posts one warning per organisation that had any.
 *
 * ## What counts
 *
 * Exactly what used to be announced under those headlines: a drain whose
 * cause reason is one of the classifier's announced slugs and whose cause is
 * not a SIPHON (that one is POSSIBLE THEFT, still posted as it happens).
 * Dismissed rows are left out — someone has already dealt with them — and so
 * are rows deleted outright, which are simply gone. The day is the EAT fleet
 * day in which the drop BEGAN.
 *
 * ## Its own queue
 *
 * A BullMQ repeatable, like the parked-fall verdicts, so exactly one instance
 * posts it. The feed id is per organisation and per day, so a rerun of the
 * same day updates its summary rather than posting a second.
 */

import { Queue, Worker, type Job } from 'bullmq'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { prisma } from '../prisma.js'
import { publishNotificationDurable } from '../notifications/notification.store.js'
import { fleetDayStart, fleetDayKey } from '../provider-time.js'
import { ANNOUNCED_REASON_SLUGS } from '../../modules/fuel/fuel-theft-classifier.js'
import { digestKind, fleetDayLabel, fuelRateDigestText, type DigestRow } from '../../modules/fuel/fuel-rate-digest.js'

export const FUEL_RATE_DIGEST_QUEUE = 'fuel-rate-digest'
const DIGEST_JOB = 'fuel-rate-digest'
const DAY_MS = 24 * 3_600_000

let queue: Queue | null = null
let worker: Worker | null = null

export interface FuelRateDigestOutcome {
  day: string
  drops: number
  organisations: number
  published: number
}

/**
 * Post the summary of the fleet day before the one `now` falls in. EAT has no
 * daylight saving, so that day is exactly the 24 hours before today's start.
 */
export async function runFuelRateDigest(now: Date = new Date()): Promise<FuelRateDigestOutcome> {
  const end = fleetDayStart(now)
  const start = new Date(end.getTime() - DAY_MS)
  const day = fleetDayKey(start).toISOString().slice(0, 10)

  const found = await prisma.fuelTheft.findMany({
    where: {
      beganAt:     { gte: start, lt: end },
      dismissedAt: null,
      causeReason: { in: [...ANNOUNCED_REASON_SLUGS] },
      drainCause:  { not: 'SIPHON' },
    },
    select: {
      stolenMl: true, causeReason: true,
      vehicle: { select: { organisationId: true, registrationPlate: true } },
    },
  })

  const byOrg = new Map<string, DigestRow[]>()
  for (const f of found) {
    const kind = digestKind(f.causeReason)
    if (!kind) continue
    const rows = byOrg.get(f.vehicle.organisationId) ?? []
    rows.push({ plate: f.vehicle.registrationPlate, kind, stolenMl: f.stolenMl })
    byOrg.set(f.vehicle.organisationId, rows)
  }

  const label = fleetDayLabel(start)
  let drops = 0, published = 0
  for (const [orgId, rows] of byOrg) {
    const text = fuelRateDigestText(rows, label)
    if (!text) continue
    drops += rows.length
    try {
      const out = await publishNotificationDurable({
        orgId,
        id:        `fuel-rate-digest-${orgId}-${day}`,
        source:    'wialon',
        alertType: 'fuelInconsistency',
        // Never critical, whatever it contains: that is the point of the digest.
        severity:  'warning',
        text,
        at:        now,
      })
      if (out.published) published++
    } catch (err) {
      logger.warn({ err, orgId, day }, 'Fuel rate digest: publish failed')
    }
  }

  const outcome = { day, drops, organisations: byOrg.size, published }
  logger.info(outcome, 'Fuel rate digest')
  return outcome
}

export interface FuelRateDigestHandle {
  stop(): Promise<void>
}

/** Schedule the daily summary; a no-op unless FUEL_RATE_ALERTS is 'digest'. */
export async function startFuelRateDigest(): Promise<FuelRateDigestHandle> {
  const noop: FuelRateDigestHandle = { stop: async () => {} }
  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — the fuel rate digest is NOT scheduled')
    return noop
  }

  queue = new Queue(FUEL_RATE_DIGEST_QUEUE, { connection })
  // A changed schedule, or a switch away from 'digest', must not leave the old
  // scheduler firing.
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === DIGEST_JOB) await queue.removeRepeatableByKey(r.key)
  }
  if (env.FUEL_RATE_ALERTS !== 'digest') {
    logger.info({ mode: env.FUEL_RATE_ALERTS }, 'FUEL RATE / FUEL DOWN are not summarised daily')
    await queue.close()
    queue = null
    return noop
  }
  await queue.add(DIGEST_JOB, {}, {
    repeat:           { pattern: env.FUEL_RATE_DIGEST_CRON },
    removeOnComplete: { count: 30 },
    removeOnFail:     { count: 30 },
    attempts:         3,
    backoff:          { type: 'exponential', delay: 60_000 },
  })

  worker = new Worker(FUEL_RATE_DIGEST_QUEUE, async (job: Job) => {
    if (job.name !== DIGEST_JOB) return
    return runFuelRateDigest()
  }, { connection, concurrency: 1 })
  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Fuel rate digest job failed'))

  logger.info({ queue: FUEL_RATE_DIGEST_QUEUE, cron: env.FUEL_RATE_DIGEST_CRON }, 'Fuel rate digest scheduled')
  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue = null
    },
  }
}
