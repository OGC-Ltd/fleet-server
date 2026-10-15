import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requireVehicleInScope } from '../../middleware/authorize.js'
import { validateQuery } from '../../middleware/validate.js'
import { sendSuccess } from '../../core/response/response.js'
import { BadRequestError } from '../../core/errors/errors.js'
import { getRouteAhead, getReach, REACH_MINUTES } from './route-ahead.service.js'
import { googleRoutingAvailable } from '../../providers/google-routing/index.js'
import { getHaltInvestigation, getTripInvestigation } from '../fuel/fuel-investigation.js'
import { getHubs, getInbound, getInboundAt, ARRIVAL_MINUTES } from './hub-arrivals.js'

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

const tripQuery = z.object({
  // 1 = also match the route to roads (billed per hundred fixes, so asked for).
  snap: z.enum(['0', '1']).optional().default('0').transform((s) => s === '1'),
})

const inboundQuery = z.object({
  // Reverse isochrones: Google caps a drive at 60 minutes.
  minutes: z.string().optional().default(ARRIVAL_MINUTES.join(','))
    .transform((s) => [...new Set(s.split(',').map(Number))])
    .refine((a) => a.length > 0 && a.length <= 3 && a.every((m) => Number.isInteger(m) && m >= 1 && m <= 60),
      'minutes: up to three whole numbers from 1 to 60'),
  // Whose drive times: one class at its measured speed, all at their own,
  // or Google's two-wheeler. `mode=TWO_WHEELER` is the old spelling of it.
  cls: z.enum(['all', 'VEHICLE', 'TRACTOR', 'TRUCK', 'CAR', 'MOTORBIKE']).optional(),
  mode: z.enum(['DRIVE', 'TWO_WHEELER']).optional(),
  available: z.enum(['0', '1']).optional().default('0').transform((s) => s === '1'),
}).transform((q) => ({ ...q, cls: q.cls ?? (q.mode === 'TWO_WHEELER' ? 'MOTORBIKE' as const : 'all' as const) }))

const pointQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  name: z.string().trim().max(80).optional(),
}).and(inboundQuery)

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

const hubs: RequestHandler = async (req, res, next) => {
  try { sendSuccess(res, { enabled: googleRoutingAvailable(), hubs: await getHubs(p(req, 'orgId')) }) } catch (err) { next(err) }
}

const inbound: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof inboundQuery>
    sendSuccess(res, await getInbound(p(req, 'orgId'), p(req, 'hubKey'), { minutes: q.minutes, cls: q.cls, available: q.available }))
  } catch (err) { next(err) }
}

const inboundAt: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof pointQuery>
    sendSuccess(res, await getInboundAt(p(req, 'orgId'), { lat: q.lat, lng: q.lng, name: q.name ?? null },
      { minutes: q.minutes, cls: q.cls, available: q.available }))
  } catch (err) { next(err) }
}

const tripInvestigation: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as z.infer<typeof tripQuery>
    sendSuccess(res, await getTripInvestigation(p(req, 'orgId'), p(req, 'vehicleId'), { snap: q.snap }))
  } catch (err) { next(err) }
}

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

// Arrivals at a hub: the organisation's hubs, then for one of them the
// reverse isochrones (where it can be reached from in 15/30/60 min, live
// traffic) and every unit's live drive time to it (hub-arrivals).
const fleetGuard = [authenticate, requireOrgAccess, requirePermission('vehicle:read')]
router.get('/routing/hubs', ...fleetGuard, hubs)
router.get('/routing/hubs/:hubKey/inbound', ...fleetGuard, validateQuery(inboundQuery), inbound)
// "Suggest a unit": the same for a spot picked on the map.
router.get('/routing/point/inbound', ...fleetGuard, validateQuery(pointQuery), inboundAt)

// The road from the unit's Wialon fix to where it is going, with a traffic ETA.
router.get('/vehicles/:vehicleId/route-ahead', ...guard, validateQuery(routeQuery), routeAhead)
// A halted unit: where it stopped, its route since an hour before, its stops
// and the 5/10/15-minute drive zones from where it stands (fuel-investigation).
router.get('/vehicles/:vehicleId/halt-investigation', ...guard, validateQuery(haltQuery), haltInvestigation)
// A unit's run from its factory: the yard it left, the dispatch's destination
// and Google's road between them, the route it drove, its stops, and the drive
// zones from where it is now (fuel-investigation getTripInvestigation).
router.get('/vehicles/:vehicleId/trip-investigation', ...guard, validateQuery(tripQuery), tripInvestigation)
// How far it can drive in 15 / 30 / 60 minutes from where it is.
router.get('/vehicles/:vehicleId/reach', ...guard, validateQuery(reachQuery), reach)

export default router
