import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requireVehicleInScope } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { sendSuccess } from '../../core/response/response.js'
import { ConflictError } from '../../core/errors/errors.js'
import { getUsageReview, peekUsageReview, pointsOf, renderReport, reviewForDownload, type ReadyReview, type RenderOptions } from './usage-review.service.js'
import { aiActivities, aiStatus, cachedActivity, nameKey } from './usage-review.activity-ai.js'

/**
 * Unit usage review — drive hours, distance, fuel (estimated) and the places a
 * unit spent its time, over a chosen period, with the workbook and PDF.
 *
 *   GET …/vehicles/:vehicleId/usage-review?from&to[&fresh=1][&cached=1]
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
  // Only what is already built or building: never starts a build.
  cached: z.enum(['0', '1']).optional(),
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
    const { from, to, fresh, cached } = q(req)
    const st = cached === '1' && fresh !== '1'
      ? await peekUsageReview(p(req, 'orgId'), p(req, 'vehicleId'), from, to)
      : await getUsageReview(p(req, 'orgId'), p(req, 'vehicleId'), from, to, fresh === '1')
    if (st.status === 'ready' && st.review) return sendSuccess(res, { ...st, review: forPage(st.review) })
    sendSuccess(res, st, st.status === 'failed' || st.status === 'none' ? 200 : 202)
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

/** Google's names from the page, for the held review's places: each a name,
 *  or `{ name, activity }` where Google's type says what the place is. Worked
 *  out here, where the activity cache lives, and handed to the renderer as
 *  overrides by place id. A malformed `names` is ignored: the download falls
 *  back to OpenStreetMap. */
function nameOverrides(rv: ReadyReview, raw: string | undefined): RenderOptions['overrides'] {
  const out: RenderOptions['overrides'] = {}
  let names: Record<string, unknown> = {}
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') names = parsed as Record<string, unknown>
    } catch { /* ignored, as above */ }
  }
  const clean = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
  for (const pl of rv.places) {
    // Named by a site plan or geofence on the build: the company's own name
    // for its ground beats the nearest business Google found (siteplans).
    if (pl.nameFrom) continue
    const v = names[String(pl.id)]
    const o = v && typeof v === 'object' ? v as Record<string, unknown> : { name: v }
    const name = clean(o['name'], 120)
    // What OpenAI read from the name, when it has been asked (the page asks
    // as the names arrive), over the page's own reading of Google's type.
    if (name) out[String(pl.id)] = { exactName: name, activity: cachedActivity(name) ?? clean(o['activity'], 40) }
    // No Google name: the OpenStreetMap business from the build stands.
    else if (pl.exactName) {
      const activity = cachedActivity(pl.exactName) ?? pl.activity ?? null
      if (activity !== (pl.activity ?? null)) out[String(pl.id)] = { exactName: pl.exactName, activity }
    }
  }
  return out
}

/** The download's file, from the worker (or made here), kept for the next. */
async function download(req: Parameters<RequestHandler>[0], format: 'pdf' | 'xlsx') {
  const { from, to, kmpl, names, driver } = q(req)
  const rv = await held(req)
  const options: RenderOptions = {
    format, kmpl: rate(rv, kmpl), rateNote: rateNote(rv, kmpl),
    driver: format === 'pdf' ? driver ?? null : null,
    overrides: nameOverrides(rv, names),
  }
  return { rv, buf: await renderReport(p(req, 'orgId'), p(req, 'vehicleId'), from, to, rv, options) }
}

const getXlsx: RequestHandler = async (req, res, next) => {
  try {
    const { rv, buf } = await download(req, 'xlsx')
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(rv, 'xlsx')}"`)
    res.send(buf)
  } catch (err) { next(err) }
}

const getPdf: RequestHandler = async (req, res, next) => {
  try {
    const { rv, buf } = await download(req, 'pdf')
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

const getDay: RequestHandler = async (req, res, next) => {
  try {
    await held(req)
    const { from, to } = q(req)
    const { date } = req.query as unknown as { date: string }
    // One day's file of the saved review, not the whole period's fixes.
    const points = (await pointsOf(p(req, 'orgId'), p(req, 'vehicleId'), from, to, date))
      .map(pt => [pt.t, pt.lat, pt.lng, Math.round(pt.speed), pt.course, pt.ign == null ? null : pt.ign ? 1 : 0])
    sendSuccess(res, { date, points })
  } catch (err) { next(err) }
}

const router = Router({ mergeParams: true })
router.use(authenticate, requireOrgAccess)
// logbook:read on top of telemetry:read: operator and technician read telemetry
// for other screens and are not given the Logbook (2026-10-26).
const guard = [requirePermission('telemetry:read'), requirePermission('logbook:read'), requireVehicleInScope, validateQuery(reviewQuery)]
router.get('/vehicles/:vehicleId/usage-review', ...guard, getReview)
router.get('/vehicles/:vehicleId/usage-review/xlsx', ...guard, getXlsx)
router.get('/vehicles/:vehicleId/usage-review/pdf', ...guard, getPdf)
router.post('/vehicles/:vehicleId/usage-review/activities', requirePermission('telemetry:read'), requirePermission('logbook:read'), requireVehicleInScope, validateBody(activitiesBody), postActivities)
router.get('/vehicles/:vehicleId/usage-review/day', requirePermission('telemetry:read'), requirePermission('logbook:read'), requireVehicleInScope, validateQuery(dayQuery), getDay)

export default router
