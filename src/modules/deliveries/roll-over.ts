/**
 * Unfinished deliveries roll over to the next day (operator, 12 Nov 2026:
 * "for the deliveries which are not complete, are to automatically rolled out
 * for the next day").
 *
 * After a fleet day ends (00:00 Nairobi, plus SETTLE_MS for trackers still
 * sending), each vehicle's stops on that day's Deliveries list that were not
 * done are added to the next day's list for the same plate:
 *   - a geofence stop is done when the vehicle came inside the fence or within
 *     REACH_M of its edge at any time that day, as the report judges it
 *     (deliveriesReport PASS_COUNTS, PASS_RADIUS_M);
 *   - a pasted point is done when the vehicle came within its radius (at least
 *     REACH_M) of it;
 *   - a stop with an outcome marked on its Planner plan (Full, Partly,
 *     Rejected) is done whatever the tracker says.
 * A name no fence carries any more is dropped, as the Planner drops it.
 *
 * Each day is claimed once (`delivery_days.rolled_at`), so a stop the office
 * takes off the next day's list is never put back, and two API processes
 * never both roll it. Only the day just ended is rolled: a day missed while
 * the server was down for longer is left as it was.
 *
 * The carried stops go first on the vehicle's list (they were due already) and
 * are named in `carried`, with `carriedFrom`, for the Deliveries tab to show.
 * Saving goes through saveDay, so the cache and the keyed Planner plans follow.
 */
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { plateKey } from '../planner/planner.service.js'
import { KEYED_SOURCE } from '../planner/keyed-plans.js'
import { saveDay } from './deliveries.service.js'
import type { DaySave } from './deliveries.schema.js'

const HOUR = 3_600_000
const DAY_MS = 24 * HOUR
/** Fleet time is Nairobi, UTC+3, as new-ui's lib/fleetReports. */
const OFFSET = 3 * HOUR
/** Inside a fence or this close to its edge counts as reached (new-ui PASS_RADIUS_M). */
export const REACH_M = 100
/** Wait this long after midnight: trackers send late fixes in a backlog. */
export const SETTLE_MS = 30 * 60_000
export const CHECK_MS = 10 * 60_000

type Vehicle = DaySave['vehicles'][number]
type Pin = NonNullable<Vehicle['pins']>[number]

export const fleetDay = (ms: number) => new Date(ms + OFFSET).toISOString().slice(0, 10)
export const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00Z`) - OFFSET
export const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
const dayBeforeOf = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
const pinCode = (p: { lat: number, lng: number }) => `PIN:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
const pinWords = (p: Pin) => p.name?.trim() || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`

/** One vehicle's stops not done on its day. */
export interface Leftover { v: Vehicle, customers: string[], pins: Pin[] }

/**
 * The next day's list with the leftovers added (pure). A plate already on it
 * gets the carried stops it does not have yet, first; a plate not on it is
 * added with only those. Nothing already on the list is changed or dropped.
 */
export function mergeLeftovers(next: Vehicle[], left: Leftover[], from: string): Vehicle[] {
  const out: Vehicle[] = next.map((v) => ({ ...v }))
  for (const l of left) {
    if (!l.customers.length && !l.pins.length) continue
    const k = plateKey(l.v.plate)
    let i = out.findIndex((v) => plateKey(v.plate) === k)
    if (i < 0) {
      out.push({
        key: l.v.key, plate: l.v.plate, vehicleIds: l.v.vehicleIds ?? [], customers: [],
        ...(l.v.group ? { group: l.v.group } : {}),
      })
      i = out.length - 1
    }
    const t = out[i]!
    const names = l.customers.filter((n) => !t.customers.includes(n))
    const had = new Set((t.pins ?? []).map(pinCode))
    const pins = l.pins.filter((p) => !had.has(pinCode(p)))
    if (!names.length && !pins.length) continue
    out[i] = {
      ...t,
      customers: [...names, ...t.customers],
      ...(pins.length || t.pins ? { pins: [...pins, ...(t.pins ?? [])] } : {}),
      carried: [...new Set([...(t.carried ?? []), ...names, ...pins.map(pinWords)])],
      carriedFrom: from,
    }
  }
  return out
}

/** Of these fences and points, the ones the units came to in [from, to). */
async function reached(unitIds: string[], fenceIds: string[], pins: Pin[], from: Date, to: Date) {
  const fences = new Set<string>()
  const points = new Set<number>()
  if (!unitIds.length) return { fences, points }
  if (fenceIds.length) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      WITH pts AS MATERIALIZED (
        SELECT ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography AS g
          FROM vehicle_telemetries
         WHERE vehicle_id = ANY(${unitIds}::text[])
           AND captured_at >= ${from} AND captured_at < ${to}
           AND lat IS NOT NULL AND lng IS NOT NULL)
      SELECT f.id FROM geofences f
       WHERE f.id = ANY(${fenceIds}::text[]) AND f.geom IS NOT NULL
         AND EXISTS (SELECT 1 FROM pts WHERE ST_DWithin(f.geom, pts.g, ${REACH_M}))`
    for (const r of rows) fences.add(r.id)
  }
  if (pins.length) {
    const rows = await prisma.$queryRaw<Array<{ i: bigint | number }>>`
      WITH pts AS MATERIALIZED (
        SELECT ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography AS g
          FROM vehicle_telemetries
         WHERE vehicle_id = ANY(${unitIds}::text[])
           AND captured_at >= ${from} AND captured_at < ${to}
           AND lat IS NOT NULL AND lng IS NOT NULL)
      SELECT p.i FROM unnest(${pins.map((p) => p.lat)}::float8[], ${pins.map((p) => p.lng)}::float8[], ${pins.map((p) => p.radiusM)}::float8[])
             WITH ORDINALITY AS p(lat, lng, r, i)
       WHERE EXISTS (SELECT 1 FROM pts WHERE ST_DWithin(ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography, pts.g, GREATEST(p.r, ${REACH_M})))`
    for (const r of rows) points.add(Number(r.i) - 1)
  }
  return { fences, points }
}

