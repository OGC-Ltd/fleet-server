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

import { Router, type RequestHandler } from 'express'
import { ConflictError, GoneError } from '../../core/errors/errors.js'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission, requirePermissionStrict } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import {
  assignRepairItemSchema, resolveItemSchema,
  respondToAssignmentSchema,
  listReportsQuerySchema, listItemsQuerySchema,
  setInspectionSchema, addSparePartSchema, updateSparePartSchema,
} from './repairs.schema.js'
import * as ctrl from './repairs.controller.js'
import * as wf from './repairs.workflow.controller.js'
import {
  flagUnitsSchema, spotFixSchema, pathSchema, assessmentSchema, bookingSchema, cancelBookingSchema,
  workshopAssignSchema, damageSchema, warrantyVoidSchema, warrantyClearSchema, workEntrySchema, workEditSchema,
  completeSchema, verifySchema, voidSchema, movePhaseSchema, sourcePartSchema, issuePartSchema,
  investigationUpdateSchema, availabilityQuerySchema, dayQuerySchema, workshopUpdateSchema,
} from './repairs.workflow.schema.js'
import { z } from 'zod'
import { requireWorkableJob } from './repairs.authz.js'
import { emitDashboardRepairChanged } from '../../lib/sse.js'
import { refreshFlaggedScopes } from '../../lib/authz/subject.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireOrgAccess)

/*
 * Every successful write here tells the organisation's open dashboards, so
 * Maintenance > Repairs and Fuel > Audit (the same jobs, two views) stay in
 * step for everyone, not only for the person who made the change. Hooked on
 * the response rather than in each handler, so a write added later cannot
 * forget it. Never throws into the request.
 */
router.use((req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode >= 300) return
      try {
        emitDashboardRepairChanged(req.params.orgId as string)
      } catch { /* a missed broadcast only means a later reload */ }
      // A unit flagged or resolved changes what a technician's map shows.
      void refreshFlaggedScopes(req.params.orgId as string)
    })
  }
  next()
})

router.get('/', requirePermission('repair:read'), validateQuery(listReportsQuerySchema), ctrl.listReports)
router.get('/items', requirePermission('repair:read'), validateQuery(listItemsQuerySchema), ctrl.listItems)
/* Before the `/:reportId` catch-all at the foot of this file, like `/items`.
   `repair:assign` rather than `repair:read`: this is the assign control's
   backing list, and it is NOT group-scoped -- an assignee must share the
   ORGANISATION, not the group (see repairs.repository.findAssignees). */
router.get('/assignees', requirePermission('repair:assign'), ctrl.listAssignees)
/* RETIRED 2026-10-21: every repair runs through the Workshop workflow. The
   outcome report and the stage buttons made jobs no ticket, damage check or
   verification would see; the routes answer with where to go instead. */
const retired = (err: () => Error): RequestHandler => (_req, _res, next) => next(err())
router.post('/', retired(() => new GoneError('Repairs are reported through Workshop now: Flag for repair, or Fixed on the spot')))
router.post('/items/:itemId/assign', requirePermissionStrict('repair:assign'), validateBody(assignRepairItemSchema), ctrl.assignItem)
router.post('/items/:itemId/assignment-response', requirePermissionStrict('repair:read'), validateBody(respondToAssignmentSchema), ctrl.respondToAssignment)
router.post('/items/:itemId/resolve', requirePermissionStrict('repair:resolve'), requireWorkableJob, validateBody(resolveItemSchema), ctrl.resolveItem)
// Strict for the same reason resolve is, and it is the weaker claim of the two
// — but it writes a line onto a durable trail under a named person, and the
// stage is what the people ordering spares read to decide whether to order.
router.post('/items/:itemId/stage', retired(() => new ConflictError('This job moves through its steps in Workshop now')))
// The overhaul audit: the checklist and the spares ordered for the fix (repairs.overhaul).
// Whoever may work a job may record its overhaul, so the same slug as a stage move.
router.get('/items/:itemId/overhaul', requirePermissionStrict('repair:read'), ctrl.getOverhaul)
router.post('/items/:itemId/inspections', requirePermissionStrict('repair:resolve'), requireWorkableJob, validateBody(setInspectionSchema), ctrl.setInspection)
router.post('/items/:itemId/parts', requirePermissionStrict('repair:resolve'), requireWorkableJob, validateBody(addSparePartSchema), ctrl.addSparePart)
router.post('/items/:itemId/parts/:partId', requirePermissionStrict('repair:resolve'), requireWorkableJob, validateBody(updateSparePartSchema), ctrl.updateSparePart)

/*
 * The Vehicle Support and Repair Workflow (repairs.workflow, plan §4). Every
 * write is strict for the reason the header gives. The ones that touch the
 * work itself (path, damage, warranty, work log, complete) also need a job the
 * caller may work; the Control Room's (flag, assess, book, arrive, verify) do
 * not, and apply the caller's vehicle scope in the service instead.
 */
