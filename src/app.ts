import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import { env } from './config/env.js'
import { logger } from './lib/logger.js'
import { globalLimiter } from './middleware/rateLimiter.js'
import { errorHandler } from './middleware/errorHandler.js'
import { requirePermission } from './middleware/authorize.js'
import { resolveSubject, canReachOrg } from './lib/authz/subject.js'
import { sendError, sendSuccess } from './core/response/response.js'

import authRoutes from './modules/auth/auth.routes.js'
import accountRoutes from './modules/account/account.routes.js'
import orgRoutes from './modules/organisations/organisation.routes.js'
import userRoutes from './modules/users/user.routes.js'
import roleRoutes from './modules/roles/role.routes.js'
import vehicleRoutes from './modules/vehicles/vehicle.routes.js'
import { lookup as vehicleLookup } from './modules/vehicles/vehicle-lookup.js'
import tripRoutes from './modules/trips/trip.routes.js'
import fuelRoutes from './modules/fuel/fuel.routes.js'
import reportRoutes from './modules/reports/report.routes.js'
import ingestRoutes from './modules/ingest/ingest.routes.js'
import webhookRoutes from './modules/webhooks/webhooks.routes.js'
import telemetryRoutes from './modules/telemetry/telemetry.routes.js'
import usageReviewRoutes from './modules/usage-review/usage-review.routes.js'
import routeRoutes from './modules/routes/route.routes.js'
import geofenceRoutes from './modules/geofences/geofence.routes.js'
import cargoRoutes from './modules/cargo/cargo.routes.js'
import dispatchRoutes from './modules/dispatches/dispatch.routes.js'
import weighmentRoutes from './modules/weighments/weighment.routes.js'
import apiKeyRoutes from './modules/api-keys/api-key.routes.js'
import analyticsRoutes from './modules/analytics/analytics.routes.js'
import incidentsRoutes     from './modules/incidents/incidents.routes.js'
import repairRoutes       from './modules/repairs/repairs.routes.js'
import dashboardRoutes from './modules/dashboard/dashboard.routes.js'
import * as dashboard from './modules/dashboard/dashboard.service.js'
import { notificationsOrgRouter } from './modules/notifications/notifications.router.js'
import * as notificationsCtrl from './modules/notifications/notifications.controller.js'
import { authenticate, requireOrgAccess } from './middleware/auth.js'
import { simNow, SIM_SCALE } from './providers/raifactorysuite/raifactorysuite.simulator.js'
import { getRoadPathAsync } from './lib/road-routes.js'
import { reverseGeocode } from './lib/geocode.js'
import { prisma } from './lib/prisma.js'
import * as roleCtrl from './modules/roles/role.controller.js'
import { listQuerySchema } from './modules/roles/role.schema.js'
import { validateQuery, validateBody } from './middleware/validate.js'
import * as userCtrl from './modules/users/user.controller.js'
import { provisionUserSchema } from './modules/users/user.schema.js'
import { trustProxy, parseProxyList } from './lib/trust-proxy.js'
import * as alertsCtrl from './modules/alerts/alerts.controller.js'
import { listAlertsQuery } from './modules/alerts/alerts.schema.js'