/** Each vehicle's stops on `day`'s list that were not done that day. */
export async function leftoversOf(orgId: string, day: string, vehicles: Vehicle[]): Promise<Leftover[]> {
  const from = new Date(dayStartMs(day))
  const to = new Date(dayStartMs(day) + DAY_MS)
  const names = [...new Set(vehicles.flatMap((v) => v.customers ?? []))]
  const fenceRows = names.length
    ? await prisma.geofence.findMany({ where: { organisationId: orgId, name: { in: names } }, select: { id: true, name: true, isActive: true } })
    : []
  const byName = new Map<string, { id: string, isActive: boolean }>()
  for (const f of fenceRows) {
    const had = byName.get(f.name)
    if (!had || (!had.isActive && f.isActive)) byName.set(f.name, f)
  }
  // Stops someone marked on the day's keyed Planner plans
  const plans = await prisma.deliveryPlan.findMany({
    where: { organisationId: orgId, source: KEYED_SOURCE, planDate: new Date(`${day}T00:00:00Z`) },
    select: { plate: true, stops: { where: { outcome: { not: null } }, select: { customer: { select: { customerCode: true } } } } },
  })
  const marked = new Map(plans.map((p) => [plateKey(p.plate), new Set(p.stops.map((s) => s.customer.customerCode))]))
  // Units for a vehicle listed without them, by plate
  const needPlates = vehicles.some((v) => !(v.vehicleIds ?? []).length)
  const units = needPlates
    ? await prisma.vehicle.findMany({ where: { organisationId: orgId }, select: { id: true, registrationPlate: true } })
    : []

  const out: Leftover[] = []
  for (const v of vehicles) {
    const k = plateKey(v.plate)
    const done = marked.get(k) ?? new Set<string>()
    const unitIds = (v.vehicleIds ?? []).length ? v.vehicleIds : units.filter((u) => plateKey(u.registrationPlate) === k).map((u) => u.id)
    const stops = (v.customers ?? []).map((name) => ({ name, fence: byName.get(name) })).filter((s): s is { name: string, fence: { id: string, isActive: boolean } } => Boolean(s.fence))
    const pins = v.pins ?? []
    if (!stops.length && !pins.length) continue
    const got = await reached(unitIds, [...new Set(stops.map((s) => s.fence.id))], pins, from, to)
    const customers = stops.filter((s) => !got.fences.has(s.fence.id) && !done.has(`GF:${s.fence.id}`)).map((s) => s.name)
    const leftPins = pins.filter((p, i) => !got.points.has(i) && !done.has(pinCode(p)))
    if (customers.length || leftPins.length) out.push({ v, customers, pins: leftPins })
  }
  return out
}

/** Roll one organisation's `day` onto the next day, once. Returns the number of stops carried, or null when it was claimed already. */
export async function rollDay(orgId: string, day: string): Promise<number | null> {
  // Claim the day: the one process whose update finds rolled_at empty does it (updated_at is left alone)
  const claimed = await prisma.$queryRaw<Array<{ vehicles: unknown }>>`
    UPDATE delivery_days SET rolled_at = now()
     WHERE organisation_id = ${orgId} AND day = ${day} AND rolled_at IS NULL
    RETURNING vehicles`
  if (!claimed.length) return null
  try {
    const vehicles = Array.isArray(claimed[0]!.vehicles) ? (claimed[0]!.vehicles as Vehicle[]) : []
    const left = await leftoversOf(orgId, day, vehicles)
    const carried = left.reduce((a, l) => a + l.customers.length + l.pins.length, 0)
    if (!carried) return 0
    const next = dayAfter(day)
    const row = await prisma.deliveryDay.findUnique({ where: { organisationId_day: { organisationId: orgId, day: next } }, select: { vehicles: true } })
    const have = Array.isArray(row?.vehicles) ? (row.vehicles as Vehicle[]) : []
    await saveDay(orgId, next, null, { vehicles: mergeLeftovers(have, left, day) })
    logger.info({ orgId, day, next, vehicles: left.length, stops: carried }, 'deliveries: unfinished stops carried to the next day')
    return carried
  } catch (err) {
    // Let the next check try again
    await prisma.$executeRaw`UPDATE delivery_days SET rolled_at = NULL WHERE organisation_id = ${orgId} AND day = ${day}`
    throw err
  }
}

/** Roll every organisation's list for the day just ended, once it has settled. */
export async function rollOver(now = Date.now()) {
  const today = fleetDay(now)
  if (now < dayStartMs(today) + SETTLE_MS) return
  const day = dayBeforeOf(today)
  const rows = await prisma.deliveryDay.findMany({ where: { day, rolledAt: null }, select: { organisationId: true } })
  for (const r of rows) {
    try {
      await rollDay(r.organisationId, day)
    } catch (err) {
      logger.error({ err, orgId: r.organisationId, day }, 'deliveries: unfinished stops could not be carried over')
    }
  }
}

export function startDeliveryRollOver(): () => void {
  let live = true
  let timer: NodeJS.Timeout | null = null
  const tick = async () => {
    try {
      await rollOver()
    } catch (err) {
      logger.warn({ err }, 'deliveries: roll-over check failed')
    } finally {
      if (live) { timer = setTimeout(tick, CHECK_MS); timer.unref?.() }
    }
  }
  timer = setTimeout(tick, 60_000)
  timer.unref?.()
  return () => { live = false; if (timer) clearTimeout(timer) }
}
