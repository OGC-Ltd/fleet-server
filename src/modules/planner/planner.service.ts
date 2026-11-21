/**
 * Planner (operator, 2026-11-11): a truck's delivery sheet for a day, uploaded
 * as Menengai's sales system prints it.
 *
 * Every customer on a sheet is kept by its CUSTOMER ID with a geofence: an
 * existing one where the organisation already has it (fence-match.ts: by name
 * near the point, never by place alone, or the one a person picked on the
 * preview), else a 100 m circle at the sheet's coordinates, named
 * after the customer, and reused by every later sheet. A person may redraw it
 * on the page (the ordinary geofence editor); nothing here ever reshapes a
 * fence once drawn. A customer whose sheet point moves more than 100 m keeps
 * its fence and is flagged, since one bad pin should not move a shop.
 *
 * The fences are purpose `shop`: they count for containment (a truck standing
 * at a customer is not "stopped outside known zones") but are never narrated
 * in the live feed, like Menengai's VS shops.
 *
 * Plan against actual is worked out on the page from the truck's track, as
 * the Deliveries report does; the server keeps the plan and the outcome a
 * person marks on each stop.
 */
import { prisma } from '../../lib/prisma.js'
import { LIVE_FENCE } from '../../lib/fence-archive.js'
import { invalidateZoneCache } from '../../lib/zone-presence.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors/errors.js'
import { readDeliverySheet, type DeliverySheet, type SheetStop } from './sheet.js'
import type { SaveSheet, PlanListQuery, StopUpdate, CustomerFence } from './planner.schema.js'
import { fencePicks, type FencePick } from './fence-match.js'
import type { PlannedStop } from './itinerary.js'
import { cachedPlace, reverseGeocode } from '../../lib/geocode.js'
import { geocodeAddress } from './address-geocode.js'
import type { SheetProblem } from './sheet.js'

/**
 * Itinerary stops Wialon exported with a written address and no point
 * ("C35, Londiani, Kenya"): placed by geocoding it (address-geocode.ts),
 * unless the customer is already known, whose kept point wins. A road or
 * area answer is marked `approx` and said in the problems so a person checks
 * the fence; one nothing places is left for a point on the preview.
 */
export async function locateStops<T extends Pick<SheetStop, 'lat' | 'lng' | 'address' | 'located' | 'customerCode' | 'customerName' | 'row'>>(
  orgId: string, stops: T[],
): Promise<{ stops: T[], problems: SheetProblem[] }> {
  const want = stops.filter((s) => (s.lat == null || s.lng == null) && s.address)
  if (!want.length) return { stops, problems: [] }
  const known = new Set((await prisma.plannerCustomer.findMany({
    where: { organisationId: orgId, customerCode: { in: [...new Set(want.map((s) => s.customerCode))] } },
    select: { customerCode: true },
  })).map((c) => c.customerCode))
  const problems: SheetProblem[] = []
  const out: T[] = []
  for (const s of stops) {
    if ((s.lat != null && s.lng != null) || !s.address || known.has(s.customerCode)) { out.push(s); continue }
    const got = await geocodeAddress(s.address)
    if (!got) {
      problems.push({ row: s.row, message: `${s.customerName}: "${s.address}" could not be placed; add its point.` })
      out.push(s)
      continue
    }
    if (!got.exact) problems.push({ row: s.row, message: `${s.customerName}: placed from "${s.address}", which is a road or area, not the shop; check its fence.` })
    out.push({ ...s, lat: got.lat, lng: got.lng, located: got.exact ? 'address' : 'approx' })
  }
  return { stops: out, problems }
}

/** How long a preview waits for place names; the save waits longer, as it stores them. */
export const PREVIEW_PLACES_MS = 6_000
export const SAVE_PLACES_MS = 30_000

