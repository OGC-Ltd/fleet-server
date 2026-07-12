import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import {
  createPeriodSchema,
  createEngineSessionSchema,
  listPeriodQuerySchema,
  listEngineSessionQuerySchema,
  listSummaryQuerySchema,
} from './report.schema.js'
import * as ctrl from './report.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

// Reporting Periods
router.get('/periods', validateQuery(listPeriodQuerySchema), ctrl.listPeriods)
router.post('/periods', validateBody(createPeriodSchema), ctrl.createPeriod)
router.get('/periods/:periodId', ctrl.getPeriod)

// Engine Hour Sessions
router.get('/engine-sessions', validateQuery(listEngineSessionQuerySchema), ctrl.listEngineSessions)
router.post('/engine-sessions', ingestLimiter, validateBody(createEngineSessionSchema), ctrl.createEngineSession)

// Vehicle Period Summaries (dashboards)
router.get('/summaries', validateQuery(listSummaryQuerySchema), ctrl.listSummaries)
router.post('/summaries/refresh/:periodId', ctrl.refreshSummaries)

// Branded PDF reports (analytics | drivers | maintenance) — the downloadable
// counterparts of the three dashboard pages, drawn server-side.
router.get('/reports/pdf/:kind', ctrl.downloadPdfReport)

export default router
