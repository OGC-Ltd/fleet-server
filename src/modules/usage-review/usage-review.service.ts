/**
 * Usage review jobs: one unit, one period, built once and served from memory.
 *
 * A review reads up to ~90 days of messages from Wialon and names up to 40
 * places at one lookup a second, so it takes tens of seconds — longer than a
 * request should be held open behind two proxies. It runs as a JOB instead: the
 * first request starts it and gets its progress back; the page asks again until
 * it is ready. The finished review is kept so the page, the workbook and the PDF
 * all come from the same build.
 *
 * In memory, on purpose: the server runs as one process (pm2 fork mode), and a
 * review is cheap to rebuild if a restart loses it.
 */

import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { BadRequestError, NotFoundError } from '../../core/errors/errors.js'
import { buildUsageReview, dayStartMs, daysBetween, eatDay, type UsageReview } from './usage-review.compute.js'
import { loadUnitHistory, type UnitHistory } from './usage-review.wialon.js'
import { heldDays, loadDbHistory } from './usage-review.db.js'
import { namePlaces } from './usage-review.geocode.js'
import type { AreaSummary } from './usage-review.areas.js'

export const MAX_DAYS = 92
/** Places named per review; the rest keep their coordinates. */
export const NAMED_PLACES = 40
/** Read this far either side of the period, so the odometer carries in and the last step has an end. */
const MARGIN_S = 6 * 3600
const KEEP_DONE_MS = 6 * 3_600_000
/** A review that runs to today goes stale as the day goes on. */
const KEEP_OPEN_MS = 10 * 60_000
const KEEP_FAILED_MS = 60_000
const MAX_RUNNING = 2
const MAX_KEPT = 60

export interface ReviewVehicle {
  vehicleId: string
  plate: string
  name: string
  vehicleType: string
  wialonUnitId: number
  wialonName: string | null
  organisation: string
  /** km/L on our vehicle record, or written in the Wialon unit name ("…-11km/l"). */
  kmpl: number | null
  kmplSource: 'vehicle' | 'unit-name' | null
}

export interface ReadyReview extends UsageReview {
  vehicle: ReviewVehicle
  builtAt: number
  /** Wialon unreachable: the review was read from our table, and these days of it have holes. */
  incompleteDays: string[]
  wialonError: string | null
  /** The period split by kind of place; set on a download (usage-review.areas). */
  areas?: AreaSummary
}

type Stage = 'queued' | 'loading' | 'computing' | 'naming' | 'ready' | 'failed'
interface Job {
  key: string
  stage: Stage
  progress: { done: number; total: number }
  startedAt: number
  finishedAt: number | null
  error: string | null
  result: ReadyReview | null
  promise: Promise<void> | null
}

const jobs = new Map<string, Job>()
let running = 0
const waiting: (() => void)[] = []

async function slot(): Promise<() => void> {
  if (running >= MAX_RUNNING) await new Promise<void>(r => waiting.push(r))
  running++
  return () => { running--; waiting.shift()?.() }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
export function validatePeriod(from: string, to: string): void {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new BadRequestError('from and to must be dates, YYYY-MM-DD')
  }
  if (to < from) throw new BadRequestError('The period ends before it starts')
  if (from > eatDay(Date.now())) throw new BadRequestError('The period starts in the future')
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1
  if (days > MAX_DAYS) throw new BadRequestError(`One review covers at most ${MAX_DAYS} days`)
}

const kmplFromName = (name: string | null): number | null => {
  const m = /(\d+(?:\.\d+)?)\s*km\s*\/\s*l/i.exec(name ?? '')
  const v = m ? Number(m[1]) : NaN
  return v > 0 && v < 60 ? v : null
}

async function findVehicle(orgId: string, vehicleId: string) {
  const v = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organisationId: orgId },
    select: {
      id: true, name: true, registrationPlate: true, vehicleType: true, deviceId: true, fuelEfficiencyKmpl: true,
      organisation: { select: { name: true } },
    },
  })
  if (!v) throw new NotFoundError('Vehicle')
  const m = /^wialon:(\d+)$/.exec(v.deviceId)
  if (!m) throw new BadRequestError('This vehicle has no GPS tracker on Wialon, so there is no history to review')
  return { v, wialonUnitId: Number(m[1]) }
}

function sweep() {
  const now = Date.now()
  for (const [k, j] of jobs) {
    if (j.stage === 'failed' && now - (j.finishedAt ?? now) > KEEP_FAILED_MS) jobs.delete(k)
    if (j.stage === 'ready' && j.result) {
      const open = j.result.period.endMs > j.result.builtAt
      if (now - (j.finishedAt ?? now) > (open ? KEEP_OPEN_MS : KEEP_DONE_MS)) jobs.delete(k)
    }
  }
  // Oldest finished first, if there are too many.
  const done = [...jobs.values()].filter(j => j.stage === 'ready' || j.stage === 'failed')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  while (jobs.size > MAX_KEPT && done.length) jobs.delete(done.shift()!.key)
}

