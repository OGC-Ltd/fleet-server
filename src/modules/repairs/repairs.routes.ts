/**
 * Repair reports — what a technician did to the faulty units they were sent to.
 *
 * TWO OF THESE FIVE ROUTES ARE STRICT, WHICH IS DELIBERATE AND NOT AN
 * OVERSIGHT. `requirePermission` is in shadow mode until AUTHZ_ENFORCE is
 * true: it logs the denial and calls next(). That is tolerable for a read,
 * which leaks a figure to somebody already inside the tenant. It is not
 * tolerable for these two writes, which create a durable record attributed to
 * a named person AND mail external handlers. A dispatcher who wandered into
 * the tab and clicked "Cannot be fixed" across forty units would mail forty
 * items to management under their own name and lock forty open-job rows.
 *
 * Strict costs nothing on a brand-new route: there is no existing holder whose
 * access it could break, which is the entire reason shadow mode exists in the
 * first place. The reads stay non-strict so this module does not become the
 * one place in the codebase that enforces reads differently from its
 * neighbours; they come in with everybody else's when the flag flips.
 */

import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requirePermissionStrict } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import {
  createRepairReportSchema, resolveItemSchema,
  listReportsQuerySchema, listItemsQuerySchema,
} from './repairs.schema.js'
import * as ctrl from './repairs.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', requirePermission('repair:read'), validateQuery(listReportsQuerySchema), ctrl.listReports)
router.get('/items', requirePermission('repair:read'), validateQuery(listItemsQuerySchema), ctrl.listItems)
router.post('/', requirePermissionStrict('repair:create'), validateBody(createRepairReportSchema), ctrl.createReport)
router.post('/items/:itemId/resolve', requirePermissionStrict('repair:resolve'), validateBody(resolveItemSchema), ctrl.resolveItem)
// Last: `/items` would otherwise be swallowed by `/:reportId`.
router.get('/:reportId', requirePermission('repair:read'), ctrl.getReport)

export default router
