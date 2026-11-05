import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { BadRequestError } from '../../core/errors/errors.js'
import * as service from './report.service.js'
import { generateReportPdf, PDF_REPORT_KINDS, type PdfReportKind } from './report-pdf.service.js'
import { loadEndOfShift, orgHeading } from './end-of-shift.data.js'
import { renderEndOfShiftPdf, renderShiftDoc, endOfShiftDoc, reportNumber, endOfShiftFileName, type ShiftDoc } from './end-of-shift.pdf.js'
import type { CreatePeriodDto, CreateEngineSessionDto, ListPeriodQuery, ListEngineSessionQuery, ListSummaryQuery, MovementReportQuery, MovementEventsQuery, MovementPdfBody, EndOfShiftQuery, EndOfShiftBody, ShiftDocBody, ReportDocBody, TankersReportBody, TatFuelReportQuery, DormantPdfBody, GeofencePdfBody, TatFuelPdfBody, SpeedPdfBody, DeliveriesPdfBody } from './report.schema.js'
import { getMovementReport, editedMovementReport, type MovementReport } from './movement-report.service.js'
import { getMovementEvents } from './movement-events.service.js'
import { getTankersReport } from './tankers-report.service.js'
import { getTatFuelReport } from './tat-fuel-report.service.js'
import { getSpeedReport } from './speed-report.service.js'
import { renderMovementReportsPdf, movementFileName, movementReportsFileName } from './movement-report.pdf.js'
import { renderDormantPdf, renderGeofencePdf, renderTatFuelPdf, renderSpeedPdf, renderDeliveriesPdf, dormantFileName, geofenceFileName, tatFileName, speedFileName, deliveriesFileName } from './template-report.pdf.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

// ── Periods ───────────────────────────────────────────────────────────────────

export const listPeriods: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listPeriods(p(req, 'orgId'), req.query as unknown as ListPeriodQuery)
    sendSuccess(res, data, 200, { total })
  } catch (err) { next(err) }
}

export const getPeriod: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.getPeriod(p(req, 'orgId'), p(req, 'periodId')))
  } catch (err) { next(err) }
}

export const createPeriod: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createPeriod(p(req, 'orgId'), req.body as CreatePeriodDto), 201)
  } catch (err) { next(err) }
}

// ── Engine Sessions ───────────────────────────────────────────────────────────

export const listEngineSessions: RequestHandler = async (req, res, next) => {
  try {
    const { data, cursor, hasNextPage } = await service.listEngineSessions(p(req, 'orgId'), req.query as unknown as ListEngineSessionQuery)
    sendSuccess(res, data, 200, { cursor, hasNextPage })
  } catch (err) { next(err) }
}

export const createEngineSession: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await service.createEngineSession(req.body as CreateEngineSessionDto), 201)
  } catch (err) { next(err) }
}

// ── Summaries ─────────────────────────────────────────────────────────────────

export const listSummaries: RequestHandler = async (req, res, next) => {
  try {
    const { data, total } = await service.listSummaries(p(req, 'orgId'), req.query as unknown as ListSummaryQuery)
    sendSuccess(res, data, 200, { total })
  } catch (err) { next(err) }
}

export const refreshSummaries: RequestHandler = async (req, res, next) => {
  try {
    const result = await service.refreshSummaries(p(req, 'orgId'), p(req, 'periodId'))
    sendSuccess(res, result)
  } catch (err) { next(err) }
}

// ── Branded PDF reports ───────────────────────────────────────────────────────

export const downloadPdfReport: RequestHandler = async (req, res, next) => {
  try {
    const kind = p(req, 'kind') as PdfReportKind
    if (!PDF_REPORT_KINDS.includes(kind)) {
      throw new BadRequestError(`Unknown report kind '${kind}' — expected one of: ${PDF_REPORT_KINDS.join(', ')}`)
    }
    // Trailing window; clamped to the same 366-day ceiling the history API uses.
    const days = Math.min(366, Math.max(1, Number(req.query.days) || 30))
    const { buffer, filename } = await generateReportPdf(p(req, 'orgId'), kind, days, req.authz?.vehicleIds ?? null)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', String(buffer.length))
    res.send(buffer)
  } catch (err) { next(err) }
}

// ── End-of-shift report ───────────────────────────────────────────────────────

/** The report for the period asked (today up to now by default), made for this caller. */
async function endOfShiftFor(req: Parameters<RequestHandler>[0], now: number, q: EndOfShiftQuery | EndOfShiftBody = req.query as unknown as EndOfShiftQuery) {
  const orgId = p(req, 'orgId')
  const period = q.from != null && q.to != null ? { from: q.from, to: q.to } : undefined
  // One category: its units, and never past the caller's own scope
  const scope = req.authz?.vehicleIds ?? null
  const only = 'vehicleIds' in q && q.vehicleIds ? new Set(q.vehicleIds.filter((id) => !scope || scope.has(id))) : null
  const [org, { report }] = await Promise.all([
    orgHeading(orgId),
    loadEndOfShift({ orgId, vehicleIds: only ?? scope, userId: req.authz?.userId ?? null, now, period }),
  ])
  return { org, report }
}

