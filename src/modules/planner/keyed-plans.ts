/**
 * Plans keyed in on the Deliveries tab (operator, 12 Nov 2026: "draw the
 * planner from delivery routes for those keyed in manually").
 *
 * Every vehicle on a day's Deliveries list with at least one stop is a Planner
 * plan for that day, source 'manual', kept in step on every save of the list:
 * stops added or taken off follow, a vehicle taken off the list (or left with
 * no stops) loses its plan. Outcomes and remarks a person marked in the
 * Planner stay on the stops that remain.
 *
 * A stop picked as a geofence is a planner customer keyed `GF:<fence id>`,
 * tied to that fence; a point pasted as coordinates is keyed
 * `PIN:<lat>,<lng>` with no fence (the Planner draws its fallback circle)
 * until someone fences it in the Planner, which this sync then keeps.
 * No fence is ever drawn or changed here.
 *
 * A sheet or a Wialon itinerary for the same plate wins: no keyed plan is made
 * beside one dated that day or the day before (a sheet's date is when it was
 * printed, the run is the next day), as the Deliveries report already reports
 * the sheet instead of the hand-listed vehicle.
 */
import type { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { LIVE_FENCE } from '../../lib/fence-archive.js'
import { plateKey } from './planner.service.js'

export const KEYED_SOURCE = 'manual'

export interface KeyedVehicle {
  key?: string
  plate: string
  vehicleIds?: string[]
  customers?: string[]
  pins?: Array<{ name?: string, lat: number, lng: number, radiusM?: number }>
}

export interface KeyedStop { code: string, name: string, lat: number, lng: number, geofenceId: string | null }

interface FenceRow { id: string, name: string, isActive: boolean, centerLat: number | null, centerLng: number | null, polygonCoords: unknown }

/** A fence's middle: a circle's centre, else the mean of its ring or line. */
export function fenceMiddle(f: Pick<FenceRow, 'centerLat' | 'centerLng' | 'polygonCoords'>): { lat: number, lng: number } | null {
  if (f.centerLat != null && f.centerLng != null) return { lat: f.centerLat, lng: f.centerLng }
  const ring = Array.isArray(f.polygonCoords) ? (f.polygonCoords as unknown[]).filter((p): p is [number, number] =>
    Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) : []
  if (!ring.length) return null
  return { lat: ring.reduce((a, p) => a + p[1], 0) / ring.length, lng: ring.reduce((a, p) => a + p[0], 0) / ring.length }
}

const pinCode = (p: { lat: number, lng: number }) => `PIN:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`

interface CustomerRow { customerCode: string, name: string, lat: number, lng: number, geofenceId: string | null }

/**
 * What a kept customer should hold for this stop, or null when it already
 * does. A point someone has since fenced in the Planner (operator, 12 Nov
 * 2026: name it, save, the fence is drawn) keeps that fence and its name: the
 * list only knows the bare point.
 */
export function customerWrite(c: CustomerRow, st: KeyedStop): Pick<KeyedStop, 'name' | 'lat' | 'lng' | 'geofenceId'> | null {
  const fenced = c.customerCode.startsWith('PIN:') && c.geofenceId != null
  const want = { name: fenced ? c.name : st.name, lat: st.lat, lng: st.lng, geofenceId: fenced ? c.geofenceId : st.geofenceId }
  return c.name !== want.name || c.lat !== want.lat || c.lng !== want.lng || c.geofenceId !== want.geofenceId ? want : null
}

/**
 * One vehicle's stops, in the order they were picked: its geofences (by name;
 * an active fence before an inactive one of the same name), then its pasted
 * points. A name no fence carries any more is left out.
 */
export function keyedStops(v: KeyedVehicle, fences: FenceRow[]): KeyedStop[] {
  const byName = new Map<string, FenceRow>()
  for (const f of fences) {
    const had = byName.get(f.name)
    if (!had || (!had.isActive && f.isActive)) byName.set(f.name, f)
  }
  const out: KeyedStop[] = []
  const seen = new Set<string>()
  for (const name of v.customers ?? []) {
    const f = byName.get(name)
    const at = f ? fenceMiddle(f) : null
    if (!f || !at || seen.has(`GF:${f.id}`)) continue
    seen.add(`GF:${f.id}`)
    out.push({ code: `GF:${f.id}`, name: name.replace(/^menengai_(vs|fg)\s*:\s*/i, '').trim() || name, ...at, geofenceId: f.id })
  }
  for (const p of v.pins ?? []) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue
    const code = pinCode(p)
    if (seen.has(code)) continue
    seen.add(code)
    out.push({ code, name: p.name?.trim() || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, lat: p.lat, lng: p.lng, geofenceId: null })
  }
  return out
}

const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)

/**
 * Bring the day's keyed plans in step with its Deliveries list. Runs after the
 * list is saved; returns what it did.
 */
