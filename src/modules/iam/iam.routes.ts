/**
 * /api/v1/iam — the System Administrator's page for access rights.
 *
 * No :orgId anywhere, so these are platform surface, and the permission asked
 * for is the wildcard itself: `platform:admin` is held by the System
 * Administrator role and by nothing else (it cannot be granted to a person,
 * iam.service), so a Director or an organisation's Admin is refused.
 *
 * Strict, so the refusal holds while AUTHZ_ENFORCE is still off. Reads too:
 * this is the list of who may do what across every organisation.
 */

import { Router } from 'express'
import { authenticate } from '../../middleware/auth.js'
import { requirePermissionStrict } from '../../middleware/authorize.js'
import { requireRealAuth } from '../../middleware/requireRealAuth.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { WILDCARD } from '../../lib/permissions.js'
import * as ctrl from './iam.controller.js'
import { driversCheck } from './factorysuite-drivers-check.js'
import { deactivatedUnits } from './wialon-deactivated.js'
import { listUsersQuerySchema, setFleetSchema, setGrantsSchema } from './iam.schema.js'

const router = Router()

router.use(authenticate)
router.use(requirePermissionStrict(WILDCARD))

router.get('/catalogue', ctrl.catalogue)
router.get('/users', validateQuery(listUsersQuerySchema), ctrl.listUsers)
router.get('/users/:userId', ctrl.userAccess)
router.put('/users/:userId/grants', requireRealAuth, validateBody(setGrantsSchema), ctrl.setGrants)
// The whole fleet, or only some of its categories, in one organisation.
router.put('/users/:userId/fleet', requireRealAuth, validateBody(setFleetSchema), ctrl.setFleet)

// FactorySuite's driver register for one factory, as counts and field names
// only (factorysuite-drivers-check): read-only, nothing stored.
router.get('/factorysuite/drivers-check', driversCheck)

// The units Wialon has deactivated, and those already gone from it, per
// organisation (wialon-deactivated): read-only, nothing stored or hidden.
router.get('/wialon/deactivated-units', deactivatedUnits)

export default router
