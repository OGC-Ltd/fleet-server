// Everything the printable trip report needs for ONE dispatch, in one answer.
//
// The report is assembled in the browser (new-ui lib/tripReport shapes it,
// lib/tripReportHtml lays it on the letterhead), so this returns the measured
// ingredients rather than a finished page: the track, the fuel probe, the
// policy breaches, the zones crossed and any weighbridge ticket, all clipped to
// the dispatch's own window. Nothing is invented — a missing probe, camera or
// destination point comes back as null or empty and the page says so.
//
// The window is departure → return (or now, while the run is open), capped at
// the last 7 days so an unclosed dispatch cannot turn into a month of fixes.
// The driver's conduct and the weighbridge tickets run from the start of the
// fleet day of departure to the END OF THE TRIP (operator, 2026-10-29): earlier
// runs that day count, a run past midnight keeps its return weighing, and
// nothing after the unit is back does.

import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { knownDestination } from '../dispatches/known-destinations.js'
import { factoryOf, bagsFromTonnes } from '../webhooks/factory-map.js'
import { arrivalRadiusM, haversineM, type Point } from '../../lib/dispatch-trip.js'
import { findZoneTimeline } from '../telemetry/telemetry.repository.js'
import { fleetDayStart } from '../../lib/provider-time.js'
import { getAlarms } from '../dashcam/dashcam.service.js'
import { tile, lon2x, lat2y } from '../usage-review/usage-review.pdf.js'
import { logger } from '../../lib/logger.js'

const MAX_WINDOW_MS = 7 * 86_400_000
/** Points sent for stops and distance; a day at one fix per 15 s is ~5,800. */
const MAX_TRACK_POINTS = 8000
const MAX_FUEL_POINTS = 500

const thin = <T>(rows: T[], max: number): T[] => {
  if (rows.length <= max) return rows
  const step = rows.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)])
  out[out.length - 1] = rows[rows.length - 1]
  return out
}

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null)

/**
 * Dashcam alarms that count as driver conduct (operator, 2026-10-29), by the
 * VSS code that raises them. Only units with a camera get these columns.
 */
const DASHCAM_CONDUCT: Record<string, number[]> = {
  seatbelt: [125, 51],     // No seat belt (driver camera), tracker seat-belt alarm
  phone:    [116],         // Phone call
  hands:    [262, 263],    // One / both hands off the wheel
}
const DASHCAM_KIND = new Map(Object.entries(DASHCAM_CONDUCT).flatMap(([k, codes]) => codes.map(c => [c, k] as const)))
/** A VSS search can queue behind another; past this the page goes without. */
const DASHCAM_WAIT_MS = 20_000

/** CANE_DELIVERY → "Cane delivery". */
const humanise = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ')

/**
 * When the ticket's load was weighed. The provider's gross clock is not always
 * trustworthy: on 28 Oct ticket 1000906522 read gross 00:57 on the 28th for a
 * truck raised at 14:12 that day and back through the gate at 00:50 on the
 * 29th (right time, wrong date). A gross before the token is impossible, so the
 * tare weighing is quoted instead, then the token itself.
 */
function weighedAt(w: { tokenAt: Date; grossAt: Date | null; tareAt: Date | null }): number {
  if (w.grossAt && w.grossAt >= w.tokenAt) return w.grossAt.getTime()
  if (w.tareAt && w.tareAt >= w.tokenAt) return w.tareAt.getTime()
  return w.tokenAt.getTime()
}