export async function syncKeyedPlans(orgId: string, day: string, vehicles: KeyedVehicle[], userId: string | null) {
  const planDate = new Date(`${day}T00:00:00Z`)
  const names = [...new Set(vehicles.flatMap((v) => v.customers ?? []))]
  const fences: FenceRow[] = names.length
    ? await prisma.geofence.findMany({
      where: { organisationId: orgId, name: { in: names }, ...LIVE_FENCE },
      select: { id: true, name: true, isActive: true, centerLat: true, centerLng: true, polygonCoords: true },
    })
    : []

  const unitIds = [...new Set(vehicles.flatMap((v) => v.vehicleIds ?? []))]
  const units = new Set(unitIds.length
    ? (await prisma.vehicle.findMany({ where: { id: { in: unitIds }, organisationId: orgId }, select: { id: true } })).map((u) => u.id)
    : [])

  let made = 0
  let updated = 0
  let removed = 0
  await prisma.$transaction(async (tx) => {
    // One sync per organisation and day at a time, so two saves never make the same plan twice
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`keyed-plans:${orgId}:${day}`}))`

    // Plans already there: the day's keyed ones, and sheets/itineraries that win
    const near = await tx.deliveryPlan.findMany({
      where: { organisationId: orgId, planDate: { gte: dayBefore(day), lte: planDate } },
      select: { id: true, plate: true, source: true, planDate: true, vehicleId: true },
    })
    const keyed = near.filter((p) => p.source === KEYED_SOURCE && p.planDate.getTime() === planDate.getTime())
    const sheeted = new Set(near.filter((p) => p.source !== KEYED_SOURCE).map((p) => plateKey(p.plate)))
    const want = new Map<string, { v: KeyedVehicle, stops: KeyedStop[] }>()
    for (const v of vehicles) {
      const k = plateKey(v.plate)
      if (!k || sheeted.has(k) || want.has(k)) continue
      const stops = keyedStops(v, fences)
      if (stops.length) want.set(k, { v, stops })
    }

    // Taken off the list, left with no stops, or a sheet came in for it
    const gone = keyed.filter((p) => !want.has(plateKey(p.plate)))
    if (gone.length) {
      await tx.deliveryPlan.deleteMany({ where: { id: { in: gone.map((p) => p.id) } } })
      removed = gone.length
    }

    // The customers the plans need: created when new, written only when changed
    const all = new Map<string, KeyedStop>()
    for (const { stops } of want.values()) for (const st of stops) all.set(st.code, st)
    const had = all.size
      ? await tx.plannerCustomer.findMany({
        where: { organisationId: orgId, customerCode: { in: [...all.keys()] } },
        select: { id: true, customerCode: true, name: true, lat: true, lng: true, geofenceId: true },
      })
      : []
    const ids = new Map<string, string>()
    for (const c of had) {
      ids.set(c.customerCode, c.id)
      const data = customerWrite(c, all.get(c.customerCode)!)
      if (data) await tx.plannerCustomer.update({ where: { id: c.id }, data })
    }
    for (const st of all.values()) {
      if (ids.has(st.code)) continue
      const row = await tx.plannerCustomer.create({
        data: { organisationId: orgId, customerCode: st.code, name: st.name, lat: st.lat, lng: st.lng, geofenceId: st.geofenceId },
        select: { id: true },
      })
      ids.set(st.code, row.id)
    }

    const priorStops = keyed.length
      ? await tx.deliveryPlanStop.findMany({
        where: { planId: { in: keyed.map((p) => p.id) } },
        orderBy: { sequence: 'asc' },
        select: { planId: true, customerId: true, outcome: true, remarks: true, outcomeBy: true, outcomeAt: true, dueDay: true },
      })
      : []

    for (const [k, { v, stops }] of want) {
      const vehicleId = (v.vehicleIds ?? []).find((id) => units.has(id)) ?? null
      const plate = v.plate.trim()
      const prior = keyed.find((p) => plateKey(p.plate) === k) ?? null
      const kept = prior ? priorStops.filter((x) => x.planId === prior.id) : []
      const order = stops.map((st) => ids.get(st.code)!)
      // Unchanged: left alone, so its stops keep their ids (a stop open in the Planner stays valid)
      if (prior && prior.plate === plate && prior.vehicleId === vehicleId
        && kept.length === order.length && kept.every((x, i) => x.customerId === order[i])) continue

      const data = { vehicleId, plate, planDate, source: KEYED_SOURCE, sourceFile: '' } satisfies Prisma.DeliveryPlanUncheckedUpdateInput
      const plan = prior
        ? await tx.deliveryPlan.update({ where: { id: prior.id }, data, select: { id: true } })
        : await tx.deliveryPlan.create({ data: { ...data, organisationId: orgId, createdById: userId }, select: { id: true } })
      if (prior) await tx.deliveryPlanStop.deleteMany({ where: { planId: plan.id } })
      await tx.deliveryPlanStop.createMany({
        data: order.map((customerId, i) => {
          const was = kept.find((x) => x.customerId === customerId)
          return {
            planId: plan.id, sequence: i + 1, customerId,
            outcome: was?.outcome ?? null, remarks: was?.remarks ?? '',
            outcomeBy: was?.outcomeBy ?? null, outcomeAt: was?.outcomeAt ?? null, dueDay: was?.dueDay ?? null,
          }
        }),
      })
      if (prior) updated += 1
      else made += 1
    }
  }, { timeout: 30_000 })
  return { made, updated, removed }
}
