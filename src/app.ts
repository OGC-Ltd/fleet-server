import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import { env } from './config/env.js'
import { globalLimiter } from './middleware/rateLimiter.js'
import { errorHandler } from './middleware/errorHandler.js'
import { sendError, sendSuccess } from './core/response/response.js'

import authRoutes from './modules/auth/auth.routes.js'
import orgRoutes from './modules/organisations/organisation.routes.js'
import userRoutes from './modules/users/user.routes.js'
import roleRoutes from './modules/roles/role.routes.js'
import vehicleRoutes from './modules/vehicles/vehicle.routes.js'
import tripRoutes from './modules/trips/trip.routes.js'
import fuelRoutes from './modules/fuel/fuel.routes.js'
import reportRoutes from './modules/reports/report.routes.js'
import ingestRoutes from './modules/ingest/ingest.routes.js'
import telemetryRoutes from './modules/telemetry/telemetry.routes.js'
import routeRoutes from './modules/routes/route.routes.js'
import geofenceRoutes from './modules/geofences/geofence.routes.js'
import cargoRoutes from './modules/cargo/cargo.routes.js'
import apiKeyRoutes from './modules/api-keys/api-key.routes.js'
import analyticsRoutes from './modules/analytics/analytics.routes.js'
import dashboardRoutes from './modules/dashboard/dashboard.routes.js'
import { notificationsOrgRouter } from './modules/notifications/notifications.router.js'
import * as notificationsCtrl from './modules/notifications/notifications.controller.js'
import { authenticate, requireOrgAccess } from './middleware/auth.js'
import { simNow, SIM_SCALE } from './providers/controltech/controltech.simulator.js'
import { prisma } from './lib/prisma.js'
import * as roleCtrl from './modules/roles/role.controller.js'
import { listQuerySchema } from './modules/roles/role.schema.js'
import { validateQuery } from './middleware/validate.js'

export function createApp() {
  const app = express()

  // BigInt values (VehicleTelemetry.id) are not JSON-serializable by default
  app.set("trust proxy", 1);
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  )

  app.use(helmet())
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
  app.use(compression())
  app.use(express.json({ limit: '1mb' }))
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

  // Bootstrap — returns the full organisation roster (for the dashboard's
  // org switcher) plus a default selection, in auth-bypass mode. Ordered by
  // creation so the first-seeded org (Sukari) stays the default.
  // The roster effectively never changes at runtime, and every client blocks
  // its first data fetch on this call — cache it in memory (60s TTL) so it
  // doesn't pay a remote-DB round trip per request.
  let bootstrapCache: { data: unknown; fetchedAt: number } | null = null
  app.get(`${v1}/bootstrap`, async (_req, res) => {
    try {
      if (bootstrapCache && Date.now() - bootstrapCache.fetchedAt < 60_000) {
        return sendSuccess(res, bootstrapCache.data)
      }
      const orgs = await prisma.organisation.findMany({
        select:  { id: true, name: true, code: true },
        orderBy: { createdAt: 'asc' },
      })
      const first = orgs[0]
      if (!first) return sendError(res, 503, 'No organisation configured')
      const data = { orgId: first.id, orgName: first.name, orgs }
      bootstrapCache = { data, fetchedAt: Date.now() }
      sendSuccess(res, data)
    } catch { sendError(res, 500, 'Bootstrap failed') }
  })

  app.use(`${v1}/auth`, authRoutes)
  app.use(`${v1}/organisations`, orgRoutes)
  app.get(`${v1}/permissions`, authenticate, validateQuery(listQuerySchema), roleCtrl.listPermissions)

  // Web Push public key — no auth; called by Service Workers before subscribe
  app.get(`${v1}/notifications/vapid-key`, notificationsCtrl.getVapidKey)

  const orgBase = `${v1}/organisations/:orgId`

  app.use(`${v1}/ingest`, ingestRoutes)

  app.use(`${orgBase}/users`, userRoutes)
  app.use(`${orgBase}/roles`, roleRoutes)
  // Telemetry MUST mount before vehicleRoutes: its literal `/vehicles/snapshot`
  // and `/vehicles/:vehicleId/telemetry` paths would otherwise be shadowed by
  // vehicleRoutes' `/vehicles/:vehicleId`, 404-ing the fleet snapshot the map
  // depends on. Non-matching paths fall through to vehicleRoutes as before.
  app.use(orgBase, telemetryRoutes)
  app.use(orgBase, vehicleRoutes)
  app.use(`${orgBase}/trips`, tripRoutes)
  app.use(`${orgBase}/trips`, cargoRoutes)
  app.use(`${orgBase}/fuel`, fuelRoutes)
  app.use(orgBase, reportRoutes)
  app.use(`${orgBase}/routes`, routeRoutes)
  app.use(`${orgBase}/geofences`, geofenceRoutes)
  app.use(`${orgBase}/api-keys`, apiKeyRoutes)
  app.use(`${orgBase}/analytics`, analyticsRoutes)
  app.use(`${orgBase}/dashboard`, dashboardRoutes)

  // Org-wide dashboard SSE stream + push subscription management
  app.get(`${orgBase}/live`, authenticate, requireOrgAccess, notificationsCtrl.dashboardStream)
  app.use(`${orgBase}/notifications`, notificationsOrgRouter)

  app.use((_req, res) => {
    sendError(res, 404, 'Route not found')
  })
  app.use(errorHandler)

  return app
}
