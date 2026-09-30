/**
 * Repair reports — what a technician did to the faulty units they were sent to.
 *
 * THREE OF THESE SIX ROUTES ARE STRICT, WHICH IS DELIBERATE AND NOT AN
 * OVERSIGHT. `requirePermission` is in shadow mode until AUTHZ_ENFORCE is
 * true: it logs the denial and calls next(). That is tolerable for a read,
 * which leaks a figure to somebody already inside the tenant. It is not
 * tolerable for these three writes, which create a durable record attributed to
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
  assignRepairItemSchema, createRepairReportSchema, resolveItemSchema, setStageSchema,
  respondToAssignmentSchema,
  listReportsQuerySchema, listItemsQuerySchema,
  setInspectionSchema, addSparePartSchema, updateSparePartSchema,
} from './repairs.schema.js'
import * as ctrl from './repairs.controller.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

router.get('/', requirePermission('repair:read'), validateQuery(listReportsQuerySchema), ctrl.listReports)
router.get('/items', requirePermission('repair:read'), validateQuery(listItemsQuerySchema), ctrl.listItems)
/* Before the `/:reportId` catch-all at the foot of this file, like `/items`.
   `repair:assign` rather than `repair:read`: this is the assign control's
   backing list, and it is NOT group-scoped -- an assignee must share the
   ORGANISATION, not the group (see repairs.repository.findAssignees). */
router.get('/assignees', requirePermission('repair:assign'), ctrl.listAssignees)
router.post('/', requirePermissionStrict('repair:create'), validateBody(createRepairReportSchema), ctrl.createReport)
router.post('/items/:itemId/assign', requirePermissionStrict('repair:assign'), validateBody(assignRepairItemSchema), ctrl.assignItem)
router.post('/items/:itemId/assignment-response', requirePermissionStrict('repair:read'), validateBody(respondToAssignmentSchema), ctrl.respondToAssignment)
router.post('/items/:itemId/resolve', requirePermissionStrict('repair:resolve'), validateBody(resolveItemSchema), ctrl.resolveItem)
// Strict for the same reason resolve is, and it is the weaker claim of the two
// — but it writes a line onto a durable trail under a named person, and the
// stage is what the people ordering spares read to decide whether to order.
router.post('/items/:itemId/stage', requirePermissionStrict('repair:resolve'), validateBody(setStageSchema), ctrl.setStage)
// The overhaul audit: the checklist and the spares ordered for the fix (repairs.overhaul).
// Whoever may work a job may record its overhaul, so the same slug as a stage move.
router.get('/items/:itemId/overhaul', requirePermissionStrict('repair:read'), ctrl.getOverhaul)
router.post('/items/:itemId/inspections', requirePermissionStrict('repair:resolve'), validateBody(setInspectionSchema), ctrl.setInspection)
router.post('/items/:itemId/parts', requirePermissionStrict('repair:resolve'), validateBody(addSparePartSchema), ctrl.addSparePart)
router.post('/items/:itemId/parts/:partId', requirePermissionStrict('repair:resolve'), validateBody(updateSparePartSchema), ctrl.updateSparePart)
// Last: `/items` would otherwise be swallowed by `/:reportId`.
router.get('/:reportId', requirePermission('repair:read'), ctrl.getReport)

export default router
