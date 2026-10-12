/**
 * Usage review jobs: one unit, one period, built once and kept.
 *
 * A review reads up to ~90 days of messages from Wialon and names up to 40
 * places at one lookup a second, so it takes tens of seconds — longer than a
 * request should be held open behind two proxies. It runs as a JOB instead: the
 * first request starts it and gets its progress back; the page asks again until
 * it is ready. The finished review is kept so the page, the workbook and the PDF
 * all come from the same build.
 *
 * Where it runs and where it is kept (2026-10-10, "300+ users generating
 * reports"): the build is a job on the `usage-review` queue, run by the
 * report-worker process (lib/queues/usage-review), several side by side; the
 * finished review is saved on disk (usage-review.saved) and served from there
 * to everyone who asks for that unit and those dates. Without Redis, with the
 * worker switched off, or with the worker not answering, the build runs here
 * in the API process as it always did, two at a time, and is saved the same
 * way. A PDF or workbook is rendered by the worker too, and kept beside the
 * review it came from.
 */

import crypto from 'node:crypto'
import type { Job as QueueJob } from 'bullmq'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { BadRequestError, NotFoundError } from '../../core/errors/errors.js'
import { renderQueue, reviewQueue, useReportWorker } from '../../lib/queues/usage-review.js'
import { buildUsageReview, dayStartMs, daysBetween, eatDay, type ReviewPoint, type UsageReview } from './usage-review.compute.js'
import { loadAllPoints, loadPoints, loadReview, reviewKey, saveFile, saveReview, savedFile, dropReview } from './usage-review.saved.js'
import { buildUsageReviewXlsx } from './usage-review.xlsx.js'
import { renderUsageReviewPdf } from './usage-review.pdf.js'
import { loadUnitHistory, type UnitHistory } from './usage-review.wialon.js'
import { heldDays, loadDbHistory } from './usage-review.db.js'
import { namePlaces } from './usage-review.geocode.js'
import { namePois } from './usage-review.poi.js'
import { classifyPlaces, loadFences, loadSites, STATIC_SITES, type AreaSummary, type Site } from './usage-review.areas.js'
import { loadSitePlans, mergeSiteNamedPlaces, nameBySite, nameStops, siteVisits, type SiteVisit } from './usage-review.siteplans.js'

export const MAX_DAYS = 92
/** Places named per review; the rest keep their coordinates. */
// The places anything shows: the page's map holds 30, the PDF 15. Each one
// costs Nominatim's 1.1 s on a cold cache (2026-10-09: was 40).
export const NAMED_PLACES = 30
/** Read this far either side of the period, so the odometer carries in and the last step has an end. */
const MARGIN_S = 6 * 3600
const KEEP_DONE_MS = 6 * 3_600_000
/** A review that runs to today goes stale as the day goes on. */
const KEEP_OPEN_MS = 10 * 60_000
const KEEP_FAILED_MS = 60_000
/** Builds side by side in this process: two in the API, where a build shares
 *  the event loop with everything else; the worker sets its own (setBuildSlots). */
let maxRunning = 2
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
  /** The period split by kind of place (usage-review.areas). Set on the build,
   *  and again on a download, where Google's names can make a place a site. */
  areas?: AreaSummary
  /** Each time it went onto a site plan or one of the organisation's
   *  geofences: arrival, the areas it stood in, departure (siteVisits). */
  siteVisits?: SiteVisit[]
}

export type Stage = 'queued' | 'loading' | 'computing' | 'naming' | 'ready' | 'failed'
export interface BuildProgress { stage: Stage; done: number; total: number }
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

/** How many builds this process runs side by side (the worker's concurrency). */
export function setBuildSlots(n: number) { maxRunning = Math.max(1, n) }

