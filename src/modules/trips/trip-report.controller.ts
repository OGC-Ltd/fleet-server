import type { RequestHandler, Response } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { BadRequestError } from '../../core/errors/errors.js'
import { getTripReportData, getDayTrips, getDayReportData } from './trip-report.service.js'
import { buildTripReport, type ReportInput } from './trip-report.build.js'
import { renderTripReportPdf, reportFileName } from './trip-report.pdf.js'

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** ?dispatch=<externalId> picks the run; without it, the vehicle's latest. */
export const getTripReportHandler: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await getTripReportData(req.params.orgId as string, req.params.vehicleId as string, str(req.query.dispatch)))
  } catch (err) { next(err) }
}

/** The finished report, built and drawn here: the dashboard only downloads it. */
async function sendReportPdf(res: Response, data: ReportInput) {
  const report = buildTripReport(data)
  const buffer = await renderTripReportPdf(report)
  const name = reportFileName(report)
  res.setHeader('Content-Type', 'application/pdf')
  // Plain ASCII for old clients, RFC 5987 for the real name.
  res.setHeader('Content-Disposition',
    `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
  res.setHeader('Content-Length', String(buffer.length))
  res.send(buffer)
}

/** GET …/vehicles/:vehicleId/trip-report.pdf?dispatch=<externalId> */
export const getTripReportPdfHandler: RequestHandler = async (req, res, next) => {
  try {
    await sendReportPdf(res, await getTripReportData(req.params.orgId as string, req.params.vehicleId as string, str(req.query.dispatch), { withMap: false }))
  } catch (err) { next(err) }
}

const dayOf = (req: Parameters<RequestHandler>[0]) => {
  const day = str(req.query.day)
  if (!day) throw new BadRequestError('day is required, YYYY-MM-DD')
  return day
}

/** GET …/vehicles/:vehicleId/day-trips?day=YYYY-MM-DD — the picker's list. */
export const getDayTripsHandler: RequestHandler = async (req, res, next) => {
  try {
    sendSuccess(res, await getDayTrips(req.params.orgId as string, req.params.vehicleId as string, dayOf(req)))
  } catch (err) { next(err) }
}

/** GET …/vehicles/:vehicleId/day-report.pdf?day=YYYY-MM-DD[&trip=N] — the whole day, or trip N of it. */
export const getDayReportPdfHandler: RequestHandler = async (req, res, next) => {
  try {
    const raw = str(req.query.trip)
    const trip = raw == null ? null : Number(raw)
    if (trip != null && (!Number.isInteger(trip) || trip < 1)) throw new BadRequestError('trip must be a trip number from day-trips')
    await sendReportPdf(res, await getDayReportData(req.params.orgId as string, req.params.vehicleId as string, dayOf(req), trip))
  } catch (err) { next(err) }
}