const pointWords = (lat: number, lng: number) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`

/**
 * An itinerary names no LOCATION, so each stop's is the place at its
 * coordinates (lib/geocode: cached, about one lookup a second), or the
 * coordinates themselves when no name comes back within `waitMs`.
 * A sales sheet's own LOCATION is kept as written.
 */
export async function placeStops<T extends Pick<SheetStop, 'lat' | 'lng' | 'location'>>(
  stops: T[], itinerary: boolean, waitMs: number,
): Promise<T[]> {
  if (!itinerary) return stops
  const named = new Map<string, string | null>()
  const lookups: Promise<void>[] = []
  for (const s of stops) {
    if (s.location || s.lat == null || s.lng == null) continue
    const k = `${s.lat},${s.lng}`
    if (named.has(k)) continue
    named.set(k, cachedPlace(s.lat, s.lng))
    if (named.get(k) == null) {
      const { lat, lng } = s
      lookups.push(reverseGeocode(lat, lng).then((p) => { named.set(k, p) }, () => {}))
    }
  }
  if (lookups.length) await Promise.race([Promise.all(lookups), new Promise((r) => setTimeout(r, waitMs))])
  return stops.map((s) => (s.location || s.lat == null || s.lng == null ? s
    : { ...s, location: named.get(`${s.lat},${s.lng}`) || pointWords(s.lat, s.lng) }))
}

/** A new customer's circle. */
export const CUSTOMER_RADIUS_M = 100
/** A sheet point this far from the kept one is a move, flagged, not followed. */
export const MOVED_M = 100

export const plateKey = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

export function metres(a: { lat: number, lng: number }, b: { lat: number, lng: number }): number {
  const R = 6_371_000
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function readFile(data: string): DeliverySheet {
  let buf: Buffer
  try { buf = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64') } catch { throw new BadRequestError('The file could not be read.') }
  if (buf.length > 2_100_000) throw new BadRequestError('The file is over 2 MB.')
  try { return readDeliverySheet(buf) } catch { throw new BadRequestError('This is not an Excel workbook the Planner can read.') }
}

/** The unit carrying a plate, by its registration or its name. */
async function vehicleFor(orgId: string, plate: string) {
  const k = plateKey(plate)
  if (!k) return null
  const units = await prisma.vehicle.findMany({
    where: { organisationId: orgId },
    select: { id: true, registrationPlate: true, name: true },
  })
  return units.find((u) => plateKey(u.registrationPlate) === k)
    ?? units.find((u) => plateKey(u.name).endsWith(k))
    ?? null
}

async function driverFor(orgId: string, name: string) {
  if (!name.trim()) return null
  return prisma.user.findFirst({
    where: { organisationId: orgId, fullName: { equals: name.trim(), mode: 'insensitive' } },
    select: { id: true, fullName: true },
  })
}

export type CustomerState = 'new' | 'known' | 'moved' | 'no_point'

interface Known { id: string, customerCode: string, lat: number, lng: number, geofenceId: string | null, name: string }

/** What saving would do to one customer line. */
export function customerState(stop: Pick<SheetStop, 'lat' | 'lng'>, known: Known | undefined, fenceExists: boolean): { state: CustomerState, movedM: number | null, drawsFence: boolean } {
  if (!known) {
    if (stop.lat == null || stop.lng == null) return { state: 'no_point', movedM: null, drawsFence: false }
    return { state: 'new', movedM: null, drawsFence: true }
  }
  const drawsFence = !known.geofenceId || !fenceExists
  if (stop.lat == null || stop.lng == null) return { state: 'known', movedM: null, drawsFence }
  const m = metres(known, { lat: stop.lat, lng: stop.lng })
  return m > MOVED_M ? { state: 'moved', movedM: Math.round(m), drawsFence } : { state: 'known', movedM: null, drawsFence }
}

async function knownCustomers(orgId: string, codes: string[]) {
  const rows = await prisma.plannerCustomer.findMany({
    where: { organisationId: orgId, customerCode: { in: codes } },
    select: { id: true, customerCode: true, lat: true, lng: true, geofenceId: true, name: true },
  })
  const fenceIds = rows.map((r) => r.geofenceId).filter((x): x is string => Boolean(x))
  const fences = fenceIds.length
    ? await prisma.geofence.findMany({ where: { id: { in: fenceIds }, organisationId: orgId, ...LIVE_FENCE }, select: { id: true, name: true } })
    : []
  return {
    byCode: new Map(rows.map((r) => [r.customerCode, r])),
    fenceName: new Map(fences.map((f) => [f.id, f.name])),
  }
}

/** What a sheet holds, and what saving it would do. Writes nothing. */
export async function previewSheet(orgId: string, fileName: string, data: string) {
  const read = readFile(data)
  const located = await locateStops(orgId, read.stops)
  const sheet = { ...read, problems: [...read.problems, ...located.problems], stops: await placeStops(located.stops, Boolean(read.route), PREVIEW_PLACES_MS) }
  const [vehicle, driver, known] = await Promise.all([
    vehicleFor(orgId, sheet.header.plate),
    driverFor(orgId, sheet.header.driverName),
    knownCustomers(orgId, [...new Set(sheet.stops.map((s) => s.customerCode))]),
  ])
  const existing = sheet.header.planDate
    ? await prisma.deliveryPlan.findMany({
      where: { organisationId: orgId, planDate: new Date(`${sheet.header.planDate}T00:00:00Z`) },
      select: { id: true, plate: true },
    })
    : []
  const replaces = existing.find((p) => plateKey(p.plate) === plateKey(sheet.header.plate)) ?? null
  const picks = await picksFor(orgId, sheet.stops, known)
  return {
    fileName,
    header: sheet.header,
    source: sheet.route ? 'itinerary' : 'sheet',
    route: sheet.route ?? null,
    vehicle: vehicle ? { id: vehicle.id, plate: vehicle.registrationPlate, name: vehicle.name } : null,
    driver,
    replacesPlanId: replaces?.id ?? null,
    problems: sheet.problems,
    stops: sheet.stops.map((s) => {
      const k = known.byCode.get(s.customerCode)
      const fenceName = k?.geofenceId ? known.fenceName.get(k.geofenceId) ?? null : null
      const st = customerState(s, k, fenceName != null)
      const pick = st.drawsFence ? picks.get(s.customerCode) ?? null : null
      return {
        ...s, ...st,
        // An existing fence taken instead of drawing one
        drawsFence: st.drawsFence && !pick?.match,
        fenceMatch: pick?.match ?? null,
        fenceOptions: pick?.options ?? [],
        customerId: k?.id ?? null,
        fenceName: fenceName ?? pick?.match?.name ?? null,
        keptPoint: k ? { lat: k.lat, lng: k.lng } : null,
      }
    }),
  }
}

/** The existing fences near each customer that has none, one look per customer code. */
async function picksFor(
  orgId: string,
  stops: Array<Pick<SheetStop, 'customerCode' | 'customerName' | 'lat' | 'lng'>>,
  known: Awaited<ReturnType<typeof knownCustomers>>,
): Promise<Map<string, FencePick>> {
  const wants = new Map<string, { code: string, name: string, lat: number, lng: number }>()
  for (const s of stops) {
    if (wants.has(s.customerCode)) continue
    const k = known.byCode.get(s.customerCode)
    if (k?.geofenceId && known.fenceName.has(k.geofenceId)) continue
    const at = k ? { lat: k.lat, lng: k.lng } : s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null
    if (at) wants.set(s.customerCode, { code: s.customerCode, name: s.customerName, ...at })
  }
  return wants.size ? fencePicks(orgId, [...wants.values()]) : new Map()
}

/**
 * Save a sheet: customers kept or added, fences drawn where a customer has
 * none, and the plan with its lines. The same plate on the same day replaces
 * that plan's lines, keeping any outcome already marked on the same customer
 * and invoice.
 */
export async function saveSheet(orgId: string, userId: string | null, body: SaveSheet) {
  const sheet = readFile(body.data)
  const plate = body.plate ?? sheet.header.plate
  const planDate = body.planDate ?? sheet.header.planDate
  if (!plate) throw new BadRequestError(sheet.route ? 'The itinerary names no truck; enter the plate.' : 'The sheet has no Truck Number; enter the plate.')
  if (!planDate) throw new BadRequestError(sheet.route ? 'The itinerary has no run dates; enter the day.' : 'The sheet has no Date; enter the day.')
  if (!sheet.stops.length) throw new BadRequestError(sheet.route ? 'The itinerary lists no stops.' : 'The sheet lists no customers.')

  const stops = await placeStops((await locateStops(orgId, sheet.stops.map((s) => {
    const p = body.points?.[s.customerCode]
    return p ? { ...s, lat: p.lat, lng: p.lng, located: undefined } : s
  }))).stops, Boolean(sheet.route), SAVE_PLACES_MS)
  const codes = [...new Set(stops.map((s) => s.customerCode))]
  const known = await knownCustomers(orgId, codes)
  const missing = stops.filter((s) => (s.lat == null || s.lng == null) && !known.byCode.has(s.customerCode))
  if (missing.length) {
    throw new BadRequestError(`No coordinates for ${missing.map((s) => s.customerName).join(', ')}. Add a point for each before saving.`)
  }

  const driverName = body.driverName ?? sheet.header.driverName
  const [vehicle, driver] = await Promise.all([
    body.vehicleId !== undefined
      ? (body.vehicleId ? prisma.vehicle.findFirst({ where: { id: body.vehicleId, organisationId: orgId }, select: { id: true } }) : null)
      : vehicleFor(orgId, plate),
    driverFor(orgId, driverName),
  ])
  const day = new Date(`${planDate}T00:00:00Z`)

  // A fence for each customer that has none: the one the person chose on the
  // preview, else the existing fence the preview matched, else a new circle
  const chosen = Object.entries(body.fences ?? {}).filter(([, v]) => v !== 'new').map(([, v]) => v)
  const chosenOk = new Set(chosen.length
    ? (await prisma.geofence.findMany({ where: { id: { in: chosen }, organisationId: orgId, ...LIVE_FENCE }, select: { id: true } })).map((f) => f.id)
    : [])
  const undecided = stops.filter((s) => !body.fences?.[s.customerCode])
  const picks = await picksFor(orgId, undecided, known)
  const existingFor = (code: string): string | null => {
    const c = body.fences?.[code]
    if (c === 'new') return null
    if (c) {
      if (!chosenOk.has(c)) throw new BadRequestError('A geofence chosen on the preview no longer exists; read the sheet again.')
      return c
    }
    return picks.get(code)?.match?.id ?? null
  }

  const result = await prisma.$transaction(async (tx) => {
    let fencesDrawn = 0
    let fencesReused = 0
    let customersAdded = 0
    const moved: Array<{ customerCode: string, name: string, movedM: number }> = []
    const idOf = new Map<string, string>()

    // One line per customer code: the first line's name, location and point
    for (const code of codes) {
      const s = stops.find((x) => x.customerCode === code)!
      const k = known.byCode.get(code)
      const fenceOk = Boolean(k?.geofenceId && known.fenceName.has(k.geofenceId))
      const st = customerState(s, k, fenceOk)
      if (st.state === 'moved') moved.push({ customerCode: code, name: s.customerName, movedM: st.movedM! })
      // A new customer's point, or a kept one's when it has none yet
      const at = k ? { lat: k.lat, lng: k.lng } : { lat: s.lat!, lng: s.lng! }
      let fenceId = fenceOk ? k!.geofenceId : null
      if (!fenceId) {
        fenceId = existingFor(code)
        if (fenceId) fencesReused += 1
      }
      if (!fenceId) {
        const f = await tx.geofence.create({
          data: {
            organisationId: orgId, name: s.customerName, type: 'CIRCLE', mode: 'ALLOWLIST',
            centerLat: at.lat, centerLng: at.lng, radiusM: CUSTOMER_RADIUS_M, purpose: 'shop',
          },
          select: { id: true },
        })
        fenceId = f.id
        fencesDrawn += 1
      }
      const row = await tx.plannerCustomer.upsert({
        where: { organisationId_customerCode: { organisationId: orgId, customerCode: code } },
        create: { organisationId: orgId, customerCode: code, name: s.customerName, location: s.location, lat: at.lat, lng: at.lng, geofenceId: fenceId },
        update: { name: s.customerName, location: s.location || undefined, geofenceId: fenceId },
        select: { id: true },
      })
      if (!k) customersAdded += 1
      idOf.set(code, row.id)
    }

    // The plan: the same plate's sheet that day is replaced, outcomes kept
    const sameDay = await tx.deliveryPlan.findMany({ where: { organisationId: orgId, planDate: day }, select: { id: true, plate: true } })
    const prior = sameDay.find((p) => plateKey(p.plate) === plateKey(plate)) ?? null
    const kept = prior
      ? await tx.deliveryPlanStop.findMany({ where: { planId: prior.id }, select: { customerId: true, invoiceNo: true, outcome: true, remarks: true, outcomeBy: true, outcomeAt: true } })
      : []
    const keptFor = (customerId: string, invoiceNo: string) =>
      kept.find((x) => x.customerId === customerId && x.invoiceNo === invoiceNo && (x.outcome || x.remarks))

    const planData = {
      vehicleId: vehicle?.id ?? null, plate, driverName, driverUserId: driver?.id ?? null, planDate: day,
      sheetAt: sheet.header.sheetAt ? new Date(sheet.header.sheetAt) : null,
      gatePass: sheet.header.gatePass, tillNo: sheet.header.tillNo, sourceFile: body.fileName ?? '',
      ...routeColumns(sheet),
    }
    const plan = prior
      ? await tx.deliveryPlan.update({ where: { id: prior.id }, data: planData, select: { id: true } })
      : await tx.deliveryPlan.create({ data: { ...planData, organisationId: orgId, createdById: userId }, select: { id: true } })
    if (prior) await tx.deliveryPlanStop.deleteMany({ where: { planId: plan.id } })
    await tx.deliveryPlanStop.createMany({
      data: stops.map((s, i) => {
        const customerId = idOf.get(s.customerCode)!
        const was = keptFor(customerId, s.invoiceNo)
        return {
          planId: plan.id, sequence: i + 1, rep: s.rep, customerId, invoiceNo: s.invoiceNo,
          amount: s.amount, tonnage: s.tonnage,
          outcome: was?.outcome ?? s.outcome, remarks: was?.remarks || s.remarks,
          outcomeBy: was?.outcomeBy ?? null, outcomeAt: was?.outcomeAt ?? null,
          ...plannedColumns(s.planned),
        }
      }),
    })
    return { planId: plan.id, replaced: Boolean(prior), fencesDrawn, fencesReused, customersAdded, moved }
  }, { timeout: 30_000 })

  if (result.fencesDrawn) invalidateZoneCache(orgId)
  return result
}

const num = (d: unknown) => (d == null ? null : Number(d))

/** A plan's itinerary columns; a sales sheet sets them back to empty. */
export function routeColumns(sheet: Pick<DeliverySheet, 'route'>) {
  const r = sheet.route
  return {
    source: r ? 'itinerary' : 'sheet',
    routeName: r?.name ?? '',
    plannedStart: r?.start ? new Date(r.start) : null,
    plannedEnd: r?.end ? new Date(r.end) : null,
    plannedKm: r?.km ?? null,
    homeName: r?.home?.name ?? '',
    homeLat: r?.home?.lat ?? null,
    homeLng: r?.home?.lng ?? null,
  }
}

export function plannedColumns(p: PlannedStop | undefined) {
  return {
    plannedAt: p?.at ? new Date(p.at) : null,
    windowFrom: p?.windowFrom ?? null,
    windowTo: p?.windowTo ?? null,
    serviceMin: p?.serviceMin ?? null,
    legKm: p?.legKm ?? null,
  }
}

export async function listPlans(orgId: string, q: PlanListQuery) {
  const plans = await prisma.deliveryPlan.findMany({
    where: { organisationId: orgId, planDate: { gte: new Date(`${q.from}T00:00:00Z`), lte: new Date(`${q.to}T00:00:00Z`) } },
    orderBy: [{ planDate: 'desc' }, { plate: 'asc' }],
    include: { stops: { select: { amount: true, tonnage: true, outcome: true } } },
  })
  return plans.map(({ stops, ...p }) => ({
    ...p,
    planDate: p.planDate.toISOString().slice(0, 10),
    stopCount: stops.length,
    amount: stops.reduce((a, s) => a + (num(s.amount) ?? 0), 0),
    tonnage: Math.round(stops.reduce((a, s) => a + (num(s.tonnage) ?? 0), 0) * 1000) / 1000,
    outcomes: {
      FULL: stops.filter((s) => s.outcome === 'FULL').length,
      PARTLY: stops.filter((s) => s.outcome === 'PARTLY').length,
      REJECTED: stops.filter((s) => s.outcome === 'REJECTED').length,
      open: stops.filter((s) => !s.outcome).length,
    },
  }))
}

export async function getPlan(orgId: string, id: string) {
  const plan = await prisma.deliveryPlan.findFirst({
    where: { id, organisationId: orgId },
    include: { stops: { orderBy: { sequence: 'asc' }, include: { customer: true } } },
  })
  if (!plan) throw new NotFoundError('Plan not found')
  const vehicle = plan.vehicleId
    ? await prisma.vehicle.findFirst({ where: { id: plan.vehicleId }, select: { id: true, registrationPlate: true, name: true } })
    : null
  return {
    ...plan,
    planDate: plan.planDate.toISOString().slice(0, 10),
    vehicle,
    stops: plan.stops.map((s) => ({
      ...s,
      amount: num(s.amount),
      tonnage: num(s.tonnage),
      customer: {
        id: s.customer.id, code: s.customer.customerCode, name: s.customer.name, location: s.customer.location,
        lat: s.customer.lat, lng: s.customer.lng, geofenceId: s.customer.geofenceId,
      },
    })),
  }
}

export async function updateStop(orgId: string, planId: string, stopId: string, userId: string | null, body: StopUpdate) {
  const stop = await prisma.deliveryPlanStop.findFirst({ where: { id: stopId, planId, plan: { organisationId: orgId } }, select: { id: true } })
  if (!stop) throw new NotFoundError('Stop not found')
  const marking = body.outcome !== undefined
  const row = await prisma.deliveryPlanStop.update({
    where: { id: stopId },
    data: {
      ...(marking ? { outcome: body.outcome, outcomeBy: body.outcome ? userId : null, outcomeAt: body.outcome ? new Date() : null } : {}),
      ...(body.remarks !== undefined ? { remarks: body.remarks } : {}),
      ...(body.dueDay !== undefined ? { dueDay: body.dueDay } : {}),
    },
  })
  return { ...row, amount: num(row.amount), tonnage: num(row.tonnage) }
}

/**
 * Move a sheet between the Deliveries reports (operator, 2026-11-21: "swap a
 * planner from FG to VS and vice versa"): 'vs', 'fg', or null to go back to
 * its truck's fleet group.
 */
export async function setPlanList(orgId: string, id: string, list: 'vs' | 'fg' | null) {
  const plan = await prisma.deliveryPlan.findFirst({ where: { id, organisationId: orgId }, select: { id: true } })
  if (!plan) throw new NotFoundError('Plan not found')
  const row = await prisma.deliveryPlan.update({ where: { id }, data: { list }, select: { id: true, list: true } })
  return row
}

export async function removePlan(orgId: string, id: string) {
  const plan = await prisma.deliveryPlan.findFirst({ where: { id, organisationId: orgId }, select: { id: true } })
  if (!plan) throw new NotFoundError('Plan not found')
  await prisma.deliveryPlan.delete({ where: { id } })
}

/**
 * A fence for a customer that has none (operator, 12 Nov 2026): a stop keyed
 * in on Deliveries as bare coordinates, or one whose fence was deleted. A
 * circle where the person says, named as they say; a point-only customer
 * takes that name too, as its name was only its coordinates.
 */
export async function fenceCustomer(orgId: string, customerId: string, body: CustomerFence) {
  const c = await prisma.plannerCustomer.findFirst({
    where: { id: customerId, organisationId: orgId },
    select: { id: true, customerCode: true, geofenceId: true },
  })
  if (!c) throw new NotFoundError('Customer not found')
  // An archived fence counts as gone: the customer is fenced again here.
  if (c.geofenceId && await prisma.geofence.findFirst({ where: { id: c.geofenceId, organisationId: orgId, ...LIVE_FENCE }, select: { id: true } })) {
    throw new ConflictError('This customer already has a geofence; redraw it on the Live Map.')
  }
  const geofence = await prisma.$transaction(async (tx) => {
    const f = await tx.geofence.create({
      data: {
        organisationId: orgId, name: body.name, type: 'CIRCLE', mode: 'ALLOWLIST',
        centerLat: body.lat, centerLng: body.lng, radiusM: body.radiusM, purpose: 'shop',
      },
      select: { id: true, name: true, centerLat: true, centerLng: true, radiusM: true },
    })
    await tx.plannerCustomer.update({
      where: { id: c.id },
      data: { geofenceId: f.id, ...(c.customerCode.startsWith('PIN:') ? { name: body.name } : {}) },
    })
    return f
  })
  invalidateZoneCache(orgId)
  return { customerId: c.id, geofence }
}

export async function listCustomers(orgId: string, q?: string, fenced = false) {
  const s = q?.trim()
  return prisma.plannerCustomer.findMany({
    where: {
      organisationId: orgId,
      ...(fenced ? { geofenceId: { not: null } } : {}),
      ...(s ? { OR: [{ name: { contains: s, mode: 'insensitive' } }, { customerCode: { contains: s } }, { location: { contains: s, mode: 'insensitive' } }] } : {}),
    },
    orderBy: { name: 'asc' },
    // Fenced points are few and Deliveries needs every one of them
    take: fenced ? 2000 : 200,
  })
}
