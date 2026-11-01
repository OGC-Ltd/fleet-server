import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { BadRequestError } from '../../core/errors/errors.js'
import * as service from './report.service.js'
import { generateReportPdf, PDF_REPORT_KINDS, type PdfReportKind } from './report-pdf.service.js'
import { loadEndOfShift, orgHeading } from './end-of-shift.data.js'
import { renderEndOfShiftPdf, reportNumber, endOfShiftFileName } from './end-of-shift.pdf.js'
import type { CreatePeriodDto, CreateEngineSessionDto, ListPeriodQuery, ListEngineSessionQuery, ListSummaryQuery, MovementReportQuery, EditedMovementReport } from './report.schema.js'
import { getMovementReport, editedMovementReport, type WindowHours, type MovementReport } from './movement-report.service.js'
import { renderMovementReportPdf, movementFileName } from './movement-report.pdf.js'

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

/** Today from midnight Nairobi up to now, for this organisation, as a PDF. */
export const downloadEndOfShift: RequestHandler = async (req, res, next) => {
  try {
    const orgId = p(req, 'orgId')
    const now = Date.now()
    const [org, { report }] = await Promise.all([
      orgHeading(orgId),
      loadEndOfShift({ orgId, vehicleIds: req.authz?.vehicleIds ?? null, userId: req.authz?.userId ?? null, now }),
    ])
    const buffer = await renderEndOfShiftPdf(report, { orgName: org.name, reportNo: reportNumber(org.short, now), generatedAt: now })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${endOfShiftFileName(org.name, now)}"`)
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Cache-Control', 'no-store')
    res.send(buffer)
  } catch (err) { next(err) }
}

/**
 * GET /organisations/:orgId/reports/movements.pdf?hours=2|4 — where every unit
 * is now, and whether it is heading to MORL or away from it over the window.
 * A permission-scoped caller gets only the units they may see.
 */
export const downloadMovementReport: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as MovementReportQuery
    const report = await getMovementReport(p(req, 'orgId'), q.hours as WindowHours, req.authz?.vehicleIds ?? null)
    await sendMovementPdf(res, report)
  } catch (err) { next(err) }
}

/**
 * GET /organisations/:orgId/reports/movements?hours=2|4 — the same report as
 * data, for the Reports page to show as a table and let the operator edit.
 */
export const getMovementReportData: RequestHandler = async (req, res, next) => {
  try {
    const q = req.query as unknown as MovementReportQuery
    sendSuccess(res, await getMovementReport(p(req, 'orgId'), q.hours as WindowHours, req.authz?.vehicleIds ?? null))
  } catch (err) { next(err) }
}

/**
 * POST /organisations/:orgId/reports/movements.pdf — the report as edited on
 * the Reports page, drawn as the PDF. The organisation's name comes from the
 * database and the overview is counted from the rows sent.
 */
export const downloadEditedMovementReport: RequestHandler = async (req, res, next) => {
  try {
    const report = await editedMovementReport(p(req, 'orgId'), req.body as EditedMovementReport)
    await sendMovementPdf(res, report)
  } catch (err) { next(err) }
}

async function sendMovementPdf(res: Parameters<RequestHandler>[1], report: MovementReport) {
  const buffer = await renderMovementReportPdf(report)
  const name = movementFileName(report)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition',
    `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.setHeader('Content-Length', String(buffer.length))
  res.send(buffer)
}