export async function getTripReportData(orgId: string, vehicleId: string, dispatchExternalId?: string) {
  const vehicle = await prisma.vehicle.findFirst({
    where:  { id: vehicleId, organisationId: orgId },
    select: { id: true, registrationPlate: true, vehicleType: true, model: true, makeModel: true,
              organisation: { select: { name: true, hubLat: true, hubLng: true } } },
  })
  if (!vehicle) throw new NotFoundError('Vehicle not found')

  const dispatch = await prisma.dispatch.findFirst({
    where:   dispatchExternalId
      ? { organisationId: orgId, vehicleId, externalId: dispatchExternalId }
      : { organisationId: orgId, vehicleId, dispatchedAt: { lte: new Date() } },
    orderBy: { dispatchedAt: 'desc' },
  })
  if (!dispatch) throw new NotFoundError('No dispatch on record for this vehicle')

  const now = Date.now()
  const end = Math.min(dispatch.actualReturnAt?.getTime() ?? now, now)
  const begin = Math.max(dispatch.dispatchedAt.getTime(), end - MAX_WINDOW_MS)
  const from = new Date(begin), to = new Date(Math.max(end, begin + 60_000))
  const dayFrom = fleetDayStart(dispatch.dispatchedAt)
  const dayTo = to

  // Where it left from and where it was going — the same anchors as the trip
  // card: the gate it was signed out at, else the organisation's hub; a stated
  // destination point before a measured one.
  const gate = dispatch.factoryCode ? factoryOf(dispatch.factoryCode) : null
  const org = vehicle.organisation
  const yard = gate ? { lat: gate.lat, lng: gate.lng, name: gate.label }
    : org.hubLat != null && org.hubLng != null ? { lat: org.hubLat, lng: org.hubLng, name: org.name }
    : null
  const destName = dispatch.destination?.trim().toUpperCase() ?? null
  let dest: (Point & { name: string; spreadM: number }) | null = null
  if (destName) {
    const stated = knownDestination(destName)
    const measured = stated ? null : await prisma.dispatchDestination.findUnique({
      where:  { organisationId_name: { organisationId: orgId, name: destName } },
      select: { lat: true, lng: true, spreadM: true },
    })
    const p = stated ?? measured
    if (p) dest = { lat: p.lat, lng: p.lng, spreadM: p.spreadM, name: dispatch.destination!.trim() }
  }

  const [fixes, fillings, thefts, speeding, harsh, weighments] = await Promise.all([
    prisma.vehicleTelemetry.findMany({
      where:   { vehicleId, capturedAt: { gte: from, lte: to } },
      orderBy: { capturedAt: 'asc' },
      select:  { capturedAt: true, lat: true, lng: true, speedKmh: true, engineOn: true,
                 ignitionKnown: true, fuelLevelMl: true, fuelUsedMl: true },
    }),
    prisma.fuelFilling.findMany({
      where:   { vehicleId, filledAt: { gte: from, lte: to } },
      orderBy: { filledAt: 'asc' },
      select:  { filledAt: true, filledMl: true, finalFuelLevelMl: true, location: true, verdict: true },
    }),
    prisma.fuelTheft.findMany({
      where:   { vehicleId, beganAt: { gte: new Date(Math.min(from.getTime(), dayFrom.getTime())), lte: new Date(Math.max(to.getTime(), dayTo.getTime())) },
                 OR: [{ drainCause: 'SIPHON' }, { reviewStatus: 'CONFIRMED_THEFT' }] },
      orderBy: { beganAt: 'asc' },
      select:  { beganAt: true, stolenMl: true, finalFuelLevelMl: true, initialLocation: true, reviewStatus: true },
    }),
    prisma.speedingIncident.findMany({
      where:   { vehicleId, startedAt: { gte: dayFrom, lte: dayTo } },
      orderBy: { startedAt: 'asc' },
      select:  { startedAt: true, durationSec: true, distanceM: true, peakKmh: true, limitKmh: true, peakLat: true, peakLng: true },
    }),
    prisma.providerAlert.findMany({
      where:   { vehicleId, type: { in: ['HARSH_ACCELERATION', 'HARSH_BRAKING'] }, createdAt: { gte: dayFrom, lte: dayTo } },
      orderBy: { createdAt: 'asc' },
      select:  { type: true, createdAt: true, raw: true },
    }),
    prisma.weighment.findMany({
      where:   { organisationId: orgId, OR: [{ vehicleId }, { vehiclePlate: vehicle.registrationPlate }],
                 // Every ticket the unit raised from the start of the day to the end
                 // of the trip — a cane truck is weighed when it comes back.
                 tokenAt: { gte: dayFrom, lte: dayTo } },
      orderBy: { tokenAt: 'asc' },
      select:  { tokenNumber: true, tokenAt: true, grossWeightKg: true, grossAt: true, grossBridgeNo: true,
                 tareWeightKg: true, tareAt: true, tareBridgeNo: true, netWeightKg: true,
                 factoryGrossWeightKg: true, factoryGrossAt: true, factoryGrossBridgeNo: true,
                 factoryTareWeightKg: true, factoryTareAt: true, factoryTareBridgeNo: true, factoryNetWeightKg: true,
                 productName: true, category: true, centerName: true, driverName: true },
    }),
  ])

  // Best-effort, both: a slow PostGIS timeline or a busy VSS server must not
  // cost the operator the page.
  const located0 = fixes.filter(f => f.lat != null && f.lng != null)
  const [zones, dashcam, map] = await Promise.all([
    findZoneTimeline(vehicleId, orgId, from, to).catch((err) => {
      logger.warn({ err, vehicleId }, 'trip report: zone timeline failed')
      return null
    }),
    dashcamConduct(orgId, vehicleId, dayFrom, dayTo),
    routeMap([...located0.map(f => [f.lat!, f.lng!] as [number, number]),
              ...[yard, dest].filter(Boolean).map(p => [p!.lat, p!.lng] as [number, number])]).catch((err) => {
      logger.warn({ err, vehicleId }, 'trip report: map tiles failed')
      return null
    }),
  ])
  const inTrip = (d: Date) => d >= from && d <= to
  const inDay = (d: Date) => d >= dayFrom && d <= dayTo

  const located = fixes.filter(f => f.lat != null && f.lng != null)
  const track = thin(located, MAX_TRACK_POINTS).map(f => [
    f.capturedAt.getTime(), f.lat!, f.lng!, f.speedKmh ?? null, f.ignitionKnown === false ? null : f.engineOn ? 1 : 0,
  ])
  const levels = fixes.filter(f => f.fuelLevelMl != null && f.fuelLevelMl > 0)
  const counters = fixes.filter(f => f.fuelUsedMl != null && f.fuelUsedMl > 0)
  const usedByCounter = counters.length > 1
    ? (counters[counters.length - 1].fuelUsedMl! - counters[0].fuelUsedMl!) / 1000
    : null

  // Arrival: the first fix inside the destination's radius after departure.
  let arrivedAt: number | null = null
  if (dest) {
    const r = arrivalRadiusM(dest.spreadM)
    const hit = located.find(f => haversineM(dest!, { lat: f.lat!, lng: f.lng! }) <= r)
    arrivedAt = hit ? hit.capturedAt.getTime() : null
  }

  return {
    generatedAt: now,
    companyName: org.name,
    vehicle: {
      id: vehicle.id,
      plate: vehicle.registrationPlate,
      // UNSPECIFIED / UNKNOWN are the registry's placeholders, not a type.
      type: vehicle.makeModel ?? vehicle.model ?? (/^(UNSPECIFIED|UNKNOWN|OTHER)$/i.test(vehicle.vehicleType) ? null : vehicle.vehicleType),
    },
    dispatch: {
      externalId:   dispatch.externalId,
      serialNumber: dispatch.serialNumber,
      kind:         dispatch.kind,
      status:       dispatch.status,
      driverName:   dispatch.driverName || null,
      destination:  dispatch.destination,
      dispatchedAt: dispatch.dispatchedAt.getTime(),
      returnedAt:   ms(dispatch.actualReturnAt),
      tonnageT:     dispatch.tonnageT,
      bags:         dispatch.kind === 'SALES' ? bagsFromTonnes(dispatch.tonnageT) : null,
      cargoName:    dispatch.kind === 'SALES' ? gate?.commodity ?? null : null,
    },
    window: { from: begin, to: to.getTime(), clipped: begin > dispatch.dispatchedAt.getTime() },
    day: { from: dayFrom.getTime(), to: dayTo.getTime() },
    yard,
    dest,
    arrivedAt,
    track,
    map,
    fuel: {
      hasProbe: levels.length > 1,
      series: thin(levels, MAX_FUEL_POINTS).map(f => [f.capturedAt.getTime(), Math.round(f.fuelLevelMl! / 100) / 10]),
      usedByCounterL: usedByCounter != null && usedByCounter >= 0 ? Math.round(usedByCounter * 10) / 10 : null,
      fillings: fillings
        .filter(f => f.verdict === 'REFILL' || f.verdict === 'PENDING')
        .map(f => ({ t: f.filledAt.getTime(), litres: f.filledMl / 1000, after: f.finalFuelLevelMl != null ? f.finalFuelLevelMl / 1000 : null, place: f.location })),
      drains: thefts.filter(t => inTrip(t.beganAt)).map(t => ({ t: t.beganAt.getTime(), litres: t.stolenMl / 1000, after: t.finalFuelLevelMl != null ? t.finalFuelLevelMl / 1000 : null,
                                 place: t.initialLocation, review: t.reviewStatus })),
    },
    // Driver conduct, for the day.
    dashcam,
    escalatedThefts: thefts.filter(t => inDay(t.beganAt) && t.reviewStatus === 'CONFIRMED_THEFT')
      .map(t => ({ t: t.beganAt.getTime(), litres: t.stolenMl / 1000, place: t.initialLocation })),
    speeding: speeding.map(s => ({ t: s.startedAt.getTime(), durationSec: s.durationSec, distanceM: s.distanceM, peakKmh: s.peakKmh, limitKmh: s.limitKmh,
                                   lat: s.peakLat, lng: s.peakLng })),
    harsh: harsh.map(h => {
      const raw = (h.raw ?? {}) as Record<string, unknown>
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      return { t: h.createdAt.getTime(), type: h.type === 'HARSH_BRAKING' ? 'brake' : 'accel', lat: num(raw.lat), lng: num(raw.lng),
               speedKmh: num(raw.speedKmh), ms2: num(raw.ms2) }
    }),
    zones: zones === null ? { timedOut: true, visits: [] } : {
      timedOut: false,
      visits: zones.rows.filter(v => v.zone_id !== null).map(v => ({
        name: v.zone_name, enteredAt: v.entered_at.getTime(), leftAt: v.left_at.getTime(), enforced: v.enforced ?? false,
      })),
    },
    // Every weighing on every ticket of the day, as the bridge recorded it.
    weighments: weighments.map(w => ({
      ticket: w.tokenNumber.toString(), tokenAt: w.tokenAt.getTime(), at: weighedAt(w),
      centre: w.centerName, grossKg: w.grossWeightKg, tareKg: w.tareWeightKg, netKg: w.factoryNetWeightKg ?? w.netWeightKg,
      cargo: w.productName ?? humanise(w.category), driver: w.driverName || null,
      weighings: ([
        ['Tare', w.tareWeightKg, w.tareAt, w.tareBridgeNo, w.centerName],
        ['Gross', w.grossWeightKg, w.grossAt, w.grossBridgeNo, w.centerName],
        ['Factory gross', w.factoryGrossWeightKg, w.factoryGrossAt, w.factoryGrossBridgeNo, 'Factory'],
        ['Factory tare', w.factoryTareWeightKg, w.factoryTareAt, w.factoryTareBridgeNo, 'Factory'],
      ] as const)
        .filter(([, kg, at]) => kg != null && at != null)
        .map(([kind, kg, at, bridgeNo, centre]) => ({
          kind, kg, at: at!.getTime(), bridge: bridgeNo != null ? `${centre} · bridge ${bridgeNo}` : centre,
          // A weighing stamped before its own ticket was raised has a wrong date
          // at source (see weighedAt); it is printed, but not measured against.
          doubtful: at! < w.tokenAt,
        })),
    })),
  }
}

