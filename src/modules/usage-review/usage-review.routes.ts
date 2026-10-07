import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requireVehicleInScope } from '../../middleware/authorize.js'
import { validateQuery } from '../../middleware/validate.js'
import { sendSuccess } from '../../core/response/response.js'
import { ConflictError } from '../../core/errors/errors.js'
import { getUsageReview, reviewForDownload, type ReadyReview } from './usage-review.service.js'
import { buildUsageReviewXlsx } from './usage-review.xlsx.js'
import { renderUsageReviewPdf } from './usage-review.pdf.js'

/**
 * Unit usage review — drive hours, distance, fuel (estimated) and the places a
 * unit spent its time, over a chosen period, with the workbook and PDF.
 *
 *   GET …/vehicles/:vehicleId/usage-review?from&to[&fresh=1]
 *       202 + progress while it builds, 200 + the review when ready.
 *   GET …/vehicles/:vehicleId/usage-review/xlsx?from&to[&kmpl]
 *   GET …/vehicles/:vehicleId/usage-review/pdf?from&to[&kmpl]
 *
 * `kmpl` overrides the vehicle's rate for the fuel estimate in a download.
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const reviewQuery = z.object({
  from: day, to: day,
  fresh: z.enum(['0', '1']).optional(),
  kmpl: z.coerce.number().positive().max(100).optional(),
})
type ReviewQuery = z.infer<typeof reviewQuery>

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
const fileName = (rv: ReadyReview, ext: string) => `${safe(rv.vehicle.plate)}_${rv.period.from}_${rv.period.to}_motor-report.${ext}`
const rate = (rv: ReadyReview, kmpl: number | undefined) => kmpl ?? rv.vehicle.kmpl
const rateNote = (rv: ReadyReview, kmpl: number | undefined) =>
  kmpl != null ? 'rate entered for this report' : rv.vehicle.kmplSource === 'vehicle' ? 'rate on the vehicle record' : 'rate in the Wialon unit name'

async function held(req: Parameters<RequestHandler>[0]) {
  const { from, to } = q(req)
  const rv = await reviewForDownload(p(req, 'orgId'), p(req, 'vehicleId'), from, to)
  if (!rv) throw new ConflictError('The review is still being built. Try the download again in a moment.')
  return rv
}

const getXlsx: RequestHandler = async (req, res, next) => {
  try {
    const rv = await held(req)
    const buf = buildUsageReviewXlsx(rv, rate(rv, q(req).kmpl), rateNote(rv, q(req).kmpl))
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(rv, 'xlsx')}"`)
    res.send(buf)
  } catch (err) { next(err) }
}

const getPdf: RequestHandler = async (req, res, next) => {
  try {
    const rv = await held(req)
    const buf = await renderUsageReviewPdf(rv, rate(rv, q(req).kmpl))
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(rv, 'pdf')}"`)
    res.send(buf)
  } catch (err) { next(err) }
}

const router = Router({ mergeParams: true })
router.use(authenticate, requireOrgAccess)
const guard = [requirePermission('telemetry:read'), requireVehicleInScope, validateQuery(reviewQuery)]
router.get('/vehicles/:vehicleId/usage-review', ...guard, getReview)
router.get('/vehicles/:vehicleId/usage-review/xlsx', ...guard, getXlsx)
router.get('/vehicles/:vehicleId/usage-review/pdf', ...guard, getPdf)

export default router
