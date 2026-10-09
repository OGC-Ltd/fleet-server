import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requireVehicleInScope } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { sendSuccess } from '../../core/response/response.js'
import { ConflictError } from '../../core/errors/errors.js'
import { getUsageReview, reviewForDownload, type ReadyReview } from './usage-review.service.js'
import { buildUsageReviewXlsx } from './usage-review.xlsx.js'
import { renderUsageReviewPdf } from './usage-review.pdf.js'
import { classifyPlaces, loadSites } from './usage-review.areas.js'
import { aiActivities, aiStatus, cachedActivity, nameKey } from './usage-review.activity-ai.js'

/**
 * Unit usage review — drive hours, distance, fuel (estimated) and the places a
 * unit spent its time, over a chosen period, with the workbook and PDF.
 *
 *   GET …/vehicles/:vehicleId/usage-review?from&to[&fresh=1]
 *       202 + progress while it builds, 200 + the review when ready.
 *   GET …/vehicles/:vehicleId/usage-review/xlsx?from&to[&kmpl][&names]
 *   GET …/vehicles/:vehicleId/usage-review/pdf?from&to[&kmpl][&names][&driver]
 *   POST …/vehicles/:vehicleId/usage-review/activities  { places: [{ name, hint? }] }
 *       what each named place is, read by OpenAI from its exact name (and
 *       Google's type as a hint): { activities: { [name]: group | null },
 *       models: [{ name, configured, resting, lastProblem }] } — see
 *       usage-review.activity-ai. Names it could not read are absent.
 *   GET …/vehicles/:vehicleId/usage-review/day?from&to&date
 *       one day's GPS fixes from the built review, for the page's playback:
 *       { date, points: [t ms, lat, lng, km/h, course|null, ignition 1/0/null][] }
 *
 * `kmpl` overrides the vehicle's rate for the fuel estimate in a download.
 * `names` is a JSON object of place id → Google's exact name (or { name,
 * activity }: what Google says the place is — Banking, Food and drink), the ones the
 * page already looked up (the server has no Google key); the downloads print
 * them beside the OpenStreetMap area. `driver` is the report's subject: the
 * driver the page shows on the vehicle.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const reviewQuery = z.object({
  from: day, to: day,
  fresh: z.enum(['0', '1']).optional(),
  kmpl: z.coerce.number().positive().max(100).optional(),
  names: z.string().max(8000).optional(),
  driver: z.string().max(120).optional(),
})
type ReviewQuery = z.infer<typeof reviewQuery>
const dayQuery = reviewQuery.extend({ date: day })
const activitiesBody = z.object({
  places: z.array(z.object({ name: z.string().min(1).max(120), hint: z.string().max(60).nullish() })).max(60),
})

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string
const q = (req: Parameters<RequestHandler>[0]) => req.query as unknown as ReviewQuery

/** The page does not need every GPS fix — those go to the workbook only. */
function forPage(rv: ReadyReview) {
  const { points, hours, ...rest } = rv
  return { ...rest, points: undefined, hourly: rv.days.map(d => hours.filter(h => h.date === d.date).map(h => h.driveMin)) }
}

const getReview: RequestHandler = async (req, res, next) => {
  try {
    const { from, to, fresh } = q(req)
    const st = await getUsageReview(p(req, 'orgId'), p(req, 'vehicleId'), from, to, fresh === '1')
    if (st.status === 'ready' && st.review) return sendSuccess(res, { ...st, review: forPage(st.review) })
    sendSuccess(res, st, st.status === 'failed' ? 200 : 202)
  } catch (err) { next(err) }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '')
const fileName = (rv: ReadyReview, ext: string) => `${safe(rv.vehicle.plate)}_${rv.period.from}_${rv.period.to}_${ext === 'pdf' ? 'tracking-report' : 'logbook'}.${ext}`
const rate = (rv: ReadyReview, kmpl: number | undefined) => kmpl ?? rv.vehicle.kmpl
const rateNote = (rv: ReadyReview, kmpl: number | undefined) =>
  kmpl != null ? 'rate entered for this report' : rv.vehicle.kmplSource === 'vehicle' ? 'rate on the vehicle record' : 'rate in the Wialon unit name'