/**
 * The unit's seat-belt, phone and hands-off-wheel alarms from its dashcam.
 * `fitted: false` when it has no VSS camera (the page then has no such
 * columns); `complete: false` when the camera server could not answer in time.
 */
async function dashcamConduct(orgId: string, vehicleId: string, from: Date, to: Date) {
  try {
    const answer = await Promise.race([
      getAlarms(orgId, new Set([vehicleId]), from.toISOString()),
      new Promise<null>(resolve => setTimeout(() => resolve(null), DASHCAM_WAIT_MS)),
    ])
    if (!answer) return { fitted: true, complete: false, alarms: [] }
    if (answer.cameras === 0) return { fitted: false, complete: true, alarms: [] }
    const alarms = answer.incidents
      .filter(a => a.vehicleId === vehicleId && DASHCAM_KIND.has(a.code) && a.occurredAt)
      .map(a => ({ t: Date.parse(a.occurredAt!), kind: DASHCAM_KIND.get(a.code)!, label: a.label, lat: a.lat, lng: a.lng, speed: a.speed }))
      .filter(a => a.t >= from.getTime() && a.t <= to.getTime())
      .sort((x, y) => x.t - y.t)
    return { fitted: true, complete: !answer.partial && !answer.stale, alarms }
  } catch (err) {
    logger.warn({ err, vehicleId }, 'trip report: dashcam alarms failed')
    return { fitted: true, complete: false, alarms: [] }
  }
}

