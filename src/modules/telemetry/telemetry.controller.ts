import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { registerSseClient, emitHeartbeat } from '../../lib/sse.js'
import { listPings, getLatestPing, getFleetSnapshot, getActiveAlerts, getAlertHistoryCounts, getMaintenanceHistory, getVehicleServiceHistory, getVehicleGarageVisits } from './telemetry.service.js'
import type { TelemetryListQuery } from './telemetry.schema.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

export const getFleetSnapshotHandler: RequestHandler = async (req, res, next) => {
  try {
    const data = await getFleetSnapshot(p(req, 'orgId'))
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const getTelemetryHistory: RequestHandler = async (req, res, next) => {
  try {
    const result = await listPings(p(req, 'vehicleId'), req.user!.organisationId, req.query as unknown as TelemetryListQuery)
    sendSuccess(res, result.data, 200, { cursor: result.cursor, hasNextPage: result.hasNextPage })
  } catch (err) {
    next(err)
  }
}

export const getLatestTelemetry: RequestHandler = async (req, res, next) => {
  try {
    const ping = await getLatestPing(p(req, 'vehicleId'), req.user!.organisationId)
    sendSuccess(res, ping)
  } catch (err) {
    next(err)
  }
}

export const getActiveAlertsHandler: RequestHandler = async (req, res, next) => {
  try {
    const data = await getActiveAlerts(p(req, 'orgId'))
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const getAlertHistoryHandler: RequestHandler = async (req, res, next) => {
  try {
    const data = await getAlertHistoryCounts(p(req, 'orgId'))
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const getMaintenanceHistoryHandler: RequestHandler = async (req, res, next) => {
  try {
    // ?days=N&to=YYYY-MM-DD — both optional; default is the last 14 days
    // ending today (see getMaintenanceHistory's own defaults). Used by the
    // Maintenance page's calendar range/single-day selection.
    const daysRaw = req.query['days']
    const toRaw   = req.query['to']
    const days = typeof daysRaw === 'string' && daysRaw.trim() !== ''
      ? Math.min(366, Math.max(1, Math.round(Number(daysRaw))))
      : undefined
    const to = typeof toRaw === 'string' && !Number.isNaN(Date.parse(toRaw))
      ? new Date(toRaw)
      : undefined

    const data = await getMaintenanceHistory(p(req, 'orgId'), days, to)
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const getVehicleServiceHistoryHandler: RequestHandler = async (req, res, next) => {
  try {
    const data = await getVehicleServiceHistory(p(req, 'orgId'), p(req, 'vehicleId'))
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const getVehicleGarageVisitsHandler: RequestHandler = async (req, res, next) => {
  try {
    const data = await getVehicleGarageVisits(p(req, 'orgId'), p(req, 'vehicleId'))
    sendSuccess(res, data)
  } catch (err) { next(err) }
}

export const liveVehicleFeed: RequestHandler = (req, res, next) => {
  try {
    const vehicleId = p(req, 'vehicleId')
    const orgId = req.user!.organisationId

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const unregister = registerSseClient(orgId, vehicleId, res)

    const heartbeat = setInterval(() => {
      emitHeartbeat(orgId, vehicleId)
    }, 30_000)

    req.on('close', () => {
      clearInterval(heartbeat)
      unregister()
    })
  } catch (err) {
    next(err)
  }
}
