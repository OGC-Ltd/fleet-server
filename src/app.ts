import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import { env } from './config/env.js'
import { globalLimiter } from './middleware/rateLimiter.js'
import { errorHandler } from './middleware/errorHandler.js'
import { sendError } from './core/response/response.js'
import { authenticate } from './middleware/auth.js'

import authRoutes from './modules/auth/auth.routes.js'
import orgRoutes from './modules/organisations/organisation.routes.js'
import userRoutes from './modules/users/user.routes.js'
import roleRoutes from './modules/roles/role.routes.js'
import vehicleRoutes from './modules/vehicles/vehicle.routes.js'
import tripRoutes from './modules/trips/trip.routes.js'
import fuelRoutes from './modules/fuel/fuel.routes.js'
import reportRoutes from './modules/reports/report.routes.js'
import * as roleCtrl from './modules/roles/role.controller.js'
import { listQuerySchema } from './modules/roles/role.schema.js'
import { validateQuery } from './middleware/validate.js'

export function createApp() {
  const app = express()

  // ── Security & parsing ──────────────────────────────────────────────────────
  app.use(helmet())
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
  app.use(compression())
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ extended: true }))

  // ── Global rate limit ───────────────────────────────────────────────────────
  app.use(globalLimiter)

  // ── Health check (unauthenticated) ──────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ statusCode: 200, status: 'success', data: { uptime: process.uptime(), timestamp: new Date() } })
  })

  // ── API v1 ──────────────────────────────────────────────────────────────────
  const v1 = '/api/v1'

  app.use(`${v1}/auth`, authRoutes)
  app.use(`${v1}/organisations`, orgRoutes)

  // Global permission catalogue (authenticated, not org-scoped)
  app.get(`${v1}/permissions`, authenticate, validateQuery(listQuerySchema), roleCtrl.listPermissions)

  // Org-scoped sub-resources (all use :orgId param)
  const orgBase = `${v1}/organisations/:orgId`

  app.use(orgBase, userRoutes)
  app.use(orgBase, roleRoutes)
  app.use(orgBase, vehicleRoutes)
  app.use(`${orgBase}/trips`, tripRoutes)
  app.use(`${orgBase}/fuel`, fuelRoutes)
  app.use(orgBase, reportRoutes)

  // ── 404 handler ─────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    sendError(res, 404, 'Route not found')
  })

  // ── Global error handler (must be last) ─────────────────────────────────────
  app.use(errorHandler)

  return app
}
