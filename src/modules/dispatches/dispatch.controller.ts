import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as repo from './dispatch.repository.js'

const p = (req: Parameters<RequestHandler>[0], key: string) => req.params[key] as string

/**
 * Dispatches still out, with ground covered and a due-back time.
 *
 * Its own endpoint rather than fields on /vehicles/snapshot: the snapshot is
 * the map's cold-paint path and already the slowest thing in the app (see the
 * poll-cycle notes), while this is a small set — 55 rows on the live fleet —
 * that changes on the order of hours. The dashboard polls it slowly and joins
 * by plate.
 */
export const listActive: RequestHandler = async (req, res, next) => {
  try {
    const rows = await repo.findActive(p(req, 'orgId'))
    sendSuccess(res, rows)
  } catch (err) { next(err) }
}
