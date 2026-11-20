/**
 * The Deliveries report's own records (operator, 11 Nov 2026: "we don't want
 * it to be kept in the browser"): the list of vehicles shared on a day with
 * their stops, and the orders fulfilled typed over the report's count. Both
 * lived in each browser's localStorage, so two people in the office saw two
 * different lists. Postgres holds them; reads go through Redis
 * (delivery-days.cache).
 */

import type { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { BadRequestError, ConflictError } from '../../core/errors/errors.js'
import { DAY_RE, MAX_RANGE_DAYS, type DaySave } from './deliveries.schema.js'
import { readThrough, keep, dayKey, ordersKey, DAY_TTL_S, ORDERS_TTL_S } from './delivery-days.cache.js'
import { syncKeyedPlans } from '../planner/keyed-plans.js'
import { logger } from '../../lib/logger.js'

/** How far back "Copy <day>'s list" looks, as the browser did. */
export const LOOKBACK_DAYS = 14
/** A typed count is offered again for this long, then forgotten, as the browser did. */
export const ORDERS_KEEP_DAYS = 30
/** The most earlier versions of one day's list GET .../versions returns. */
export const VERSIONS_LIMIT = 50

export interface DayList {
  day: string
  vehicles: DaySave['vehicles']
  updatedAt: string | null
}

function checkDay(day: string): string {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new BadRequestError('day must be YYYY-MM-DD')
  return day
}

const toList = (day: string, row: { vehicles: unknown; updatedAt: Date } | null): DayList => ({
  day,
  vehicles: Array.isArray(row?.vehicles) ? (row.vehicles as DaySave['vehicles']) : [],
  updatedAt: row?.updatedAt.toISOString() ?? null,
})

export async function getDay(orgId: string, day: string): Promise<DayList> {
  checkDay(day)
  return readThrough(dayKey(orgId, day), DAY_TTL_S, async () => toList(day,
    await prisma.deliveryDay.findUnique({ where: { organisationId_day: { organisationId: orgId, day } }, select: { vehicles: true, updatedAt: true } })))
}

/** The calendar days from `from` to `to`, both kept ("2026-11-11", "2026-11-12"). */
export function daysBetween(from: string, to: string): string[] {
  checkDay(from); checkDay(to)
  if (from > to) throw new BadRequestError('from is after to')
  const out: string[] = []
  // Noon UTC steps whole calendar days; the keys are fleet days already, no zone to convert
  for (let t = Date.parse(`${from}T12:00:00Z`), end = Date.parse(`${to}T12:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10))
    if (out.length > MAX_RANGE_DAYS) throw new BadRequestError(`${MAX_RANGE_DAYS} days at most`)
  }
  return out
}

/**
 * Every day's list in a range, the last day included, each through its own
 * cache entry (the same one getDay reads and saveDay writes), so a range never
 * serves a list older than the day's own read would (operator, 12 Nov 2026:
 * 11 to 12 Nov must show both days in full).
 */
export async function getDays(orgId: string, from: string, to: string): Promise<DayList[]> {
  return Promise.all(daysBetween(from, to).map((day) => getDay(orgId, day)))
}

/** The words a refused emptying answers with; new-ui matches the 409, not these. */
export const EMPTY_REFUSED = 'This would remove every vehicle from the day’s list. Confirm it on the page to empty the day.'

const vehicleCount = (v: unknown) => (Array.isArray(v) ? v.length : 0)
/** JSON with object keys sorted: Postgres jsonb reorders keys, so a plain stringify would see a change in every save. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : x))

/**
 * Save a day's whole list. Two guards (operator, 20 Nov 2026: the 18 and 19 Nov
 * lists were saved empty from the range view, and nothing kept what they held):
 * - an empty list never replaces one with vehicles unless `clear` says the
 *   operator confirmed it (409 otherwise);
 * - the list a save replaces is kept first in delivery_day_versions, so a day
 *   can be put back. Keeping it is best effort: a failure is logged and the
 *   save goes on, so the list can always be saved.
 */
export async function saveDay(orgId: string, day: string, userId: string | null, body: DaySave): Promise<DayList> {
  checkDay(day)
  const prev = await prisma.deliveryDay.findUnique({
    where: { organisationId_day: { organisationId: orgId, day } },
    select: { vehicles: true, updatedById: true, updatedAt: true },
  })
  if (!body.vehicles.length && vehicleCount(prev?.vehicles) > 0 && !body.clear) throw new ConflictError(EMPTY_REFUSED)
  if (prev && vehicleCount(prev.vehicles) > 0 && stable(prev.vehicles) !== stable(body.vehicles)) {
    try {
      await prisma.deliveryDayVersion.create({
        data: {
          organisationId: orgId, day, vehicles: prev.vehicles as Prisma.InputJsonValue,
          savedById: prev.updatedById, savedAt: prev.updatedAt, replacedById: userId,
        },
      })
    } catch (err) {
      logger.error({ err, orgId, day }, 'deliveries: the replaced day list could not be kept')
    }
  }
  const vehicles = body.vehicles as unknown as Prisma.InputJsonValue
  const row = await prisma.deliveryDay.upsert({
    where: { organisationId_day: { organisationId: orgId, day } },
    create: { organisationId: orgId, day, vehicles, updatedById: userId },
    update: { vehicles, updatedById: userId },
    select: { vehicles: true, updatedAt: true },
  })
  // Stamped after the write returned: later than any read that began before it
  const list = toList(day, row)
  await keep(dayKey(orgId, day), list, DAY_TTL_S, Date.now())
  // The keyed vehicles as Planner plans (planner/keyed-plans). The list is
  // saved either way: a failed sync is logged and put right by the next save.
  try {
    await syncKeyedPlans(orgId, day, body.vehicles, userId)
  } catch (err) {
    logger.error({ err, orgId, day }, 'deliveries: keyed plans could not be synced to the Planner')
  }
  return list
}

export interface DayVersion {
  id: string
  vehicles: DaySave['vehicles']
  savedById: string | null
  savedAt: string
  replacedById: string | null
  replacedAt: string
}

/** The day's earlier lists, the latest replaced first: what each save replaced. */
export async function dayVersions(orgId: string, day: string): Promise<DayVersion[]> {
  checkDay(day)
  const rows = await prisma.deliveryDayVersion.findMany({
    where: { organisationId: orgId, day },
    orderBy: { replacedAt: 'desc' },
    take: VERSIONS_LIMIT,
    select: { id: true, vehicles: true, savedById: true, savedAt: true, replacedById: true, replacedAt: true },
  })
  return rows.map((r) => ({
    id: r.id,
    vehicles: Array.isArray(r.vehicles) ? (r.vehicles as DaySave['vehicles']) : [],
    savedById: r.savedById, savedAt: r.savedAt.toISOString(),
    replacedById: r.replacedById, replacedAt: r.replacedAt.toISOString(),
  }))
}

/** The latest earlier day with vehicles on it, within LOOKBACK_DAYS, or null. */
export async function lastDayBefore(orgId: string, before: string): Promise<DayList | null> {
  checkDay(before)
  const from = new Date(Date.parse(`${before}T00:00:00Z`) - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10)
  const rows = await prisma.deliveryDay.findMany({
    where: { organisationId: orgId, day: { gte: from, lt: before } },
    orderBy: { day: 'desc' },
    select: { day: true, vehicles: true, updatedAt: true },
  })
  const row = rows.find((r) => Array.isArray(r.vehicles) && r.vehicles.length > 0)
  return row ? toList(row.day, row) : null
}

/** { plate: "8/10" }, the last value typed for each plate within ORDERS_KEEP_DAYS. */
export async function getOrders(orgId: string, now = Date.now()): Promise<Record<string, string>> {
  const all = await readThrough(ordersKey(orgId), ORDERS_TTL_S, () => loadOrders(orgId))
  const fresh = now - ORDERS_KEEP_DAYS * 86_400_000
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v.at > fresh).map(([plate, v]) => [plate, v.text]))
}

type Stored = Record<string, { text: string; at: number }>

async function loadOrders(orgId: string): Promise<Stored> {
  const rows = await prisma.deliveryOrder.findMany({ where: { organisationId: orgId }, select: { plate: true, text: true, updatedAt: true } })
  return Object.fromEntries(rows.map((r) => [r.plate, { text: r.text, at: r.updatedAt.getTime() }]))
}

/** Keep one plate's value; an empty one forgets it. */
export async function saveOrder(orgId: string, plate: string, text: string, userId: string | null, now = Date.now()): Promise<Record<string, string>> {
  const p = plate.trim()
  if (!p) throw new BadRequestError('plate is required')
  const t = text.trim()
  if (t) {
    await prisma.deliveryOrder.upsert({
      where: { organisationId_plate: { organisationId: orgId, plate: p } },
      create: { organisationId: orgId, plate: p, text: t, updatedById: userId },
      update: { text: t, updatedById: userId },
    })
  } else {
    await prisma.deliveryOrder.deleteMany({ where: { organisationId: orgId, plate: p } })
  }
  // Write-through from Postgres as it now stands, so every process reads the same
  const stamp = Date.now()
  await keep(ordersKey(orgId), await loadOrders(orgId), ORDERS_TTL_S, stamp)
  return getOrders(orgId, now)
}