function sendShiftPdf(res: Parameters<RequestHandler>[1], buffer: Buffer, orgName: string, now: number) {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${endOfShiftFileName(orgName, now)}"`)
  res.setHeader('Content-Length', String(buffer.length))
  res.setHeader('Cache-Control', 'no-store')
  res.send(buffer)
}

/** Today from midnight Nairobi up to now, or the period asked for, for this organisation, as a PDF. */
export const downloadEndOfShift: RequestHandler = async (req, res, next) => {
  try {
    const now = Date.now()
    const { org, report } = await endOfShiftFor(req, now)
    const buffer = await renderEndOfShiftPdf(report, { orgName: org.name, reportNo: reportNumber(org.short, now), generatedAt: now })
    sendShiftPdf(res, buffer, org.name, now)
  } catch (err) { next(err) }
}

/** GET /organisations/:orgId/reports/end-of-shift?from&to — the report as the document the PDF is drawn from. */
export const getEndOfShiftDoc: RequestHandler = async (req, res, next) => {
  try {
    const now = Date.now()
    const { org, report } = await endOfShiftFor(req, now)
    sendSuccess(res, endOfShiftDoc(report, { orgName: org.name, reportNo: reportNumber(org.short, now), generatedAt: now }))
  } catch (err) { next(err) }
}

/** POST /organisations/:orgId/reports/end-of-shift {from, to, vehicleIds, category} — the document for one category of the fleet. */
export const getEndOfShiftDocFor: RequestHandler = async (req, res, next) => {
  try {
    const now = Date.now()
    const body = req.body as EndOfShiftBody
    const { org, report } = await endOfShiftFor(req, now, body)
    sendSuccess(res, endOfShiftDoc(report, { orgName: org.name, reportNo: reportNumber(org.short, now), generatedAt: now, category: body.category }))
  } catch (err) { next(err) }
}

/**
 * POST /organisations/:orgId/reports/end-of-shift.pdf — the document as the
 * operator edited it on the Reports page, drawn as the PDF. The report number
 * and the footer's "made" time are the server's, from now.
 */
export const downloadEditedEndOfShift: RequestHandler = async (req, res, next) => {
  try {
    const now = Date.now()
    const org = await orgHeading(p(req, 'orgId'))
    const body = req.body as ShiftDocBody
    const made = endOfShiftDoc.made(org.name, body.date, now)
    const doc: ShiftDoc = { ...body, reportNo: reportNumber(org.short, now), footer: made }
    // A category's report is named for it: "… Menengai Tankers 2026-11-02 …"
    const category = body.meta.find((m) => m.label === 'Category')?.value
    sendShiftPdf(res, await renderShiftDoc(doc, { landscape: turned(req) }), category ? `${org.name} ${category}` : org.name, now)
  } catch (err) { next(err) }
}

/** `?landscape=1`: the pages turned on their side (the JPEG's Landscape, 4 Nov 2026). */
const turned = (req: Parameters<RequestHandler>[0]) => req.query.landscape === '1'

/** The window a movement-report query asks for: from–to, or the last `hours` up to now. */
const movementWindow = (q: MovementReportQuery) => (q.from != null && q.to != null ? { from: q.from, to: q.to } : q.hours)

/**
 * GET /organisations/:orgId/reports/movements.pdf?hours=N | ?from&to — where
 * every unit was when the window ended, and whether it was heading to MORL or
 * away from it over the window. A permission-scoped caller gets only the
 * units they may see.
 */
export const downloadMovementReport: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as MovementReportQuery
    const report = await getMovementReport(p(req, 'orgId'), movementWindow(q), req.authz?.vehicleIds ?? null)
    await sendMovementPdf(res, [report])
  } catch (err) { next(err) }
}

/**
 * GET /organisations/:orgId/reports/movements?hours=N | ?from&to — the same
 * report as data, for the Reports page to show as a table and let the
 * operator edit.
 */
export const getMovementReportData: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as MovementReportQuery
    sendSuccess(res, await getMovementReport(p(req, 'orgId'), movementWindow(q), req.authz?.vehicleIds ?? null, Date.now(), { offline: q.offline === '1' }))
  } catch (err) { next(err) }
}

/** GET /organisations/:orgId/reports/movements/events?from&to&kinds=stop,braking — the events picked onto the report. */
export const getMovementEventsData: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as MovementEventsQuery
    sendSuccess(res, await getMovementEvents(p(req, 'orgId'), q, req.authz?.vehicleIds ?? null))
  } catch (err) { next(err) }
}

/**
 * POST /organisations/:orgId/reports/tankers — the Tankers Report as data:
 * each tanker the page sends that is on a trip from the Mombasa depot, when it
 * left, how far it went in the 4 hours up to the report time and since it
 * left, and its status. A permission-scoped caller gets only the units they may see.
 */
