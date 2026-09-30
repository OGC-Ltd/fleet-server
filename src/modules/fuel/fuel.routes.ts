import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requirePermissionStrict, requireVehicleInScope } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import {
  createFillingSchema, listFillingQuerySchema, createTheftSchema, listTheftQuerySchema,
  listFollowUpQuerySchema, followUpNoteSchema, assignFollowUpSchema, recallFollowUpSchema, theftOutcomesQuerySchema,
  reviewTheftSchema, signalAlertQuerySchema, evaluateSignalsSchema, escalateFollowUpSchema,
} from './fuel.schema.js'
import * as ctrl from './fuel.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/fillings', requirePermission('fuel_filling:read'), validateQuery(listFillingQuerySchema), ctrl.listFillings)
router.get('/fillings/:fillingId', requirePermission('fuel_filling:read'), ctrl.getFilling)
router.post('/fillings', requirePermission('fuel_filling:create'), ingestLimiter, validateBody(createFillingSchema), ctrl.createFilling)

// Whole-fleet, no pagination: the FSL table draws every vehicle at once.
router.get('/tank-state', requirePermission('fuel_filling:read'), ctrl.listTankState)

// Whole-fleet probe and sensor health. Unpaginated for the same reason as
// tank-state, and cached in the service — see probe-report.service.
router.get('/probe-health', requirePermission('sensor:read'), ctrl.listProbeHealth)

router.get('/thefts', requirePermission('fuel_theft:read'), validateQuery(listTheftQuerySchema), ctrl.listThefts)
// What reviewers concluded about the fleet's fuel alerts, for analytics. Before
// /thefts/:theftId so "outcomes" is not read as an id.
router.get('/thefts/outcomes', requirePermission('fuel_theft:read'), validateQuery(theftOutcomesQuerySchema), ctrl.theftOutcomes)
// Before /thefts/:theftId, like "outcomes". Read-only: tells the incident window
// whether to draw Escalate / De-escalate for this viewer.
router.get('/thefts/review-rights', requirePermission('fuel_theft:read'), ctrl.theftReviewRights)
router.get('/thefts/:theftId', requirePermission('fuel_theft:read'), ctrl.getTheft)
router.post('/thefts', requirePermission('fuel_theft:create'), ingestLimiter, validateBody(createTheftSchema), ctrl.createTheft)
// ARCHIVED 2026-10-01: "Delete" on the incident window is retired; an alert
// leaves the dashboard only by escalation or de-escalation (/review below).
// Kept mounted so an old dashboard gets 410 Gone and the reason, never a
// silent 404. See ctrl.dismissTheft.
router.post('/thefts/:theftId/dismiss', requirePermission('fuel_theft:create'), ctrl.dismissTheft)
// Escalate / de-escalate a live alert from its window. The triage slug keeps
// out everyone who may not hold a case; the service narrows it to the
// administrators, as it does for assigning one. Strict, being a new route.
router.post('/thefts/:theftId/review', requirePermissionStrict('fuel_theft:triage'),
  validateBody(reviewTheftSchema), ctrl.reviewTheft)

// The follow-up every dismissal opens — see fuel-followup.service. The case
// holders are the roles granted `fuel_theft:triage` (the operator named them;
// see lib/permissions). Who among them may act on a given case — not the
// deleter, and after acceptance only the account that accepted — is the
// service's rule, not a slug. Strict, being new routes: see
// requirePermissionStrict on why shadow mode is wrong for those.
const triage = requirePermissionStrict('fuel_theft:triage')
router.get('/followups', triage, validateQuery(listFollowUpQuerySchema), ctrl.listFollowUps)
router.get('/followups/:followUpId', triage, ctrl.getFollowUp)
router.post('/followups/:followUpId/accept', triage, ctrl.acceptFollowUp)
router.post('/followups/:followUpId/decline', triage, validateBody(followUpNoteSchema), ctrl.declineFollowUp)
// Assigning is narrower than the slug: only the organisation's administrator
// or the platform administrator, which the service checks by role (the
// repairs rule, see repairs.authz). The slug keeps everybody else out first.
router.get('/followups/:followUpId/assignees', triage, ctrl.listFollowUpAssignees)
router.post('/followups/:followUpId/assign', triage, validateBody(assignFollowUpSchema), ctrl.assignFollowUp)
router.post('/followups/:followUpId/recall', triage, validateBody(recallFollowUpSchema), ctrl.recallFollowUp)
router.post('/followups/:followUpId/notes', triage, validateBody(followUpNoteSchema), ctrl.noteFollowUp)
router.post('/followups/:followUpId/escalate', triage, validateBody(escalateFollowUpSchema), ctrl.escalateFollowUp)
router.post('/followups/:followUpId/deescalate', triage, validateBody(followUpNoteSchema), ctrl.deescalateFollowUp)
// Fuel Audit: the owner decides the case was a faulty fuel probe, which raises
// a probe job in Repairs; a case whose job failed can have a new one raised.
router.post('/followups/:followUpId/probe-fault', triage, validateBody(followUpNoteSchema), ctrl.probeFaultFollowUp)
router.post('/followups/:followUpId/repair', triage, validateBody(followUpNoteSchema), ctrl.reraiseFollowUpRepair)
router.get('/audit', triage, ctrl.listFuelAudit)

// Signal alerts: the filter-and-residual detector (fuel-signal-alerts) run on
// demand. Read-only — nothing here writes to the theft ledger or the feed.
// Strict, being new routes.
const fuelRead = requirePermissionStrict('fuel_theft:read')
router.get('/signal-alerts/vehicles/:vehicleId', fuelRead, requireVehicleInScope,
  validateQuery(signalAlertQuerySchema), ctrl.scanVehicleSignals)
router.post('/signal-alerts/vehicles/:vehicleId/evaluate', fuelRead, requireVehicleInScope,
  validateBody(evaluateSignalsSchema), ctrl.evaluateSignals)
router.post('/signal-alerts/evaluate', fuelRead, validateBody(evaluateSignalsSchema), ctrl.evaluateSignals)

export default router
