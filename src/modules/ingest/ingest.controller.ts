import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { processTelemetry } from './ingest.service.js'
import type { TelemetryPayload } from './ingest.schema.js'

export const ingest: RequestHandler = async (req, res, next) => {
  try {
    const id = await processTelemetry(req.ingestOrg!.id, req.body as TelemetryPayload)
    sendSuccess(res, { id: id.toString() }, 201)
  } catch (err) {
    next(err)
  }
}