/** The route box on the page, in tile pixels (2:1, as the page draws it). */
const MAP_W = 640, MAP_H = 320

/**
 * The base map under the route: the Logbook report's own OpenStreetMap tiles
 * (greyed for print, cached), framed on the trip, as data URIs so the page
 * needs nothing else to print. Null when there is nothing to frame or no
 * tile came back — the page then draws the route on a blank box as before.
 */
async function routeMap(pts: [number, number][]) {
  if (pts.length < 2) return null
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity
  for (const [la, lo] of pts) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo) }
  let z = 16
  for (; z > 3; z--) {
    if (lon2x(e, z) - lon2x(w, z) <= MAP_W * 0.86 && lat2y(s, z) - lat2y(n, z) <= MAP_H * 0.86) break
  }
  const cx = (lon2x(w, z) + lon2x(e, z)) / 2, cy = (lat2y(n, z) + lat2y(s, z)) / 2
  const x0 = cx - MAP_W / 2, y0 = cy - MAP_H / 2
  const max = 2 ** z
  const want: { x: number; y: number }[] = []
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + MAP_H) / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + MAP_W) / 256); tx++) {
      if (ty >= 0 && ty < max) want.push({ x: tx, y: ty })
    }
  }
  const tiles = (await Promise.all(want.map(async t => {
    const buf = await tile(z, ((t.x % max) + max) % max, t.y)
    return buf ? { x: t.x, y: t.y, src: `data:image/png;base64,${buf.toString('base64')}` } : null
  }))).filter(Boolean)
  if (!tiles.length) return null
  return { z, x0, y0, w: MAP_W, h: MAP_H, tiles, attribution: '© OpenStreetMap contributors' }
}
