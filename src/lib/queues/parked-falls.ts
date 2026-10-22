/**
 * The follow-up of the parked-fall rule: every few minutes, ask each open fall
 * what has become of it — see `modules/fuel/parked-fall`.
 *
 * The call itself (`lib/fuel-drop-watch` → `fuel-watch.worker`) is already out
 * as a critical possible theft, and wrote a PENDING row in `parked_fuel_falls`.
 * This pass reads the machine's readings since, and the fillings ledger, through
 * `judgeNextStart`; the moment that answers anything but PENDING, the row is
 * decided and what became of the call replaces the call's own feed line.
 *
 * TOPPED_UP escalates (fuel went back in while it stood — check for water) and
 * CONFIRMED stands the call up, both critical; CLEARED retracts it, only where
 * the level came back when no fuel could have gone in; REFUELLED says a refuel
 * hides the size of the loss; UNRESOLVED keeps the call open and says why.
 *
 * ## Its own queue
 *
 * The same shape as the adjudication pass, for the same reasons: a BullMQ
 * repeatable so exactly one instance runs it, a skip rather than a pile-up when
 * a pass overruns, and a decision that is an UPDATE guarded on PENDING, so two
 * passes can never announce the same fall twice.
 */

import { Queue, Worker, type Job } from 'bullmq'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { prisma } from '../prisma.js'
import { publishNotification } from '../notifications/notification.store.js'
import { parkedFallFeedId } from '../workers/fuel-watch.worker.js'
import {
  judgeNextStart, NEXT_START_HORIZON_MS, WORK_WINDOW_MS, GIVE_UP_MS,
  type EngineEvidence, type NextStartJudgement,
} from '../../modules/fuel/parked-fall.js'

export const PARKED_FALLS_QUEUE = 'parked-falls'
const VERDICT_JOB = 'parked-fall-verdicts'
/** A pass decides at most this many; the rest wait one tick. */
const BATCH = 200

let queue: Queue | null = null
let worker: Worker | null = null
let running = false

const L = (ml: number): string => `${(Math.abs(ml) / 1000).toFixed(1)} L`
const hours = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m} min` : `${(m / 60).toFixed(m < 600 ? 1 : 0)} h`
}

/**
 * The verdict as the operations feed shows it. Every reason `judgeNextStart`
 * gives is a clause about the level ("came back to the old level while the
 * machine stood with the engine off"), so each message says what the tank did
 * and where the machine was when it did it.
 */
export function verdictNotice(
  plate: string,
  fall: { settledAt: Date; droppedMl: number },
  j: NextStartJudgement,
): { severity: 'info' | 'warning' | 'critical'; text: string } | null {
  const lost = L(fall.droppedMl)
  const then = (t: number | null) => (t == null ? 'then' : `then ${hours(t - fall.settledAt.getTime())} later`)
  const reason = j.reason ?? ''
  switch (j.verdict) {
    case 'CONFIRMED':
      return {
        severity: 'critical',
        text: `POSSIBLE THEFT — FUEL STILL MISSING: ${plate} lost ${lost} while parked with the engine off, and the ` +
          `level ${reason}${j.nextStartAt == null ? '' : ` (it next ${j.nextStartBy === 'moved' ? 'moved' : 'started'} ` +
          `${hours(j.nextStartAt - fall.settledAt.getTime())} after the fall)`}.`,
      }
    case 'TOPPED_UP':
      return {
        severity: 'critical',
        text: `POSSIBLE THEFT — DRAINED AND TOPPED UP: ${plate} lost ${lost} while parked, ${then(j.backAt)} the ` +
          `level ${reason}. Fuel taken and replaced; check the tank for water.`,
      }
    case 'REFUELLED':
      return {
        severity: 'warning',
        text: `${plate} lost ${lost} while parked, ${then(j.backAt)} the level ${reason}.`,
      }
    case 'CLEARED':
      return { severity: 'info', text: `Retracted: ${plate}'s ${lost} fall while parked was not fuel leaving the tank — the level ${reason}.` }
    case 'UNRESOLVED':
      return {
        severity: 'warning',
        text: `${plate}: the ${lost} fall while parked stays open — the level ${reason}. The call stands; worth a look at the machine.`,
      }
    default:
      return null
  }
}

export interface ParkedFallPassResult {
  checked: number
  decided: Record<string, number>
}

