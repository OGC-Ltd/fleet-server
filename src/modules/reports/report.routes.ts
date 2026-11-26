import { Router } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requireAnyPermission, requirePermission } from '../../middleware/authorize.js'
import { validateBody, validateQuery } from '../../middleware/validate.js'
import { ingestLimiter } from '../../middleware/rateLimiter.js'
import {
  createPeriodSchema,
  createEngineSessionSchema,
  listPeriodQuerySchema,
  listEngineSessionQuerySchema,
  listSummaryQuerySchema,
  recoveryReportQuerySchema,
  movementReportQuerySchema,
  movementEventsQuerySchema,
  movementPdfBodySchema,
  probeReportQuerySchema,
  tankersReportBodySchema, tatFuelReportQuerySchema,
  endOfShiftQuerySchema,
  endOfShiftBodySchema,
  shiftDocSchema,
} from './report.schema.js'
import * as ctrl from './report.controller.js'
import * as conduct from './driver-conduct.controller.js'
import * as ranged from './range-reports.controller.js'
import { reportGate, getReportJob, getReportJobFile } from '../../lib/offload/report-jobs.js'
import {
  foundCasesSchema, importCasesSchema, caseActionSchema, listCasesQuerySchema,
  incidentSchema, importIncidentsSchema, incidentSharedSchema, dayRangeQuerySchema, unitDistanceBodySchema, odometerAtBodySchema,
} from './driver-conduct.schema.js'

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

// Where every unit is now and which way it is going relative to MORL, as a PDF
// or as data for the Reports page's Movements table, and the PDF of that
// table as the operator edited it. Positions, so telemetry:read.
router.get('/reports/movements.pdf', requirePermission('telemetry:read'), validateQuery(movementReportQuerySchema), reportGate, ctrl.downloadMovementReport)
router.get('/reports/movements/events', requirePermission('telemetry:read'), validateQuery(movementEventsQuerySchema), reportGate, ctrl.getMovementEventsData)
router.get('/reports/movements', requirePermission('telemetry:read'), validateQuery(movementReportQuerySchema), reportGate, ctrl.getMovementReportData)
router.post('/reports/movements.pdf', requirePermission('telemetry:read'), validateBody(movementPdfBodySchema), ctrl.downloadEditedMovementReport)
// Menengai's tankers on the road from the Mombasa depot to MORL, 4 hours at a time
router.post('/reports/tankers', requirePermission('telemetry:read'), validateBody(tankersReportBodySchema), reportGate, ctrl.getTankersReportData)
// Each trip signed back in on a fleet day, its fuel and its distance (Sukari's daily sheet)
router.get('/reports/tat-fuel', requirePermission('telemetry:read'), validateQuery(tatFuelReportQuerySchema), reportGate, ctrl.getTatFuelReportData)
router.get('/reports/speed', requirePermission('telemetry:read'), validateQuery(tatFuelReportQuerySchema), reportGate, ctrl.getSpeedReportData)
router.get('/reports/probe-disconnections', requirePermission('telemetry:read'), validateQuery(probeReportQuerySchema), reportGate, ctrl.getProbeReportData)
// Worked out here, not in the page (v47): fleet days from and to, inclusive.
router.get('/reports/fuel-consumption-rate', requirePermission('telemetry:read'), validateQuery(dayRangeQuerySchema), reportGate, ranged.fuelConsumptionRate)
router.post('/reports/unit-distance', requirePermission('telemetry:read'), validateBody(unitDistanceBodySchema), reportGate, ranged.unitDistance)
router.post('/reports/odometer-at', requirePermission('telemetry:read'), validateBody(odometerAtBodySchema), reportGate, ranged.odometerAt)
router.get('/reports/alarm-distribution', requirePermission('vehicle:read'), validateQuery(dayRangeQuerySchema), ranged.alarmDistribution)
router.get('/reports/unauthorized-passengers', requirePermission('telemetry:read'), validateQuery(dayRangeQuerySchema), ranged.unauthorizedPassengers)
router.get('/reports/recovery', requirePermission('telemetry:read'), validateQuery(recoveryReportQuerySchema), reportGate, ctrl.getRecoveryReport)
router.get('/reports/recovery.pdf', requirePermission('telemetry:read'), validateQuery(recoveryReportQuerySchema), reportGate, ctrl.downloadRecoveryReport)
// The rows the page made, for one organisation or several together, drawn on the letterhead.
// User-read users need this renderer for the group-scoped Login Activity report;
// telemetry-read report users retain access to their existing editable reports.
// Weighbridge-read users draw the Weighbridges Tickets, Coverage and Analytics PDFs
// (18 Nov 2026); Finance Manager holds that and neither of the other two.
// Their bodies are checked against report.schema on the worker thread that draws them
// (lib/offload/cpu-tasks), so validateBody is not in front of them.
router.post('/reports/document.pdf', requireAnyPermission(['telemetry:read', 'user:read', 'weighbridge:read']), ctrl.downloadReportDoc)
router.post('/reports/dormant-assets.pdf', requirePermission('telemetry:read'), ctrl.downloadDormantPdf)
router.post('/reports/geofences.pdf', requirePermission('telemetry:read'), ctrl.downloadGeofencePdf)
router.post('/reports/tat-fuel.pdf', requirePermission('telemetry:read'), ctrl.downloadTatFuelPdf)
router.post('/reports/speed.pdf', requirePermission('telemetry:read'), ctrl.downloadSpeedPdf)
router.post('/reports/deliveries.pdf', requirePermission('telemetry:read'), ctrl.downloadDeliveriesPdf)
router.post('/summaries/refresh/:periodId', requirePermission('report:create'), ctrl.refreshSummaries)

