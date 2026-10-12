/**
 * Incident reports — overspeeding episodes and sensor fault episodes.
 *
 * ## Permissions reuse existing slugs, deliberately
 *
 * A new slug means editing every role bundle in lib/permissions plus the seed,
 * and neither of these reports introduces a new KIND of access:
 *
 * - Speeding is driver-conduct analytics, and `/analytics/speeding` already
 *   guards the same data with `analytics:read`.
 * - Faults are sensor health, matching `/fuel/probe-health`. It matters that
 *   this is not `analytics:read`: the `technician` role holds `sensor:read`
 *   and not the other, and they are exactly the people who fix sensors. That
 *   role did not exist when this was written and the argument was hypothetical;
 *   it exists now, and the Malfunction tab is one of the two screens it opens.
 */

import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requirePermissionStrict } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { summaryQuerySchema, listQuerySchema, insightsQuerySchema } from './incidents.schema.js'
import * as ctrl from './incidents.controller.js'
import { reviewSpeedingSchema } from '../alerts/alerts.schema.js'
import { reviewSpeeding } from '../alerts/alerts.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/speeding/summary',  requirePermission('analytics:read'), validateQuery(summaryQuerySchema),  ctrl.speedingSummary)
router.get('/speeding/insights', requirePermission('analytics:read'), validateQuery(insightsQuerySchema), ctrl.speedingInsights)
router.get('/speeding',          requirePermission('analytics:read'), validateQuery(listQuerySchema),     ctrl.speedingList)
// Escalate / de-escalate one episode from the Alerts page. The slug keeps out
// anyone who cannot read speeding here; the service narrows it to the
// administrators, as for fuel alerts. Strict, being a new route.
router.post('/speeding/:incidentId/review', requirePermissionStrict('analytics:read'),
  validateBody(reviewSpeedingSchema), reviewSpeeding)

router.get('/faults/summary',    requirePermission('sensor:read'),    validateQuery(summaryQuerySchema),  ctrl.faultSummary)
router.get('/faults/insights',   requirePermission('sensor:read'),    validateQuery(insightsQuerySchema), ctrl.faultInsights)
router.get('/faults',            requirePermission('sensor:read'),    validateQuery(listQuerySchema),     ctrl.faultList)

export default router
