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

import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { knownDestination } from '../dispatches/known-destinations.js'
import { factoryOf, bagsFromTonnes } from '../webhooks/factory-map.js'
import { arrivalRadiusM, haversineM, type Point } from '../../lib/dispatch-trip.js'
import { findZoneTimeline } from '../telemetry/telemetry.repository.js'
import { getAlarms } from '../dashcam/dashcam.service.js'
import { logger } from '../../lib/logger.js'

const MAX_WINDOW_MS = 7 * 86_400_000
/** Points sent for stops and distance; a day at one fix per 15 s is ~5,800. */
const MAX_TRACK_POINTS = 8000
const MAX_FUEL_POINTS = 500
/** Dashcam codes the report counts. Harsh driving and speed come from the tracker. */
const DASHCAM_SEATBELT = new Set([51])
const DASHCAM_CORNERING = new Set([71])
const DASHCAM_WAIT_MS = 12_000

const thin = <T>(rows: T[], max: number): T[] => {
  if (rows.length <= max) return rows
  const step = rows.length / max
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)])
  out[out.length - 1] = rows[rows.length - 1]
  return out
}

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null)

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
      where:   { vehicleId, beganAt: { gte: from, lte: to },
                 OR: [{ drainCause: 'SIPHON' }, { reviewStatus: 'CONFIRMED_THEFT' }] },
      orderBy: { beganAt: 'asc' },
      select:  { beganAt: true, stolenMl: true, finalFuelLevelMl: true, initialLocation: true, reviewStatus: true },
    }),
    prisma.speedingIncident.findMany({
      where:   { vehicleId, startedAt: { gte: from, lte: to } },
      orderBy: { startedAt: 'asc' },
      select:  { startedAt: true, durationSec: true, peakKmh: true, limitKmh: true, peakLat: true, peakLng: true },
    }),
    prisma.providerAlert.findMany({
      where:   { vehicleId, type: { in: ['HARSH_ACCELERATION', 'HARSH_BRAKING'] }, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: 'asc' },
      select:  { type: true, createdAt: true, raw: true },
    }),
    prisma.weighment.findMany({
      where:   { organisationId: orgId, OR: [{ vehicleId }, { vehiclePlate: vehicle.registrationPlate }],
                 // A cane truck crosses the bridge when it comes BACK, so a closed run
                 // looks a few hours past its return; a ticket before departure is the last run's.
                 tokenAt: { gte: from, lte: new Date(to.getTime() + (dispatch.actualReturnAt ? 6 * 3_600_000 : 0)) } },
      orderBy: { tokenAt: 'asc' },
      select:  { tokenNumber: true, tokenAt: true, grossWeightKg: true, grossAt: true, grossBridgeNo: true, tareAt: true,
                 tareWeightKg: true, netWeightKg: true, productName: true, category: true, centerName: true, driverName: true },
    }),
  ])

  // Zone crossings and dashcam alarms are both best-effort: a slow PostGIS
  // timeline or an unreachable VSS server must not cost the operator the page.
  const [zones, camera] = await Promise.all([
    findZoneTimeline(vehicleId, orgId, from, to).catch((err) => {
      logger.warn({ err, vehicleId }, 'trip report: zone timeline failed')
      return null
    }),
    dashcamFor(orgId, vehicleId, from, to),
  ])

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
    yard,
    dest,
    arrivedAt,
    track,
    fuel: {
      hasProbe: levels.length > 1,
      series: thin(levels, MAX_FUEL_POINTS).map(f => [f.capturedAt.getTime(), Math.round(f.fuelLevelMl! / 100) / 10]),
      usedByCounterL: usedByCounter != null && usedByCounter >= 0 ? Math.round(usedByCounter * 10) / 10 : null,
      fillings: fillings
        .filter(f => f.verdict === 'REFILL' || f.verdict === 'PENDING')
        .map(f => ({ t: f.filledAt.getTime(), litres: f.filledMl / 1000, after: f.finalFuelLevelMl != null ? f.finalFuelLevelMl / 1000 : null, place: f.location })),
      drains: thefts.map(t => ({ t: t.beganAt.getTime(), litres: t.stolenMl / 1000, after: t.finalFuelLevelMl != null ? t.finalFuelLevelMl / 1000 : null,
                                 place: t.initialLocation, review: t.reviewStatus })),
    },
    speeding: speeding.map(s => ({ t: s.startedAt.getTime(), durationSec: s.durationSec, peakKmh: s.peakKmh, limitKmh: s.limitKmh,
                                   lat: s.peakLat, lng: s.peakLng })),
    harsh: harsh.map(h => {
      const raw = (h.raw ?? {}) as Record<string, unknown>
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      return { t: h.createdAt.getTime(), type: h.type === 'HARSH_BRAKING' ? 'brake' : 'accel', lat: num(raw.lat), lng: num(raw.lng),
               speedKmh: num(raw.speedKmh), ms2: num(raw.ms2) }
    }),
    camera,
    zones: zones === null ? { timedOut: true, visits: [] } : {
      timedOut: false,
      visits: zones.rows.filter(v => v.zone_id !== null).map(v => ({
        name: v.zone_name, enteredAt: v.entered_at.getTime(), leftAt: v.left_at.getTime(), enforced: v.enforced ?? false,
      })),
    },
    weighments: weighments.map(w => ({
      ticket: w.tokenNumber.toString(), at: weighedAt(w), bridge: w.grossBridgeNo != null ? `${w.centerName} · bridge ${w.grossBridgeNo}` : w.centerName,
      grossKg: w.grossWeightKg, tareKg: w.tareWeightKg, netKg: w.netWeightKg, cargo: w.productName ?? humanise(w.category), driver: w.driverName || null,
    })),
  }
}

/** The unit's seat-belt and cornering alarms, or `fitted: false` when it has no VSS camera. */
async function dashcamFor(orgId: string, vehicleId: string, from: Date, to: Date) {
  try {
    const answer = await Promise.race([
      getAlarms(orgId, new Set([vehicleId]), from.toISOString()),
      new Promise<null>(resolve => setTimeout(() => resolve(null), DASHCAM_WAIT_MS)),
    ])
    if (!answer) return { fitted: true, complete: false, alarms: [] }
    if (answer.cameras === 0) return { fitted: false, complete: true, alarms: [] }
    const alarms = answer.incidents
      .filter(a => a.vehicleId === vehicleId && (DASHCAM_SEATBELT.has(a.code) || DASHCAM_CORNERING.has(a.code)))
      .map(a => ({ t: a.occurredAt ? Date.parse(a.occurredAt) : null, kind: DASHCAM_SEATBELT.has(a.code) ? 'seatbelt' : 'turn',
                   label: a.label, lat: a.lat, lng: a.lng, speed: a.speed }))
      .filter(a => a.t != null && a.t >= from.getTime() && a.t <= to.getTime())
    return { fitted: true, complete: !answer.partial && !answer.stale, alarms }
  } catch (err) {
    logger.warn({ err, vehicleId }, 'trip report: dashcam alarms failed')
    return { fitted: true, complete: false, alarms: [] }
  }
}
