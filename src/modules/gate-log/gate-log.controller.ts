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
 * One action (operator, 2026-11-26): an event acknowledged, on its own right
 * (`gate_log:acknowledge`): it truly left, or truly came in (CONFIRMED), or it
 * did not (DISPUTED, with why). The list carries each event's latest one.
 */

import type { Request, Response } from 'express'
import { getNotifications } from '../../lib/notifications/notification.reader.js'
import { sendError, sendSuccess } from '../../core/response/response.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'

/** The gate's radius when the organisation records none (lib/yard-departure). */
const DEFAULT_GATE_RADIUS_M = 60

/**
 * The organisation's gate, for the event panel's map (operator, 2026-11-26:
 * "a map that shows where it was at that moment and the gate"). A coordinate,
 * not a geofence (lib/yard-departure); null where none is recorded. A failed
 * read only leaves the map without its gate.
 */
async function orgGate(orgId: string): Promise<{ lat: number; lng: number; radiusM: number } | null> {
  try {
    const org = await prisma.organisation.findUnique({
      where: { id: orgId },
      select: { gateLat: true, gateLng: true, gateRadiusM: true },
    })
    return org?.gateLat != null && org.gateLng != null
      ? { lat: org.gateLat, lng: org.gateLng, radiusM: org.gateRadiusM ?? DEFAULT_GATE_RADIUS_M }
      : null
  } catch (err) {
    logger.warn({ err, orgId }, 'Gate log: could not read the gate coordinate')
    return null
  }
}

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

/** What the list carries for an acknowledged event. */
export interface GateAck {
  outcome: 'CONFIRMED' | 'DISPUTED'
  note:    string | null
  by:      string
  at:      string
}

type AckRow = { eventId: string; outcome: string; note: string | null; decidedByName: string; decidedAt: Date }
const ackOf = (r: AckRow): GateAck => ({
  outcome: r.outcome === 'DISPUTED' ? 'DISPUTED' : 'CONFIRMED',
  note:    r.note,
  by:      r.decidedByName,
  at:      r.decidedAt.toISOString(),
})

/** The latest acknowledgement of each listed event; a failed read lists the day without them. */
async function acksFor(orgId: string, eventIds: string[]): Promise<Map<string, GateAck> | null> {
  if (eventIds.length === 0) return new Map()
  try {
    const rows = await prisma.gateAcknowledgement.findMany({
      where:  { organisationId: orgId, eventId: { in: eventIds } },
      select: { eventId: true, outcome: true, note: true, decidedByName: true, decidedAt: true },
    })
    return new Map(rows.map((r) => [r.eventId, ackOf(r)]))
  } catch (err) {
    logger.warn({ err, orgId }, 'Gate log: could not read the acknowledgements')
    return null
  }
}

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
    const [page, gate] = await Promise.all([getNotifications(orgId, {
      limit:      parsedLimit,
      before:     beforeDate,
      day:        dayStr,
      // Fixed here, never from the query: this route shows the gate and nothing else.
      alertTypes: [...GATE_LOG_ALERT_TYPES],
      vehicleIds: req.authz?.vehicleIds ?? null,
      // No restricted sources (repair tickets, flags): none of them is a gate event.
      grants:     [],
    }), orgGate(orgId)])
    // Belt and braces: whatever the reader returns, only the gate's own types leave this route.
    const listed = page.items.filter((i) => (GATE_LOG_ALERT_TYPES as readonly string[]).includes(String(i.alertType ?? '')))
    // Each event's acknowledgement, null where none; left off altogether when
    // they could not be read, so the page says "not loaded" and not "none".
    const acks = await acksFor(orgId, listed.map((i) => String(i.id)))
    const items = acks ? listed.map((i) => ({ ...i, acknowledgement: acks.get(String(i.id)) ?? null })) : listed
    // The next page's cursor whenever this one had anything. Not "only when the
    // page came back full": the reader merges a unit's crossings within five
    // minutes into one line, so a page of 200 rows can come back shorter and
    // would wrongly read as the end of the day. The caller stops at an empty page.
    // The oldest line's time is safe to page from: a merged line carries its
    // FIRST crossing's time (notifications/movement-window).
    const oldest = page.items.length > 0 ? page.items[page.items.length - 1]!.ts : null
    return sendSuccess(res, {
      events:     items,
      count:      items.length,
      nextBefore: oldest,
      gate,
    })
  } catch (err) {
    logger.error({ err, orgId }, 'Failed to list the gate log')
    return sendError(res, 500, 'Could not load the gate log')
  }
}

const OUTCOMES = ['CONFIRMED', 'DISPUTED'] as const
const NOTE_MAX = 2000

/**
 * POST /organisations/:orgId/gate-log/:eventId/acknowledgement
 * body: { outcome: 'CONFIRMED' | 'DISPUTED', note?: string }
 *
 * The event must be this organisation's, one of the gate's own types and, for
 * a caller narrowed to some vehicles, one of theirs: the same events the list
 * shows them. A DISPUTED needs a note (3+ characters); a CONFIRMED may carry
 * one. A second decision replaces the first. Answers the acknowledgement as
 * the list carries it.
 */
export async function acknowledge(req: Request, res: Response) {
  const orgId = String(req.params['orgId'] ?? '')
  const eventId = String(req.params['eventId'] ?? '')
  const userId = req.user?.id
  if (!userId) return sendError(res, 401, 'An account is required')
  const body = (req.body ?? {}) as { outcome?: unknown; note?: unknown }
  const outcome = OUTCOMES.find((o) => o === body.outcome)
  if (!outcome) return sendError(res, 400, 'outcome must be CONFIRMED or DISPUTED')
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, NOTE_MAX) : ''
  if (outcome === 'DISPUTED' && note.length < 3) return sendError(res, 400, 'Say why it did not leave or come in')

  try {
    const event = await prisma.notification.findUnique({
      where:  { feedId: eventId },
      select: { organisationId: true, alertType: true, vehicleId: true, plate: true, occurredAt: true },
    })
    const scope = req.authz?.vehicleIds ?? null
    if (!event || event.organisationId !== orgId
        || !(GATE_LOG_ALERT_TYPES as readonly string[]).includes(String(event.alertType ?? ''))
        || (scope && (!event.vehicleId || !scope.has(event.vehicleId)))) {
      return sendError(res, 404, 'No such gate event')
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } })
    const data = {
      outcome,
      note:          note || null,
      decidedById:   userId,
      decidedByName: user?.fullName?.trim() || 'Someone',
      decidedAt:     new Date(),
    }
    const row = await prisma.gateAcknowledgement.upsert({
      where:  { organisationId_eventId: { organisationId: orgId, eventId } },
      create: {
        organisationId: orgId, eventId, alertType: String(event.alertType),
        vehicleId: event.vehicleId, plate: event.plate, eventAt: event.occurredAt, ...data,
      },
      update: data,
      select: { eventId: true, outcome: true, note: true, decidedByName: true, decidedAt: true },
    })
    return sendSuccess(res, { eventId, acknowledgement: ackOf(row) })
  } catch (err) {
    logger.error({ err, orgId, eventId }, 'Failed to acknowledge a gate event')
    return sendError(res, 500, 'Could not save the acknowledgement')
  }
}