router.get('/queue', requirePermissionStrict('repair:claim'), wf.queue)
router.get('/service-states', requirePermission('repair:read'), wf.serviceStates)
router.get('/workshops', requirePermission('repair:read'), wf.workshops)
router.get('/workshops/:workshopId/availability', requirePermission('repair:read'), validateQuery(availabilityQuerySchema), wf.availability)
router.get('/workshops/:workshopId/day', requirePermission('repair:read'), validateQuery(dayQuerySchema), wf.workshopDay)
router.post('/workshops/:workshopId', requirePermissionStrict('repair:assign'), validateBody(workshopUpdateSchema), wf.updateWorkshop)
// Security reads are strict: these are allegations against named drivers.
router.get('/security-investigations', requirePermissionStrict('security_case:read'), wf.investigations)
router.get('/security-investigations/holders', requirePermissionStrict('security_case:read'), wf.securityHolders)
router.post('/security-investigations/:investigationId', requirePermissionStrict('security_case:update'), validateBody(investigationUpdateSchema), wf.updateInvestigation)

router.get('/flaggable-units', requirePermissionStrict('repair:flag'), wf.flaggableUnits)
router.post('/flags', requirePermissionStrict('repair:flag'), validateBody(flagUnitsSchema), wf.flagUnits)
router.post('/spot-fixes', requirePermissionStrict('repair:resolve'), validateBody(spotFixSchema), wf.spotFix)
router.post('/items/:itemId/forward', requirePermissionStrict('repair:flag'), validateBody(z.object({ queue: z.enum(['controltech', 'workshop']).optional() })), wf.forward)
router.post('/items/:itemId/claim', requirePermissionStrict('repair:claim'), wf.claim)
router.post('/items/:itemId/path', requirePermissionStrict('repair:resolve'), requireWorkableJob, validateBody(pathSchema), wf.path)
router.post('/items/:itemId/assessment', requirePermissionStrict('repair:assess'), validateBody(assessmentSchema), wf.assess)
router.post('/items/:itemId/booking', requirePermissionStrict('repair:book'), validateBody(bookingSchema), wf.book)
router.post('/items/:itemId/booking/cancel', requirePermissionStrict('repair:book'), validateBody(cancelBookingSchema), wf.cancelBooking)
router.post('/items/:itemId/arrive', requirePermissionStrict('repair:book'), wf.arrive)
router.post('/items/:itemId/workshop-assign', requirePermissionStrict('repair:book'), validateBody(workshopAssignSchema), wf.workshopAssign)
router.post('/items/:itemId/damage', requirePermissionStrict('repair:resolve'), requireWorkableJob, validateBody(damageSchema), wf.damage)
router.post('/items/:itemId/warranty-void', requirePermissionStrict('repair:resolve'), requireWorkableJob, validateBody(warrantyVoidSchema), wf.voidWarranty)
router.post('/items/:itemId/warranty-void/clear', requirePermissionStrict('security_case:update'), validateBody(warrantyClearSchema), wf.clearWarranty)
// The work log opens by stage (repairs.workflow WORK_KINDS_AT): the Control
// Room logs verification; everything else is the job's technician's.
router.post('/items/:itemId/work',
  requirePermissionStrict((req) => (req.body as { kind?: string } | undefined)?.kind === 'verification' ? 'repair:verify' : 'repair:resolve'),
  validateBody(workEntrySchema), wf.work)
// An entry is changed only by whoever logged it (repairs.workflow editWork, deleteWork).
router.post('/items/:itemId/work/:entryId', requirePermissionStrict('repair:read'), validateBody(workEditSchema), wf.editWork)
router.post('/items/:itemId/work/:entryId/delete', requirePermissionStrict('repair:read'), wf.deleteWork)
router.post('/items/:itemId/complete', requirePermissionStrict('repair:resolve'), requireWorkableJob, validateBody(completeSchema), wf.complete)
router.post('/items/:itemId/verify', requirePermissionStrict('repair:verify'), validateBody(verifySchema), wf.verify)
router.post('/items/:itemId/void', requirePermissionStrict('repair:verify'), validateBody(voidSchema), wf.voidJob)
// Back or forward to any phase by hand: the Control Room that verifies repairs.
router.post('/items/:itemId/phase', requirePermissionStrict('repair:verify'), validateBody(movePhaseSchema), wf.movePhase)
router.get('/items/:itemId/ticket', requirePermission('repair:read'), wf.ticket)
// Sourcing and issuing are not the job's assignee's: ControlTech and stores act on any job.
router.post('/items/:itemId/parts/:partId/source', requirePermissionStrict('repair:parts_source'), validateBody(sourcePartSchema), wf.sourcePart)
router.post('/items/:itemId/parts/:partId/issue', requirePermissionStrict('repair:parts_issue'), validateBody(issuePartSchema), wf.issuePart)

// Last: `/items` would otherwise be swallowed by `/:reportId`.
router.get('/:reportId', requirePermission('repair:read'), ctrl.getReport)

export default router
