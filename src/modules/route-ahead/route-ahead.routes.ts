import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requireVehicleInScope } from '../../middleware/authorize.js'
import { validateQuery } from '../../middleware/validate.js'
import { sendSuccess } from '../../core/response/response.js'
import { BadRequestError } from '../../core/errors/errors.js'
import { getRouteAhead, getReach, REACH_MINUTES } from './route-ahead.service.js'
import { googleRoutingAvailable } from '../../providers/google-routing/index.js'
import { getHaltInvestigation } from '../fuel/fuel-investigation.js'

const routeQuery = z.object({
  destLat:  z.coerce.number().min(-90).max(90).optional(),
  destLng:  z.coerce.number().min(-180).max(180).optional(),
  destName: z.string().trim().max(80).optional(),
})

const reachQuery = z.object({
  // "15,30,60". Google caps a drive at 60 minutes.
  minutes: z.string().optional().default(REACH_MINUTES.join(','))
    .transform((s) => [...new Set(s.split(',').map(Number))])
    .refine((a) => a.length > 0 && a.length <= 3 && a.every((m) => Number.isInteger(m) && m >= 1 && m <= 60),
      'minutes: up to three whole numbers from 1 to 60'),
})

const haltQuery = z.object({
  // When the halt began: the map's `movement.since` for the unit.
  since: z.string().datetime({ offset: true }).transform((s) => Date.parse(s))
    .refine((ms) => ms <= Date.now() + 60_000 && ms >= Date.now() - 7 * 86_400_000, 'since: within the last 7 days'),
})

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

const haltInvestigation: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof haltQuery>
    sendSuccess(res, await getHaltInvestigation(p(req, 'orgId'), p(req, 'vehicleId'), q.since))
  } catch (err) { next(err) }
}

const routeAhead: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof routeQuery>
    if ((q.destLat == null) !== (q.destLng == null)) throw new BadRequestError('destLat and destLng go together')
    const custom = q.destLat != null && q.destLng != null
      ? { lat: q.destLat, lng: q.destLng, name: q.destName ?? null, source: 'custom' as const }
      : null
    sendSuccess(res, await getRouteAhead(p(req, 'orgId'), p(req, 'vehicleId'), custom))
  } catch (err) { next(err) }
}

const reach: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof reachQuery>
    sendSuccess(res, await getReach(p(req, 'orgId'), p(req, 'vehicleId'), q.minutes))
  } catch (err) { next(err) }
}

const router = Router({ mergeParams: true })
// Guards per route, not router.use: this router is mounted at the org root, so
// a router-wide guard would run on every request passing through to the next.
const guard = [authenticate, requireOrgAccess, requirePermission('vehicle:read'), requireVehicleInScope]

// Whether the two below are switched on, so the dashboard can keep its
// straight-line ETA instead of promising a road route that will never come.
router.get('/routing/status', authenticate, requireOrgAccess, (_req, res) => {
  sendSuccess(res, { enabled: googleRoutingAvailable(), reachMinutes: REACH_MINUTES })
})

// The road from the unit's Wialon fix to where it is going, with a traffic ETA.
router.get('/vehicles/:vehicleId/route-ahead', ...guard, validateQuery(routeQuery), routeAhead)
// A halted unit: where it stopped, its route since an hour before, its stops
// and the 5/10/15-minute drive zones from where it stands (fuel-investigation).
router.get('/vehicles/:vehicleId/halt-investigation', ...guard, validateQuery(haltQuery), haltInvestigation)
// How far it can drive in 15 / 30 / 60 minutes from where it is.
router.get('/vehicles/:vehicleId/reach', ...guard, validateQuery(reachQuery), reach)

export default router