async function run(job: Job, orgId: string, vehicleId: string, from: string, to: string) {
  const release = await slot()
  try {
    const { v, wialonUnitId } = await findVehicle(orgId, vehicleId)
    job.stage = 'loading'
    const startMs = dayStartMs(from)
    const endMs = Math.min(dayStartMs(to) + 86_400_000, Date.now())
    const marginMs = MARGIN_S * 1000

    // Wialon first: every message the tracker sent, with its odometer.
    // Measured 2026-10-07 on KDW 662X over 17 days, our table held 13,115
    // messages to Wialon's 21,232 and measured 1,476 km on the GPS track
    // against the odometer's 1,515 (-2.5%, -6.3% on the worst day) — and took
    // longer to read (6.1 s against 4.0 s). So the table is the FALLBACK: it
    // stands in when Wialon cannot be reached, and the days it does not hold
    // completely are flagged.
    let hist: UnitHistory = { unitName: null, messages: [] }
    let wialonError: string | null = null
    try {
      hist = await loadUnitHistory(
        wialonUnitId, [[Math.floor((startMs - marginMs) / 1000), Math.floor(Math.min(endMs + marginMs, Date.now()) / 1000)]],
        (done, total) => { job.progress = { done, total } },
      )
    } catch (err) {
      wialonError = (err as Error).message
      logger.warn({ vehicleId, err: wialonError }, 'Usage review: Wialon unavailable — falling back to the database')
    }
    let messages = hist.messages
    let incompleteDays: string[] = []
    if (wialonError) {
      const db = await loadDbHistory(v.id, startMs - marginMs, endMs + marginMs)
      if (!db.length) throw new Error(`Wialon could not be reached (${wialonError}) and the database holds nothing for this period`)
      const held = heldDays(db, from, to)
      messages = db
      incompleteDays = daysBetween(from, to).filter(d => !held.has(d))
    }

    job.stage = 'computing'
    job.progress = { done: 0, total: 1 }
    const review = buildUsageReview(messages, from, to)

    job.stage = 'naming'
    await namePlaces(review.places, NAMED_PLACES, (done, total) => { job.progress = { done, total } })

    const nameRate = kmplFromName(hist.unitName)
    job.result = {
      ...review,
      builtAt: Date.now(),
      incompleteDays, wialonError,
      vehicle: {
        vehicleId: v.id, plate: v.registrationPlate, name: v.name, vehicleType: v.vehicleType,
        wialonUnitId, wialonName: hist.unitName, organisation: v.organisation.name,
        kmpl: v.fuelEfficiencyKmpl ?? nameRate,
        kmplSource: v.fuelEfficiencyKmpl != null ? 'vehicle' : nameRate != null ? 'unit-name' : null,
      },
    }
    job.stage = 'ready'
    logger.info({ vehicleId, from, to, messages: review.quality.messages, fallback: wialonError != null, ms: Date.now() - job.startedAt }, 'Usage review built')
  } catch (err) {
    job.stage = 'failed'
    job.error = (err as Error).message || 'The review could not be built'
    logger.warn({ vehicleId, from, to, err: job.error }, 'Usage review failed')
  } finally {
    job.finishedAt = Date.now()
    release()
  }
}

export interface ReviewStatus {
  status: 'running' | 'ready' | 'failed'
  stage: Stage
  progress: { done: number; total: number }
  startedAt: number
  error?: string
  review?: ReadyReview
}

/**
 * The review for this unit and period: started if it is not held, returned if
 * it is. `fresh` throws away a held one and builds again.
 */
export async function getUsageReview(orgId: string, vehicleId: string, from: string, to: string, fresh = false): Promise<ReviewStatus> {
  validatePeriod(from, to)
  sweep()
  const key = `${orgId}|${vehicleId}|${from}|${to}`
  let job = jobs.get(key)
  if (job && fresh && (job.stage === 'ready' || job.stage === 'failed')) { jobs.delete(key); job = undefined }
  if (!job) {
    // Fail fast on a vehicle that cannot be reviewed, rather than via a job.
    await findVehicle(orgId, vehicleId)
    job = { key, stage: 'queued', progress: { done: 0, total: 0 }, startedAt: Date.now(), finishedAt: null, error: null, result: null, promise: null }
    jobs.set(key, job)
    job.promise = run(job, orgId, vehicleId, from, to)
  }
  if (job.stage === 'ready' && job.result) return { status: 'ready', stage: job.stage, progress: job.progress, startedAt: job.startedAt, review: job.result }
  if (job.stage === 'failed') return { status: 'failed', stage: job.stage, progress: job.progress, startedAt: job.startedAt, error: job.error ?? 'Failed' }
  return { status: 'running', stage: job.stage, progress: job.progress, startedAt: job.startedAt }
}

/** A finished review, for the downloads. Null when it is not built (or no longer held). */
export function heldReview(orgId: string, vehicleId: string, from: string, to: string): ReadyReview | null {
  const job = jobs.get(`${orgId}|${vehicleId}|${from}|${to}`)
  return job?.stage === 'ready' ? job.result : null
}

/**
 * A finished review for a download: the held one, or — if it has expired from
 * memory since the page showed it — built again, waited for up to `waitMs`.
 */
export async function reviewForDownload(orgId: string, vehicleId: string, from: string, to: string, waitMs = 110_000): Promise<ReadyReview | null> {
  const held = heldReview(orgId, vehicleId, from, to)
  if (held) return held
  const st = await getUsageReview(orgId, vehicleId, from, to)
  if (st.review) return st.review
  const job = jobs.get(`${orgId}|${vehicleId}|${from}|${to}`)
  if (job?.promise) await Promise.race([job.promise, new Promise(r => setTimeout(r, waitMs))])
  return heldReview(orgId, vehicleId, from, to)
}