export const getTankersReportData: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as TankersReportBody
    sendSuccess(res, await getTankersReport(p(req, 'orgId'), body.units, body.to ?? Date.now(), req.authz?.vehicleIds ?? null))
  } catch (err) { next(err) }
}

/**
 * GET /organisations/:orgId/reports/tat-fuel?day=YYYY-MM-DD — each trip signed
 * back in that fleet day, with its fuel and distance, and why any other unit has none.
 */
export const getTatFuelReportData: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as TatFuelReportQuery
    sendSuccess(res, await getTatFuelReport(p(req, 'orgId'), q.day, req.authz?.vehicleIds ?? null))
  } catch (err) { next(err) }
}

/**
 * GET /organisations/:orgId/reports/speed?day=YYYY-MM-DD — each unit that went
 * over its limit that fleet day: mileage, peak, limit, distance and occurrences.
 */
export const getSpeedReportData: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as TatFuelReportQuery
    sendSuccess(res, await getSpeedReport(p(req, 'orgId'), q.day, req.authz?.vehicleIds ?? null))
  } catch (err) { next(err) }
}

/**
 * POST /organisations/:orgId/reports/movements.pdf — the report as edited on
 * the Reports page, drawn as the PDF. The organisation's name comes from the
 * database, the overview is counted from the rows sent, and the PDF names the
 * signed-in user as its editor.
 */
export const downloadEditedMovementReport: RequestHandler = async (req, res, next) => {
  try {
    const by = req.user?.fullName || req.user?.email || 'Unknown user'
    const body = req.body as MovementPdfBody
    const asked = 'reports' in body ? body.reports : [body]
    const reports = await Promise.all(asked.map(r => editedMovementReport(p(req, 'orgId'), r, by)))
    await sendMovementPdf(res, reports, turned(req))
  } catch (err) { next(err) }
}

/** A PDF, under its name, as the browser should save it. */
function sendPdf(res: Parameters<RequestHandler>[1], buffer: Buffer, name: string) {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition',
    `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.setHeader('Content-Length', String(buffer.length))
  res.send(buffer)
}

/** POST /organisations/:orgId/reports/document.pdf — any report as edited on its page, drawn from the sheet. */
export const downloadReportDoc: RequestHandler = async (req, res, next) => {
  try {
    const { filename, ...doc } = req.body as ReportDocBody
    sendPdf(res, await renderShiftDoc(doc, { landscape: turned(req) }), `${filename}.pdf`)
  } catch (err) { next(err) }
}

/** POST /organisations/:orgId/reports/dormant-assets.pdf — the page's rows, drawn on the letterhead. */
export const downloadDormantPdf: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as DormantPdfBody
    const { short } = await orgHeading(p(req, 'orgId'))
    sendPdf(res, await renderDormantPdf(body, { orgCode: short, landscape: turned(req) }), dormantFileName(body))
  } catch (err) { next(err) }
}

/** POST /organisations/:orgId/reports/geofences.pdf — the page's rows, drawn on the letterhead. */
export const downloadGeofencePdf: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as GeofencePdfBody
    const { short } = await orgHeading(p(req, 'orgId'))
    sendPdf(res, await renderGeofencePdf(body, { orgCode: short, landscape: turned(req) }), geofenceFileName(body))
  } catch (err) { next(err) }
}

/** POST /organisations/:orgId/reports/tat-fuel.pdf — the page's rows, drawn on the letterhead. */
export const downloadTatFuelPdf: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as TatFuelPdfBody
    const { short } = await orgHeading(p(req, 'orgId'))
    sendPdf(res, await renderTatFuelPdf(body, { orgCode: short }), tatFileName(body))
  } catch (err) { next(err) }
}

/** POST /organisations/:orgId/reports/speed.pdf — the page's rows, drawn on the letterhead. */
export const downloadSpeedPdf: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as SpeedPdfBody
    const { short } = await orgHeading(p(req, 'orgId'))
    sendPdf(res, await renderSpeedPdf(body, { orgCode: short, landscape: turned(req) }), speedFileName(body))
  } catch (err) { next(err) }
}

/** POST /organisations/:orgId/reports/deliveries.pdf — the page's rows, drawn on the letterhead. */
export const downloadDeliveriesPdf: RequestHandler = async (req, res, next) => {
  try {
    const body = req.body as DeliveriesPdfBody
    const { short } = await orgHeading(p(req, 'orgId'))
    sendPdf(res, await renderDeliveriesPdf(body, { orgCode: short, landscape: turned(req) }), deliveriesFileName(body))
  } catch (err) { next(err) }
}

/** One report, or a window a day over a range of days, as one PDF. */
async function sendMovementPdf(res: Parameters<RequestHandler>[1], reports: MovementReport[], landscape = false) {
  const buffer = await renderMovementReportsPdf(reports, { landscape })
  const name = reports.length === 1 ? movementFileName(reports[0]!) : movementReportsFileName(reports)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition',
    `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.setHeader('Content-Length', String(buffer.length))
  res.send(buffer)
}
