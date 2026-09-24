import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requirePermissionStrict } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import {
  createFillingSchema, listFillingQuerySchema, createTheftSchema, listTheftQuerySchema,
  listFollowUpQuerySchema, followUpNoteSchema, theftOutcomesQuerySchema,
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
router.get('/thefts/:theftId', requirePermission('fuel_theft:read'), ctrl.getTheft)
router.post('/thefts', requirePermission('fuel_theft:create'), ingestLimiter, validateBody(createTheftSchema), ctrl.createTheft)
// "Delete" on the dashboard's incident window. Hides the incident for the whole
// organisation and keeps the row; see FuelTheft.dismissedAt. Gated on the same
// grant as raising a case: whoever may open a fuel case may close one, and the
// read-only security role can do neither.
router.post('/thefts/:theftId/dismiss', requirePermission('fuel_theft:create'), ctrl.dismissTheft)

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
router.post('/followups/:followUpId/notes', triage, validateBody(followUpNoteSchema), ctrl.noteFollowUp)
router.post('/followups/:followUpId/escalate', triage, validateBody(followUpNoteSchema), ctrl.escalateFollowUp)
router.post('/followups/:followUpId/deescalate', triage, validateBody(followUpNoteSchema), ctrl.deescalateFollowUp)

export default router