async function held(req: Parameters<RequestHandler>[0]) {
  const { from, to } = q(req)
  const rv = await reviewForDownload(p(req, 'orgId'), p(req, 'vehicleId'), from, to)
  if (!rv) throw new ConflictError('The review is still being built. Try the download again in a moment.')
  return rv
}

/** Google's names from the page, onto a copy of the held review's places:
 *  each a name, or `{ name, activity }` where Google's type says what the
 *  place is. A malformed `names` is ignored: the download falls back to
 *  OpenStreetMap. */
function withNames(rv: ReadyReview, raw: string | undefined): ReadyReview {
  if (!raw) return rv
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return rv }
  if (!parsed || typeof parsed !== 'object') return rv
  const names = parsed as Record<string, unknown>
  const clean = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
  return {
    ...rv,
    places: rv.places.map(pl => {
      const v = names[String(pl.id)]
      const o = v && typeof v === 'object' ? v as Record<string, unknown> : { name: v }
      const name = clean(o['name'], 120)
      // What OpenAI read from the name, when it has been asked (the page asks
      // as the names arrive), over the page's own reading of Google's type.
      if (name) return { ...pl, exactName: name, activity: cachedActivity(name) ?? clean(o['activity'], 40) }
      // No Google name: the OpenStreetMap business from the build stands.
      return pl.exactName ? { ...pl, activity: cachedActivity(pl.exactName) ?? pl.activity ?? null } : pl
    }),
  }
}

/** Each place's kind (work site, home area, elsewhere) and the period's
 *  split by kind, onto a copy of the review — see usage-review.areas. */
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

const getXlsx: RequestHandler = async (req, res, next) => {
  try {
    const rv = await withAreas(withNames(await held(req), q(req).names), p(req, 'orgId'))
    const buf = buildUsageReviewXlsx(rv, rate(rv, q(req).kmpl), rateNote(rv, q(req).kmpl))
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(rv, 'xlsx')}"`)
    res.send(buf)
  } catch (err) { next(err) }
}

const getPdf: RequestHandler = async (req, res, next) => {
  try {
    const rv = await withAreas(withNames(await held(req), q(req).names), p(req, 'orgId'))
    const buf = await renderUsageReviewPdf(rv, rate(rv, q(req).kmpl), q(req).driver ?? null)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(rv, 'pdf')}"`)
    res.send(buf)
  } catch (err) { next(err) }
}

const postActivities: RequestHandler = async (req, res, next) => {
  try {
    const { places } = req.body as z.infer<typeof activitiesBody>
    const got = await aiActivities(places)
    const activities: Record<string, string | null> = {}
    for (const pl of places) { const k = nameKey(pl.name); if (got.has(k)) activities[pl.name] = got.get(k) ?? null }
    sendSuccess(res, { activities, models: aiStatus() })
  } catch (err) { next(err) }
}

/** The EAT calendar day of an instant (Kenya keeps no daylight saving). */
const eatDay = (ms: number) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10)

const getDay: RequestHandler = async (req, res, next) => {
  try {
    const rv = await held(req)
    const { date } = req.query as unknown as { date: string }
    const points = rv.points
      .filter(pt => eatDay(pt.t) === date)
      .map(pt => [pt.t, pt.lat, pt.lng, Math.round(pt.speed), pt.course, pt.ign == null ? null : pt.ign ? 1 : 0])
    sendSuccess(res, { date, points })
  } catch (err) { next(err) }
}

const router = Router({ mergeParams: true })
router.use(authenticate, requireOrgAccess)
const guard = [requirePermission('telemetry:read'), requireVehicleInScope, validateQuery(reviewQuery)]
router.get('/vehicles/:vehicleId/usage-review', ...guard, getReview)
router.get('/vehicles/:vehicleId/usage-review/xlsx', ...guard, getXlsx)
router.get('/vehicles/:vehicleId/usage-review/pdf', ...guard, getPdf)
router.post('/vehicles/:vehicleId/usage-review/activities', requirePermission('telemetry:read'), requireVehicleInScope, validateBody(activitiesBody), postActivities)
router.get('/vehicles/:vehicleId/usage-review/day', requirePermission('telemetry:read'), requireVehicleInScope, validateQuery(dayQuery), getDay)

export default router
