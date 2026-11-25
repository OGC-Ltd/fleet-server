/**
 * Today's weighings, small (operator, 2026-11-25): what the Ops Room
 * Operator's pop-ups read every 30 seconds. A pop-up for each weighing, and a
 * pop-up that stays until acknowledged when a unit gets its second ticket of
 * the day.
 *
 * Not the day route (`GET /weighments`): that one builds the whole board
 * (stats, every bridge, the rows with their gaps) and is too heavy to call
 * twice a minute. This reads only today's tickets' stamps, one indexed range
 * on (organisation, tokenAt), and answers with one line per weighing.
 *
 * Read only.
 */

import type { Request, Response } from 'express'
import { prisma } from '../../lib/prisma.js'
import { fleetDayStart } from '../../lib/provider-time.js'
import { sendError, sendSuccess } from '../../core/response/response.js'
import { logger } from '../../lib/logger.js'

/** A ticket opened late yesterday can be weighed after midnight: look this far back for its stamps. */
const LOOK_BACK_MS = 12 * 3_600_000
/** More tickets than any Sukari day has carried (314 on 24 Nov 2026); a cap, not a page. */
const MAX_TICKETS = 3_000

type Stamp = 'tare' | 'gross' | 'factoryTare' | 'factoryGross'

export interface Weighing {
  /** `<ticket id>:<stamp>`, stable: the same weighing always has the same id. */
  id: string
  ticketId: string
  at: string
  stamp: Stamp
  kg: number | null
  bridgeNo: number | null
  plate: string
  vehicleNo: string
  driverName: string
  centerName: string
  category: string
  tokenNumber: string
  netKg: number | null
  /** This ticket's place among the unit's tickets opened today (1 = its first). Null for a ticket opened before today. */
  nthToday: number | null
}

interface TicketRow {
  id: string; vehiclePlate: string; vehicleNo: string; driverName: string; centerName: string
  category: string; tokenNumber: bigint; tokenAt: Date; netWeightKg: number | null
  tareAt: Date | null; tareWeightKg: number | null; tareBridgeNo: number | null
  grossAt: Date | null; grossWeightKg: number | null; grossBridgeNo: number | null
  factoryTareAt: Date | null; factoryTareWeightKg: number | null; factoryTareBridgeNo: number | null
  factoryGrossAt: Date | null; factoryGrossWeightKg: number | null; factoryGrossBridgeNo: number | null
}

/** Pure: tickets → one line per weighing, newest first, with each ticket's place in its unit's day. */
export function weighingsOf(tickets: TicketRow[], dayStart: Date, since: Date | null): Weighing[] {
  // The unit's tickets opened today, in the order they were opened.
  const today = tickets.filter((t) => t.tokenAt >= dayStart).sort((a, b) => +a.tokenAt - +b.tokenAt || Number(a.tokenNumber - b.tokenNumber))
  const nth = new Map<string, number>()
  const count = new Map<string, number>()
  for (const t of today) {
    const n = (count.get(t.vehiclePlate) ?? 0) + 1
    count.set(t.vehiclePlate, n)
    nth.set(t.id, n)
  }
  const out: Weighing[] = []
  for (const t of tickets) {
    const stamps: Array<[Stamp, Date | null, number | null, number | null]> = [
      ['tare', t.tareAt, t.tareWeightKg, t.tareBridgeNo],
      ['gross', t.grossAt, t.grossWeightKg, t.grossBridgeNo],
      ['factoryTare', t.factoryTareAt, t.factoryTareWeightKg, t.factoryTareBridgeNo],
      ['factoryGross', t.factoryGrossAt, t.factoryGrossWeightKg, t.factoryGrossBridgeNo],
    ]
    for (const [stamp, at, kg, bridgeNo] of stamps) {
      if (!at || at < dayStart || (since && at <= since)) continue
      out.push({
        id: `${t.id}:${stamp}`, ticketId: t.id, at: at.toISOString(), stamp, kg, bridgeNo,
        plate: t.vehiclePlate, vehicleNo: t.vehicleNo, driverName: t.driverName, centerName: t.centerName,
        category: t.category, tokenNumber: String(t.tokenNumber), netKg: t.netWeightKg, nthToday: nth.get(t.id) ?? null,
      })
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/** GET /organisations/:orgId/weighments/recent?since=ISO */
export async function recentWeighings(req: Request, res: Response) {
  const orgId = String(req.params['orgId'] ?? '')
  const raw = typeof req.query['since'] === 'string' ? req.query['since'] : ''
  const since = raw ? new Date(raw) : null
  if (since && Number.isNaN(since.getTime())) return sendError(res, 400, 'since must be an ISO-8601 timestamp')
  try {
    const now = new Date()
    const dayStart = fleetDayStart(now)
    const tickets = await prisma.weighment.findMany({
      where: { organisationId: orgId, tokenAt: { gte: new Date(dayStart.getTime() - LOOK_BACK_MS) } },
      orderBy: { tokenAt: 'desc' },
      take: MAX_TICKETS,
      select: {
        id: true, vehiclePlate: true, vehicleNo: true, driverName: true, centerName: true,
        category: true, tokenNumber: true, tokenAt: true, netWeightKg: true,
        tareAt: true, tareWeightKg: true, tareBridgeNo: true,
        grossAt: true, grossWeightKg: true, grossBridgeNo: true,
        factoryTareAt: true, factoryTareWeightKg: true, factoryTareBridgeNo: true,
        factoryGrossAt: true, factoryGrossWeightKg: true, factoryGrossBridgeNo: true,
      },
    })
    const weighings = weighingsOf(tickets as TicketRow[], dayStart, since)
    return sendSuccess(res, { day: dayStart.toISOString(), checkedAt: now.toISOString(), weighings })
  } catch (err) {
    logger.error({ err, orgId }, 'Failed to list recent weighings')
    return sendError(res, 500, 'Could not load the recent weighings')
  }
}