export function createApp() {
  const app = express()

  // Say out loud, on every boot, when the doors are open. Both of these are
  // transitional states of the authorisation rollout, and the failure mode for
  // each is silence: nothing misbehaves, requests simply are not being judged.
  if (env.AUTH_BYPASS) {
    logger.warn('AUTH_BYPASS=true — every request is authenticated as a fixed account, with no token')
  }
  if (!env.AUTHZ_ENFORCE) {
    logger.warn('AUTHZ_ENFORCE=false — permission checks run and log, but nothing is denied')
  }

  // BigInt values (VehicleTelemetry.id) are not JSON-serializable by default
  // nginx, plus the LiteSpeed proxy in front of it on one of the two domains —
  // see lib/trust-proxy for why one hop was not enough.
  app.set("trust proxy", trustProxy(parseProxyList(env.TRUSTED_PROXY_IPS)));
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  )

  app.use(helmet())
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
  app.use(compression())
  // The auth tokens are httpOnly cookies (see modules/auth/auth.cookies).
  app.use(cookieParser())
  // Keep the raw bytes alongside the parsed body: webhook HMAC signatures are
  // computed over exactly what was sent, and re-serialising the parsed object
  // would change key order/whitespace and invalidate the signature.
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf },
  }))
  app.use(express.urlencoded({ extended: true }))

  app.use(globalLimiter)

  app.get('/health', (_req, res) => {
    res.json({ statusCode: 200, status: 'success', data: { uptime: process.uptime(), timestamp: new Date() } })
  })


  const v1 = '/api/v1'

  // Simulation clock — lets the dashboard extrapolate sim time client-side
  // without polling on every tick. Returns the current sim timestamp and the
  // real-world sample time so the client can advance locally at `scale`×.
  // No auth: this is display-only metadata, not user or org data.
  app.get(`${v1}/sim-clock`, (_req, res) => {
    sendSuccess(res, { simMs: simNow(), realMs: Date.now(), scale: SIM_SCALE })
  })

  // Road polyline between two points — powers the map's dashed A→B route
  // line so it hugs the actual roads the vehicle drives (same cache the
  // simulator moves vehicles along; see lib/road-routes). No auth: public
  // OpenStreetMap-derived geometry, no org or user data.
  app.get(`${v1}/road-path`, async (req, res) => {
    const num = (k: string) => Number(req.query[k])
    const [aLat, aLng, bLat, bLng] = [num('fromLat'), num('fromLng'), num('toLat'), num('toLng')]
    if ([aLat, aLng, bLat, bLng].some(Number.isNaN)) return sendError(res, 400, 'fromLat/fromLng/toLat/toLng required')
    const path = await getRoadPathAsync(aLat, aLng, bLat, bLng)
    sendSuccess(res, { coords: path?.coords ?? null, totalKm: path?.totalKm ?? null })
  })

  // Nearest named place for a coordinate — powers the dashboard's human
  // location labels (e.g. the driver card's 📍 line). No auth: public
  // OpenStreetMap-derived data, no org or user data. Cached server-side per
  // ~1.1 km grid cell — see lib/geocode.
  app.get(`${v1}/reverse-geocode`, async (req, res) => {
    const lat = Number(req.query.lat)
    const lng = Number(req.query.lng)
    if (Number.isNaN(lat) || Number.isNaN(lng)) return sendError(res, 400, 'lat/lng required')
    const place = await reverseGeocode(lat, lng)
    sendSuccess(res, { place })
  })

  // The platform's live pulse — total units and how many are moving, for the
  // sign-in screen, which renders before there is a session and so can only
  // read something public.
  //
  // NO AUTH, and the shape is the justification: two integers, a percentage and
  // a timestamp. No organisation, no vehicle, no position, nothing attributable
  // to a customer. It sits beside sim-clock, road-path and reverse-geocode,
  // which are public for the same reason — and deliberately NOT beside
  // /bootstrap, which was open once, returned every tenant's id and code, and
  // is authenticated now. This must never grow a breakdown.
  //
  // The service caches it for 30s and collapses concurrent recomputes into one,
  // so polling this cannot reach the database more than twice a minute however
  // hard anybody tries.
  app.get(`${v1}/fleet-pulse`, async (_req, res) => {
    try {
      sendSuccess(res, await dashboard.getFleetPulse())
    } catch {
      // A number nobody can see is not worth a 500 on the sign-in path — the
      // client already treats an absent pulse as "show the static card".
      sendError(res, 503, 'Fleet pulse unavailable')
    }
  })

  // Bootstrap — returns the full organisation roster (for the dashboard's
  // org switcher) plus a default selection, in auth-bypass mode. Ordered by
  // creation so the first-seeded org (Sukari) stays the default.
  // The roster effectively never changes at runtime, and every client blocks
  // its first data fetch on this call — cache it in memory (60s TTL) so it
  // doesn't pay a remote-DB round trip per request.
  //
  // NOW AUTHENTICATED, and filtered to what the caller may reach. It used to be
  // open, and returned every tenant's id, name and code to anyone who asked —
  // which is also how a client learned the :orgId it then used to read that
  // tenant's data. The roster cache stays shared (it is the same rows for
  // everyone); the FILTER is per request.
  let bootstrapCache: { orgs: { id: string; name: string; code: string }[]; fetchedAt: number } | null = null
  app.get(`${v1}/bootstrap`, authenticate, async (req, res) => {
    try {
      if (!bootstrapCache || Date.now() - bootstrapCache.fetchedAt >= 60_000) {
        bootstrapCache = {
          orgs: await prisma.organisation.findMany({
            select:  { id: true, name: true, code: true },
            orderBy: { createdAt: 'asc' },
          }),
          fetchedAt: Date.now(),
        }
      }

      let orgs = bootstrapCache.orgs
      const userId = req.user?.id
      if (userId) {
        const subject = await resolveSubject(userId)
        const mine = orgs.filter((o) => canReachOrg(subject, o.id))
        // Shadow mode returns the full roster and says so, because narrowing it
        // is what would blank the dashboard's org switcher — the most visible
        // possible failure, and one worth seeing in a log first.
        if (mine.length !== orgs.length && !env.AUTHZ_ENFORCE) {
          logger.warn(
            { userId, visible: mine.length, total: orgs.length },
            'authz: WOULD NARROW bootstrap roster (shadow mode) — returning all',
          )
        } else {
          orgs = mine
        }
      }

      const first = orgs[0]
      if (!first) return sendError(res, 503, 'No organisation configured')
      sendSuccess(res, { orgId: first.id, orgName: first.name, orgs })
    } catch { sendError(res, 500, 'Bootstrap failed') }
  })

  app.use(`${v1}/auth`, authRoutes)
  // Self-service: change your own name or password, and the public
  // forgot-password / set-password pair. NOT under /auth — see the note in
  // account.routes.ts about the dashboard's refresh-and-replay.
  app.use(`${v1}/account`, accountRoutes)
  app.use(`${v1}/organisations`, orgRoutes)
  app.get(`${v1}/permissions`, authenticate, validateQuery(listQuerySchema), roleCtrl.listPermissions)

  // Platform user provisioning — one person, several organisations, a different
  // role in each. No :orgId, so requirePermission admits only a platform role:
  // an org admin creating users goes through
  // POST /organisations/:orgId/users/provision, which is pinned to that tenant.
  app.post(
    `${v1}/users`,
    authenticate,
    requirePermission('user:create'),
    validateBody(provisionUserSchema),
    userCtrl.provisionAcrossOrgs,
  )

  // Cross-organisation unit lookup. NOT under :orgId, deliberately: it exists
  // precisely for the case where the operator is in the wrong organisation and
  // does not know it yet. It spans the caller's memberships and returns
  // identity only — see vehicle-lookup.ts.
  app.get(`${v1}/vehicle-lookup`, authenticate, vehicleLookup)

  // The Alerts page: fuel and overspeeding alerts across every organisation
  // the caller holds. Not under :orgId for the same reason as the lookup; it
  // authorises per organisation itself (alerts.scope). Deciding an alert is
  // still an org-scoped route.
  app.get(`${v1}/alerts`, authenticate, validateQuery(listAlertsQuery), alertsCtrl.list)

  // Web Push public key — no auth; called by Service Workers before subscribe
  app.get(`${v1}/notifications/vapid-key`, notificationsCtrl.getVapidKey)

  const orgBase = `${v1}/organisations/:orgId`

  app.use(`${v1}/ingest`, ingestRoutes)

  // Provider callbacks (RaiFactorySuite alerts) — push replaces polling.
  // Deliberately mounted at the ROOT, not under /api/v1: the URL registered
  // with RaiFactorySuite is http://<host>/webhook/rai (nginx proxies /webhook/ to
  // this process). Authenticated by HMAC signature or shared secret; see
  // middleware/webhookAuth.
  app.use('/webhook', webhookRoutes)

  app.use(`${orgBase}/users`, userRoutes)
  app.use(`${orgBase}/roles`, roleRoutes)
  // Telemetry MUST mount before vehicleRoutes: its literal `/vehicles/snapshot`
  // and `/vehicles/:vehicleId/telemetry` paths would otherwise be shadowed by
  // vehicleRoutes' `/vehicles/:vehicleId`, 404-ing the fleet snapshot the map
  // depends on. Non-matching paths fall through to vehicleRoutes as before.
  app.use(orgBase, telemetryRoutes)
  app.use(orgBase, usageReviewRoutes)
  app.use(orgBase, vehicleRoutes)
  app.use(`${orgBase}/trips`, tripRoutes)
  app.use(`${orgBase}/trips`, cargoRoutes)
  app.use(`${orgBase}/fuel`, fuelRoutes)
  app.use(orgBase, reportRoutes)
  app.use(`${orgBase}/routes`, routeRoutes)
  app.use(`${orgBase}/geofences`, geofenceRoutes)
  app.use(`${orgBase}/dispatches`, dispatchRoutes)
  app.use(`${orgBase}/weighments`, weighmentRoutes)
  app.use(`${orgBase}/api-keys`, apiKeyRoutes)
  app.use(`${orgBase}/analytics`, analyticsRoutes)
  app.use(`${orgBase}/incidents`, incidentsRoutes)
  app.use(`${orgBase}/repairs`, repairRoutes)
  app.use(`${orgBase}/dashboard`, dashboardRoutes)

  // Org-wide dashboard SSE stream + push subscription management
  app.get(`${orgBase}/live`, authenticate, requireOrgAccess, requirePermission('notification:read'), notificationsCtrl.dashboardStream)
  app.use(`${orgBase}/notifications`, notificationsOrgRouter)

  app.use((_req, res) => {
    sendError(res, 404, 'Route not found')
  })
  app.use(errorHandler)

  return app
}
