/**
 * The Gate log (operator, 2026-11-25): the sign-outs and returns at the gate,
 * one fleet day at a time, for the Ops Room Operator.
 *
 * Its own route on its own right (`gate_log:read`), not the live feed with a
 * filter on it: the Ops Room Operator holds no `notification:read`, so the
 * live feed and its stream stay closed to them, and this route can only ever
 * answer with the four alert types below, whatever is asked of it. Nothing in
 * the live feed, its stream or the access model changes for anyone else.
 *
 * Read only: it lists, it acts on nothing.
 */

import type { Request, Response } from 'express'
import { getNotifications } from '../../lib/notifications/notification.reader.js'
import { sendError, sendSuccess } from '../../core/response/response.js'
import { logger } from '../../lib/logger.js'

/**
 * The gate's own events (modules/webhooks/raifactorysuite-events):
 *   DISPATCH        "… signed out to X and left the premises."
 *   MOVEMENT_ENTRY  "… returned to the yard."
 *   SALE_DISPATCH   a sales run signed out
 *   SALE_RETURN     a sales run signed back in
 * MOVEMENT_EXIT is left out on purpose (operator, 2026-11-25): the sign-out
 * already says the unit left.
 */
export const GATE_LOG_ALERT_TYPES = ['DISPATCH', 'MOVEMENT_ENTRY', 'SALE_DISPATCH', 'SALE_RETURN'] as const

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_LIMIT = 200

/** GET /organisations/:orgId/gate-log?day=YYYY-MM-DD&before=ISO&limit=n */
export async function gateLog(req: Request, res: Response) {
  const orgId = String(req.params['orgId'] ?? '')
  const { day, before, limit } = req.query
  const dayStr = typeof day === 'string' && day ? day : undefined
  if (dayStr && !DAY.test(dayStr)) return sendError(res, 400, 'day must be YYYY-MM-DD')
  let beforeDate: Date | undefined
  if (typeof before === 'string' && before) {
    beforeDate = new Date(before)
    if (Number.isNaN(beforeDate.getTime())) return sendError(res, 400, 'before must be an ISO-8601 timestamp')
  }
  const n = Number(limit ?? 100)
  const parsedLimit = Number.isFinite(n) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(n))) : 100

  try {
    const page = await getNotifications(orgId, {
      limit:      parsedLimit,
      before:     beforeDate,
      day:        dayStr,
      // Fixed here, never from the query: this route shows the gate and nothing else.
      alertTypes: [...GATE_LOG_ALERT_TYPES],
      vehicleIds: req.authz?.vehicleIds ?? null,
      // No restricted sources (repair tickets, flags): none of them is a gate event.
      grants:     [],
    })
    // Belt and braces: whatever the reader returns, only the gate's own types leave this route.
    const items = page.items.filter((i) => (GATE_LOG_ALERT_TYPES as readonly string[]).includes(String(i.alertType ?? '')))
    return sendSuccess(res, {
      events:     items,
      count:      items.length,
      nextBefore: items.length > 0 && page.items.length >= parsedLimit ? items[items.length - 1]!.ts : null,
    })
  } catch (err) {
    logger.error({ err, orgId }, 'Failed to list the gate log')
    return sendError(res, 500, 'Could not load the gate log')
  }
}