async function slot(): Promise<() => void> {
  if (running >= maxRunning) await new Promise<void>(r => waiting.push(r))
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

/**
 * Builds one review: Wialon's history (our table if Wialon cannot be reached),
 * the arithmetic, the places named. The worker runs this for a queued build;
 * the API process for one it builds itself.
 */
export async function buildReview(
  orgId: string, vehicleId: string, from: string, to: string,
  onProgress: (p: BuildProgress) => void = () => {},
): Promise<ReadyReview> {
  const held = await slot()
  let freed = false
  const release = () => { if (!freed) { freed = true; held() } }
  try {
    const { v, wialonUnitId } = await findVehicle(orgId, vehicleId)
    onProgress({ stage: 'loading', done: 0, total: 0 })
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
        (done, total) => onProgress({ stage: 'loading', done, total }),
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

    onProgress({ stage: 'computing', done: 0, total: 1 })
    const review = buildUsageReview(messages, from, to)
    // The slot guards the heavy part — Wialon and the arithmetic. Naming waits
    // on outside services that pace themselves (Nominatim one a second, shared
    // by every review), so it no longer holds a slot: measured 2026-10-09, a
    // review whose places were all known waited 34 s queued behind two that
    // were naming.
    release()

    onProgress({ stage: 'naming', done: 0, total: 0 })
    // The company's own ground first: a place inside a site plan or one of the
    // organisation's geofences takes that name, and the lookups below leave it
    // alone (usage-review.siteplans). Costs no outside call.
    let fences: Site[] = []
    let visits: SiteVisit[] | undefined
    try {
      fences = await loadFences(orgId)
      nameBySite(review.places, review.stops, loadSitePlans(), fences)
      // A site bigger than a place holds several, all named alike: one row.
      mergeSiteNamedPlaces(review)
      nameStops(review.stops, loadSitePlans(), fences)
      visits = siteVisits(review.points, loadSitePlans(), fences)
    } catch (err) {
      logger.warn({ vehicleId, err: (err as Error).message }, 'Usage review: places not named by site')
    }
    // The area (Nominatim) and the business there (Overpass): two services,
    // asked side by side.
    await Promise.all([
      namePlaces(review.places, NAMED_PLACES, (done, total) => onProgress({ stage: 'naming', done, total })),
      namePois(review.places, NAMED_PLACES),
    ])

    // Each place's kind. Not worth failing a review over — without it it is
    // the review it always was.
    let areas: AreaSummary | undefined
    try {
      const { byPlace, summary } = classifyPlaces(review.places, review.stops, review.period, [...fences, ...STATIC_SITES])
      areas = summary
      for (const p of review.places) {
        const a = byPlace.get(p.id)
        if (a) { p.kind = a.kind; p.site = a.site; p.nights = a.nights }
        // A work site with no business named there is still work.
        if (a?.kind === 'work' && !p.activity) p.activity = 'Work'
      }
    } catch (err) {
      logger.warn({ vehicleId, err: (err as Error).message }, 'Usage review: place kinds not worked out')
    }

    const nameRate = kmplFromName(hist.unitName)
    return {
      ...review,
      areas,
      siteVisits: visits,
      builtAt: Date.now(),
      incompleteDays, wialonError,
      vehicle: {
        vehicleId: v.id, plate: v.registrationPlate, name: v.name, vehicleType: v.vehicleType,
        wialonUnitId, wialonName: hist.unitName, organisation: v.organisation.name,
        kmpl: v.fuelEfficiencyKmpl ?? nameRate,
        kmplSource: v.fuelEfficiencyKmpl != null ? 'vehicle' : nameRate != null ? 'unit-name' : null,
      },
    }
  } finally {
    release()
  }
}

/** A build run here in the API process: when the worker is not in use. */
async function run(job: Job, orgId: string, vehicleId: string, from: string, to: string) {
  try {
    const rv = await buildReview(orgId, vehicleId, from, to, (pr) => { job.stage = pr.stage; job.progress = { done: pr.done, total: pr.total } })
    // Kept for everyone, and for after a restart, before it is called ready;
    // served from the job alone if the disk will not take it.
    await saveReview(reviewKey(orgId, vehicleId, from, to), rv)
      .catch(err => logger.warn({ vehicleId, err: (err as Error).message }, 'Usage review: not saved'))
    job.result = rv
    job.stage = 'ready'
    logger.info({ vehicleId, from, to, messages: rv.quality.messages, fallback: rv.wialonError != null, ms: Date.now() - job.startedAt }, 'Usage review built')
  } catch (err) {
    job.stage = 'failed'
    job.error = (err as Error).message || 'The review could not be built'
    logger.warn({ vehicleId, from, to, err: job.error }, 'Usage review failed')
  } finally {
    job.finishedAt = Date.now()
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

/** A held review is current when its period had closed when it was built, or
 *  was built in the last few minutes. */
const current = (rv: ReadyReview) => rv.period.endMs <= rv.builtAt || Date.now() - rv.builtAt < KEEP_OPEN_MS

const ready = (rv: ReadyReview): ReviewStatus =>
  ({ status: 'ready', stage: 'ready', progress: { done: 1, total: 1 }, startedAt: rv.builtAt, review: rv })

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 24)
/** One queued build per review; a rebuild asked for gets an id of its own. */
const buildId = (key: string) => `ur_${hash(key)}`
const freshIds = new Map<string, string>()

/** Status from the queue, and the build added when there is none. */
async function queued(key: string, orgId: string, vehicleId: string, from: string, to: string, fresh: boolean): Promise<ReviewStatus | null> {
  const q = reviewQueue()
  if (!q) return null
  if (fresh) freshIds.set(key, `${buildId(key)}_f${Date.now()}`)
  const id = freshIds.get(key) ?? buildId(key)
  let job: QueueJob | undefined = await q.getJob(id)
  if (job) {
    const state = await job.getState()
    if (state === 'failed' && Date.now() - (job.finishedOn ?? 0) < KEEP_FAILED_MS) {
      return { status: 'failed', stage: 'failed', progress: { done: 0, total: 0 }, startedAt: job.timestamp, error: job.failedReason || 'The review could not be built' }
    }
    if (state === 'failed' || state === 'completed' || state === 'unknown') {
      // Done, but nothing current is held (the period was still open, or the
      // store let it go): built again.
      await job.remove().catch(() => {})
      job = undefined
    } else {
      const pr = (job.progress ?? {}) as Partial<BuildProgress>
      return {
        status: 'running', stage: state === 'active' ? pr.stage ?? 'loading' : 'queued',
        progress: { done: pr.done ?? 0, total: pr.total ?? 0 }, startedAt: job.timestamp,
      }
    }
  }
  // Fail fast on a vehicle that cannot be reviewed, rather than via a job.
  await findVehicle(orgId, vehicleId)
  job = await q.add('build', { orgId, vehicleId, from, to }, {
    jobId: id,
    attempts: 2, backoff: { type: 'fixed', delay: 10_000 },
    removeOnComplete: { age: 3_600, count: 1_000 }, removeOnFail: { age: 3_600, count: 1_000 },
  })
  return { status: 'running', stage: 'queued', progress: { done: 0, total: 0 }, startedAt: job.timestamp ?? Date.now() }
}

/** Status from a build in this process, and the build started when there is none. */
async function local(key: string, orgId: string, vehicleId: string, from: string, to: string): Promise<ReviewStatus> {
  let job = jobs.get(key)
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

/**
 * The review for this unit and period: returned when one is held, its build's
 * progress while one runs, and a build started when neither. `fresh` throws
 * away a held one and builds again.
 */
export async function getUsageReview(orgId: string, vehicleId: string, from: string, to: string, fresh = false): Promise<ReviewStatus> {
  validatePeriod(from, to)
  sweep()
  const key = reviewKey(orgId, vehicleId, from, to)
  const mine = jobs.get(key)
  if (fresh && (!mine || mine.stage === 'ready' || mine.stage === 'failed')) {
    jobs.delete(key)
    await dropReview(key).catch(() => {})
  } else {
    const saved = await loadReview(key)
    if (saved && current(saved)) return ready(saved)
  }
  // A build already under way here is followed to its end, whatever the
  // worker's state since.
  if (jobs.has(key)) return local(key, orgId, vehicleId, from, to)
  if (await useReportWorker()) {
    const st = await queued(key, orgId, vehicleId, from, to, fresh)
    if (st) return st
  }
  return local(key, orgId, vehicleId, from, to)
}

/**
 * A finished review for a download: the held one, or — if it is not built yet
 * or no longer held — built, waited for up to `waitMs`. Its GPS fixes are not
 * loaded (`points` is empty): see pointsOf.
 */
export async function reviewForDownload(orgId: string, vehicleId: string, from: string, to: string, waitMs = 110_000): Promise<ReadyReview | null> {
  const until = Date.now() + waitMs
  for (;;) {
    const st = await getUsageReview(orgId, vehicleId, from, to)
    if (st.review) return st.review
    if (st.status === 'failed' || Date.now() >= until) return null
    await new Promise(r => setTimeout(r, 1_000))
  }
}

/** The review's GPS fixes, all of them or one EAT day's: from the store, or
 *  from a build held here when the store has none. */
export async function pointsOf(orgId: string, vehicleId: string, from: string, to: string, date?: string): Promise<ReviewPoint[]> {
  const key = reviewKey(orgId, vehicleId, from, to)
  const kept = date ? await loadPoints(key, date) : await loadAllPoints(key)
  if (kept && kept.length) return kept
  const pts = jobs.get(key)?.result?.points ?? []
  return date ? pts.filter(p => eatDay(p.t) === date) : pts
}

// ── downloads ───────────────────────────────────────────────────────────────

export interface RenderOptions {
  format: 'pdf' | 'xlsx'
  kmpl: number | null
  /** The workbook's note on where the rate came from. */
  rateNote: string
  /** The PDF's subject: the driver the page shows. */
  driver: string | null
  /** Names and activities from the page (Google), by place id: see nameOverrides. */
  overrides: Record<string, { exactName: string; activity: string | null }>
}

/** The page's names onto a copy of the review's places. */
export function withOverrides(rv: ReadyReview, ov: RenderOptions['overrides']): ReadyReview {
  if (!Object.keys(ov).length) return rv
  return { ...rv, places: rv.places.map(pl => (ov[String(pl.id)] ? { ...pl, ...ov[String(pl.id)] } : pl)) }
}

/** Each place's kind (work site, home area, elsewhere) and the period's split
 *  by kind, onto a copy of the review — see usage-review.areas. */
async function withAreas(rv: ReadyReview, orgId: string): Promise<ReadyReview> {
  const { byPlace, summary } = classifyPlaces(rv.places, rv.stops, rv.period, await loadSites(orgId))
  return {
    ...rv,
    areas: summary,
    places: rv.places.map(pl => {
      const a = byPlace.get(pl.id)
      // A work site with no business named there is still work.
      return a ? { ...pl, kind: a.kind, site: a.site, nights: a.nights, activity: pl.activity || (a.kind === 'work' ? 'Work' : null) } : pl
    }),
  }
}

/** Renders a PDF or workbook from a review (with its fixes, for a workbook). */
export async function renderFile(rv: ReadyReview, orgId: string, o: RenderOptions): Promise<Buffer> {
  const named = await withAreas(withOverrides(rv, o.overrides), orgId)
  return o.format === 'pdf'
    ? renderUsageReviewPdf(named, o.kmpl, o.driver)
    : buildUsageReviewXlsx(named, o.kmpl, o.rateNote)
}

/** The kept file's name: the options decide what is in it. */
export const fileKey = (o: RenderOptions) => `${o.format}-${hash(JSON.stringify(o))}.${o.format}`

const RENDER_WAIT_MS = 100_000

/**
 * A PDF or workbook of a held review: the one rendered before with the same
 * options, else rendered by the worker (or here, when the worker is not in
 * use) and kept beside the review.
 */
export async function renderReport(orgId: string, vehicleId: string, from: string, to: string, rv: ReadyReview, o: RenderOptions): Promise<Buffer> {
  const key = reviewKey(orgId, vehicleId, from, to)
  const name = fileKey(o)
  const kept = await savedFile(key, name)
  if (kept) return kept

  const q = (await useReportWorker()) && (await loadReview(key)) ? renderQueue() : null
  if (q) {
    const id = `rd_${hash(`${key}|${name}`)}`
    const old = await q.getJob(id)
    if (old && ['completed', 'failed', 'unknown'].includes(await old.getState())) await old.remove().catch(() => {})
    await q.add('render', { orgId, vehicleId, from, to, options: o, name }, {
      jobId: id, attempts: 1, removeOnComplete: { age: 600, count: 500 }, removeOnFail: { age: 600, count: 500 },
    })
    const until = Date.now() + RENDER_WAIT_MS
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 300))
      const buf = await savedFile(key, name)
      if (buf) return buf
      const job = await q.getJob(id)
      if (job && (await job.getState()) === 'failed') throw new Error(job.failedReason || 'The file could not be made')
    }
    throw new Error('The file is taking too long to make. Try the download again in a minute.')
  }

  const full = o.format === 'xlsx' ? { ...rv, points: await pointsOf(orgId, vehicleId, from, to) } : rv
  const buf = await renderFile(full, orgId, o)
  await saveFile(key, name, buf).catch(() => {})
  return buf
}