/** One pass over the open falls. */
export async function runParkedFallVerdicts(now = new Date()): Promise<ParkedFallPassResult> {
  const open = await prisma.parkedFuelFall.findMany({
    where:   { verdict: 'PENDING' },
    orderBy: { settledAt: 'asc' },
    take:    BATCH,
    include: { vehicle: { select: { registrationPlate: true } } },
  })
  const decided: Record<string, number> = {}

  for (const f of open) {
    const S = f.settledAt.getTime()
    const until = Math.min(now.getTime(), S + NEXT_START_HORIZON_MS + WORK_WINDOW_MS + 30 * 60_000)
    const [rows, fills] = await Promise.all([
      prisma.vehicleTelemetry.findMany({
        where:   { vehicleId: f.vehicleId, capturedAt: { gte: new Date(S - 15 * 60_000), lte: new Date(until) } },
        orderBy: { capturedAt: 'asc' },
        // Position tells one stop from the next; the accelerometer, where the
        // unit has one, tells its angle and whether it was working.
        select:  { capturedAt: true, speedKmh: true, engineOn: true, ignitionKnown: true, fuelLevelMl: true, engineHoursMeter: true,
                   lat: true, lng: true, accelXG: true, accelYG: true, accelZG: true },
      }),
      prisma.fuelFilling.findMany({
        where:  { vehicleId: f.vehicleId, filledAt: { gte: new Date(S - 10 * 60_000), lte: new Date(S + GIVE_UP_MS) } },
        select: { filledAt: true },
      }),
    ])
    const j = judgeNextStart(
      { settledAtMs: S, troughMl: f.troughMl, droppedMl: f.droppedMl, engineEvidence: f.engineEvidence as EngineEvidence },
      rows.map(r => ({
        t: r.capturedAt.getTime(), fuelMl: r.fuelLevelMl, speedKmh: r.speedKmh, engineOn: r.engineOn,
        ignitionKnown: r.ignitionKnown === true, meterH: r.engineHoursMeter,
        lat: r.lat, lng: r.lng,
        accel: r.accelXG == null && r.accelYG == null && r.accelZG == null ? null : { x: r.accelXG, y: r.accelYG, z: r.accelZG },
      })),
      fills.map(x => x.filledAt.getTime()),
      now.getTime(),
    )
    if (j.verdict === 'PENDING') continue

    // Guarded on PENDING: whichever pass gets here first decides, and only it announces.
    const won = await prisma.parkedFuelFall.updateMany({
      where: { id: f.id, verdict: 'PENDING' },
      data: {
        verdict:       j.verdict,
        verdictAt:     now,
        verdictReason: j.reason,
        nextStartAt:   j.nextStartAt == null ? null : new Date(j.nextStartAt),
        nextStartBy:   j.nextStartBy,
        jumpMl:        j.jumpMl == null ? null : Math.round(j.jumpMl),
        backAt:        j.backAt == null ? null : new Date(j.backAt),
      },
    })
    if (won.count === 0) continue
    decided[j.verdict] = (decided[j.verdict] ?? 0) + 1

    const notice = verdictNotice(f.vehicle.registrationPlate ?? 'a vehicle', f, j)
    if (!notice) continue
    try {
      // Written ONTO stage one's line, not beside it. As a line of its own
      // (`fuel-parked-<id>`, stamped at the next start) a CONFIRMED came out
      // as a second critical for a fall already called, and since it waits
      // WORK_WINDOW_MS past the start it read as two hours late: measured on
      // prod over 8–22 Oct, p50 122 min between its timestamp and its arrival.
      // Same id and the fall's own time, so the feed, the cache and the row
      // all replace the call in place.
      publishNotification({
        orgId:     f.organisationId,
        id:        parkedFallFeedId(f.vehicleId, f.settledAt),
        source:    'live',
        alertType: 'fuelInconsistency',
        severity:  notice.severity,
        text:      notice.text,
        at:        f.settledAt,
        plate:     f.vehicle.registrationPlate,
        vehicleId: f.vehicleId,
      })
    } catch (err) {
      logger.warn({ err, fallId: f.id }, 'Parked fall verdict: publish failed')
    }
  }

  if (Object.keys(decided).length > 0) logger.info({ checked: open.length, decided }, 'Parked fall verdicts')
  return { checked: open.length, decided }
}

export interface ParkedFallsHandle {
  stop(): Promise<void>
}

/** Schedule stage two on its own clock; see the note at the top. */
export async function startParkedFallVerdicts(): Promise<ParkedFallsHandle> {
  const noop: ParkedFallsHandle = { stop: async () => {} }
  if (!env.PARKED_FALL_VERDICTS_ENABLED) {
    logger.warn('PARKED_FALL_VERDICTS_ENABLED=false — parked fuel falls will not get a verdict')
    return noop
  }
  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — parked fuel fall verdicts NOT scheduled')
    return noop
  }

  queue = new Queue(PARKED_FALLS_QUEUE, { connection })
  // A changed cadence must not leave the old scheduler firing alongside the new one.
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === VERDICT_JOB) await queue.removeRepeatableByKey(r.key)
  }
  await queue.add(VERDICT_JOB, {}, {
    repeat:           { pattern: env.PARKED_FALL_CRON },
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 50 },
    attempts:         1,
  })

  worker = new Worker(PARKED_FALLS_QUEUE, async (job: Job) => {
    if (job.name !== VERDICT_JOB) return
    if (running) {
      logger.warn({ jobId: job.id }, 'Parked fall verdicts: previous pass still running — skipping this tick')
      return
    }
    running = true
    try { return await runParkedFallVerdicts() } finally { running = false }
  }, { connection, concurrency: 1 })
  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Parked fall verdict job failed'))

  logger.info({ queue: PARKED_FALLS_QUEUE, cron: env.PARKED_FALL_CRON }, 'Parked fall verdicts scheduled')
  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue = null
    },
  }
}