// Driver conduct follow-up: the cases a report run finds and what was done on
// each, and the incidents operators log by hand. Kept here so every machine
// sees the same (operator, 2 Nov 2026); before, each browser kept its own.
// analytics:read, as the Reports page itself: whoever runs the report records
// the follow-up.
const conductRead = requirePermission('analytics:read')
router.get('/driver-conduct/cases', conductRead, validateQuery(listCasesQuerySchema), conduct.listCases)
router.get('/driver-conduct/cases/pending-count', conductRead, conduct.pendingCount)
router.post('/driver-conduct/cases/found', conductRead, validateBody(foundCasesSchema), conduct.mergeFound)
router.post('/driver-conduct/cases/import', conductRead, validateBody(importCasesSchema), conduct.importCases)
router.put('/driver-conduct/cases/:caseKey/action', conductRead, validateBody(caseActionSchema), conduct.recordAction)
router.get('/driver-conduct/incidents', conductRead, conduct.listIncidents)
router.post('/driver-conduct/incidents/import', conductRead, validateBody(importIncidentsSchema), conduct.importIncidents)
router.put('/driver-conduct/incidents/:incidentId', conductRead, validateBody(incidentSchema), conduct.saveIncident)
router.delete('/driver-conduct/incidents/:incidentId', conductRead, conduct.deleteIncident)
router.put('/driver-conduct/incidents/:incidentId/shared', conductRead, validateBody(incidentSharedSchema), conduct.setIncidentShared)

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
// The end-of-shift report: today from midnight (Nairobi) up to now, or the
// period picked on the Reports page (?from&to, epoch ms, a week at most). Made here rather than in the
// browser (operator, 2026-10-31). It carries the weighbridge AND the fleet's
// fuel, breaches and geofence exits, so it takes both permissions the
// dashboard's button used to need.
// Declared before /reports/pdf/:kind so 'end-of-shift' is never read as a kind.
router.get(
  '/reports/end-of-shift.pdf',
  requirePermission('weighbridge:read'),
  requirePermission('analytics:read'),
  validateQuery(endOfShiftQuerySchema),
  reportGate,
  ctrl.downloadEndOfShift,
)
// The same report as a document the Reports page shows and lets the operator
// edit (operator, 2026-11-02), and that document, edited, drawn as the PDF.
router.get(
  '/reports/end-of-shift',
  requirePermission('weighbridge:read'),
  requirePermission('analytics:read'),
  validateQuery(endOfShiftQuerySchema),
  reportGate,
  ctrl.getEndOfShiftDoc,
)
// The same, for one category of the fleet (Menengai's fleet list)
router.post(
  '/reports/end-of-shift',
  requirePermission('weighbridge:read'),
  requirePermission('analytics:read'),
  validateBody(endOfShiftBodySchema),
  reportGate,
  ctrl.getEndOfShiftDocFor,
)
router.post(
  '/reports/end-of-shift.pdf',
  requirePermission('weighbridge:read'),
  requirePermission('analytics:read'),
  validateBody(shiftDocSchema),
  ctrl.downloadEditedEndOfShift,
)

router.get(
  '/reports/pdf/:kind',
  requirePermission((req) => PDF_PERMISSION[String(req.params['kind'])] ?? 'report:export'),
  reportGate,
  ctrl.downloadPdfReport,
)

// A report asked for with `Prefer: respond-async` (lib/offload/report-jobs):
// where it is, and the file once it is drawn. Only the user who asked, in
// the same organisation, can read them; no permission beyond that is needed.
router.get('/reports/jobs/:jobId', getReportJob)
router.get('/reports/jobs/:jobId/file', getReportJobFile)

export default router
