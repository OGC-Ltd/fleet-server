import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
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
router.get('/periods', requirePermission('report:read'), validateQuery(listPeriodQuerySchema), ctrl.listPeriods)
router.post('/periods', requirePermission('report:create'), validateBody(createPeriodSchema), ctrl.createPeriod)
router.get('/periods/:periodId', requirePermission('report:read'), ctrl.getPeriod)

// Engine Hour Sessions
router.get('/engine-sessions', requirePermission('report:read'), validateQuery(listEngineSessionQuerySchema), ctrl.listEngineSessions)
router.post('/engine-sessions', requirePermission('report:create'), ingestLimiter, validateBody(createEngineSessionSchema), ctrl.createEngineSession)

// Vehicle Period Summaries (dashboards)
router.get('/summaries', requirePermission('report:read'), validateQuery(listSummaryQuerySchema), ctrl.listSummaries)
router.post('/summaries/refresh/:periodId', requirePermission('report:create'), ctrl.refreshSummaries)

// Branded PDF reports — the downloadable counterparts of the dashboard pages,
// drawn server-side.
//
// One endpoint, four audiences, so the permission is chosen from the request.
// `operations` is the restricted four-section summary (units off the premises,
// trips completed, refill per unit, sensor health) and is the ONLY report a
// logistics manager or dispatcher may take; the other three carry analytics
// and driver detail those roles are deliberately not given. An unknown kind
// falls through to report:export rather than to something permissive - the
// controller rejects it, and a typo must not become a way past the guard.
const PDF_PERMISSION: Record<string, string> = {
  operations:  'report:operations',
  analytics:   'report:export',
  drivers:     'driver:export',
  maintenance: 'report:export',
  plant:       'report:export',
}
router.get(
  '/reports/pdf/:kind',
  requirePermission((req) => PDF_PERMISSION[String(req.params['kind'])] ?? 'report:export'),
  ctrl.downloadPdfReport,
)

export default router
