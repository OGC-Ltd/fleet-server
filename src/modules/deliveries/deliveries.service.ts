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
import { BadRequestError } from '../../core/errors/errors.js'
import { DAY_RE, type DaySave } from './deliveries.schema.js'
import { readThrough, keep, dayKey, ordersKey, DAY_TTL_S, ORDERS_TTL_S } from './delivery-days.cache.js'

/** How far back "Copy <day>'s list" looks, as the browser did. */
export const LOOKBACK_DAYS = 14
/** A typed count is offered again for this long, then forgotten, as the browser did. */
export const ORDERS_KEEP_DAYS = 30

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

export async function saveDay(orgId: string, day: string, userId: string | null, body: DaySave): Promise<DayList> {
  checkDay(day)
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
  return list
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
