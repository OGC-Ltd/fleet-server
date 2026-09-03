/**
 * The operations report — the only one a logistics manager or dispatcher may take.
 *
 * Four sections, and deliberately only four:
 *
 *   1. units that left the premises
 *   2. trips completed
 *   3. fuel refill per unit
 *   4. working and faulty sensors
 *
 * The other PDFs carry analytics and driver detail those roles are not given,
 * which is why this is a separate report rather than a trimmed rendering of an
 * existing one: a report that shows less depending on who asked is a report
 * nobody can cite, because two people comparing copies see different documents.
 *
 * Every figure respects the caller's VEHICLE SCOPE. A dispatcher restricted to
 * eleven units gets a report about those eleven, not a fleet report they happen
 * to be reading.
 */

import { prisma } from '../../lib/prisma.js'
import { Prisma } from '../../../generated/prisma/client.js'
import type { ReportData, ReportBarRow, ReportInsight } from './report-pdf.renderer.js'

const fmt = (n: number, d = 0) =>
  Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

/**
 * A departure is a MOVEMENT_EXIT notification, not a fresh geometry pass.
 *
 * lib/yard-departure already decides this, with hysteresis around the gate so a
 * truck idling at the barrier or jittering on GPS noise does not narrate a
 * convoy. Re-deriving it here would mean a 30-day haversine scan of
 * vehicle_telemetries — the table whose unbounded reads already time out — and
 * would produce a SECOND definition of "left", free to disagree with the one
 * the live feed showed the operator at the time.
 */
async function unitsThatLeft(
  orgId: string, from: Date, vehicleIds: Set<string> | null,
): Promise<{ units: number; departures: number }> {
  const where: Prisma.NotificationWhereInput = {
    organisationId: orgId,
    alertType:      'MOVEMENT_EXIT',
    occurredAt:     { gte: from },
    ...(vehicleIds ? { vehicleId: { in: [...vehicleIds] } } : { vehicleId: { not: null } }),
  }
  const [rows, departures] = await Promise.all([
    prisma.notification.findMany({ where, select: { vehicleId: true }, distinct: ['vehicleId'] }),
    prisma.notification.count({ where }),
  ])
  return { units: rows.length, departures }
}

async function tripsCompleted(
  orgId: string, from: Date, vehicleIds: Set<string> | null,
): Promise<{ trips: number; km: number }> {
  const where: Prisma.TripWhereInput = {
    endedAt: { gte: from },
    vehicle: {
      organisationId: orgId,
      ...(vehicleIds ? { id: { in: [...vehicleIds] } } : {}),
    },
  }
  const [trips, agg] = await Promise.all([
    prisma.trip.count({ where }),
    prisma.trip.aggregate({ where, _sum: { mileageKm: true } }),
  ])
  return { trips, km: agg._sum.mileageKm ?? 0 }
}

type RefillRow = { vehicleId: string; plate: string; litres: number; fills: number }

async function refillsPerUnit(
  orgId: string, from: Date, vehicleIds: Set<string> | null,
): Promise<RefillRow[]> {
  const fillings = await prisma.fuelFilling.findMany({
    where: {
      filledAt: { gte: from },
      vehicle: {
        organisationId: orgId,
        ...(vehicleIds ? { id: { in: [...vehicleIds] } } : {}),
      },
    },
    select: { vehicleId: true, filledMl: true, vehicle: { select: { registrationPlate: true } } },
  })

  const byVehicle = new Map<string, RefillRow>()
  for (const f of fillings) {
    const row = byVehicle.get(f.vehicleId) ?? {
      vehicleId: f.vehicleId,
      plate:     f.vehicle.registrationPlate,
      litres:    0,
      fills:     0,
    }
    // Stored in millilitres throughout; litres is a presentation concern.
    row.litres += (f.filledMl ?? 0) / 1000
    row.fills  += 1
    byVehicle.set(f.vehicleId, row)
  }
  return [...byVehicle.values()].sort((a, b) => b.litres - a.litres)
}

type SensorRow = { plate: string; sensors: number; state: 'WORKING' | 'FAULTY' | 'UNCALIBRATED'; detail: string }

/**
 * Working or faulty, using the distinction the fuel module already draws.
 *
 * Three states, not two, because "faulty" hides the case worth acting on
 * fastest. A probe with zero calibration points is CONFIGURED and produces no
 * litres and no fault — invisible to every rule we have, and a Wialon record to
 * correct rather than a probe to service. Reporting it as merely "faulty" sends
 * a fitter to a machine with nothing wrong.
 */
async function sensorHealth(
  orgId: string, from: Date, vehicleIds: Set<string> | null,
): Promise<SensorRow[]> {
  const sensors = await prisma.vehicleSensor.findMany({
    where: {
      type: { contains: 'fuel', mode: 'insensitive' },
      vehicle: {
        organisationId: orgId,
        isActive: true,
        ...(vehicleIds ? { id: { in: [...vehicleIds] } } : {}),
      },
    },
    select: {
      vehicleId: true, calibrationPoints: true,
      vehicle: { select: { registrationPlate: true } },
    },
  })
  if (sensors.length === 0) return []

  // Did the channel say anything at all in the window? `levelPings` counts
  // frames CARRYING a level — null is "the channel said nothing", which is the
  // distinction the probe report's NOT_REPORTING state rests on.
  const stats = await prisma.vehicleDailyStat.groupBy({
    by:     ['vehicleId'],
    where:  { vehicleId: { in: sensors.map((s) => s.vehicleId) }, day: { gte: from } },
    _sum:   { levelPings: true },
  })
  const levelPings = new Map(stats.map((s) => [s.vehicleId, s._sum.levelPings ?? 0]))

  const byVehicle = new Map<string, SensorRow>()
  for (const s of sensors) {
    const pings = levelPings.get(s.vehicleId) ?? 0
    const existing = byVehicle.get(s.vehicleId)

    let state: SensorRow['state']
    let detail: string
    if (s.calibrationPoints === 0) {
      state = 'UNCALIBRATED'
      detail = 'configured, no calibration table'
    } else if (pings > 0) {
      state = 'WORKING'
      detail = `${fmt(pings)} readings`
    } else {
      state = 'FAULTY'
      detail = 'no reading in this window'
    }

    // A unit with several fuel sensors is judged by its worst one — the report
    // is a work list, and a machine with one dead probe needs a visit whatever
    // its other probe is doing.
    const rank = { WORKING: 0, UNCALIBRATED: 1, FAULTY: 2 } as const
    if (!existing || rank[state] > rank[existing.state]) {
      byVehicle.set(s.vehicleId, {
        plate: s.vehicle.registrationPlate,
        sensors: (existing?.sensors ?? 0) + 1,
        state, detail,
      })
    } else {
      existing.sensors += 1
    }
  }
  return [...byVehicle.values()].sort((a, b) => a.plate.localeCompare(b.plate))
}

export async function collectOperations(
  orgId: string,
  days: number,
  vehicleIds: Set<string> | null = null,
): Promise<ReportData> {
  const from = new Date(Date.now() - days * 86_400_000)

  const [left, trips, refills, sensors] = await Promise.all([
    unitsThatLeft(orgId, from, vehicleIds),
    tripsCompleted(orgId, from, vehicleIds),
    refillsPerUnit(orgId, from, vehicleIds),
    sensorHealth(orgId, from, vehicleIds),
  ])

  const totalLitres = refills.reduce((s, r) => s + r.litres, 0)
  const working      = sensors.filter((s) => s.state === 'WORKING').length
  const faulty       = sensors.filter((s) => s.state === 'FAULTY').length
  const uncalibrated = sensors.filter((s) => s.state === 'UNCALIBRATED').length

  const topLitres = refills[0]?.litres ?? 0
  const bars: ReportBarRow[] = refills.slice(0, 12).map((r) => ({
    label:     r.plate,
    note:      r.fills === 1 ? '1 fill' : `${r.fills} fills`,
    value:     fmt(r.litres, 1),
    valueNote: 'L',
    frac:      topLitres > 0 ? r.litres / topLitres : 0,
  }))

  const insights: ReportInsight[] = []
  if (left.units > 0) {
    insights.push({
      title: 'Departures',
      body: `${fmt(left.units)} unit${left.units === 1 ? '' : 's'} left the premises `
          + `${fmt(left.departures)} time${left.departures === 1 ? '' : 's'}, `
          + `an average of ${fmt(left.departures / Math.max(1, left.units), 1)} trips out per unit.`,
    })
  } else {
    insights.push({
      title: 'Departures',
      body: 'No gate departures were recorded in this window. A unit is counted when it is '
          + 'seen at the gate and then clear of it, so a site with no gate coordinate recorded '
          + 'produces no departures rather than a wrong count.',
    })
  }

  if (faulty > 0 || uncalibrated > 0) {
    const parts: string[] = []
    if (faulty) parts.push(`${fmt(faulty)} reported nothing at all`)
    if (uncalibrated) parts.push(`${fmt(uncalibrated)} carry no calibration table, so they can produce no litres`)
    insights.push({
      title: 'Sensors needing attention',
      body: `Of ${fmt(sensors.length)} units carrying a fuel sensor, ${parts.join(' and ')}. `
          + 'An uncalibrated probe is a record to correct, not a probe to service.',
    })
  } else if (sensors.length > 0) {
    insights.push({
      title: 'Sensors',
      body: `All ${fmt(sensors.length)} units carrying a fuel sensor reported in this window.`,
    })
  }

  return {
    title:       'Operations Report',
    orgName:     '',
    orgRegion:   '',
    windowLabel: `Trailing ${days} days`,
    kpiLabel:    'SUMMARY',
    kpis: [
      { label: 'Units off premises', value: fmt(left.units),
        sub: `${fmt(left.departures)} departure${left.departures === 1 ? '' : 's'}`, dark: true },
      { label: 'Trips completed',    value: fmt(trips.trips),
        sub: `${fmt(trips.km, 0)} km covered` },
      { label: 'Fuel refilled',      value: fmt(totalLitres, 0), unit: 'L',
        sub: `${fmt(refills.length)} unit${refills.length === 1 ? '' : 's'} refuelled` },
      { label: 'Sensors faulty',     value: fmt(faulty + uncalibrated),
        sub: `${fmt(working)} of ${fmt(sensors.length)} working` },
    ],
    bars: {
      title: 'Fuel refill per unit',
      note:  refills.length > 12 ? `top 12 of ${fmt(refills.length)} units` : undefined,
      rows:  bars,
    },
    donut: {
      title: 'Fuel sensor health',
      note:  'Reporting, silent, and configured-but-uncalibrated',
      data: {
        centerValue: sensors.length ? `${Math.round((working / sensors.length) * 100)}%` : '—',
        centerLabel: 'reporting',
        segments: [
          { label: 'Working',      value: fmt(working),
            frac: sensors.length ? working / sensors.length : 0,      color: '#1e6f4e' },
          { label: 'Faulty',       value: fmt(faulty),
            frac: sensors.length ? faulty / sensors.length : 0,       color: '#cf4a3d' },
          // Amber, not red: a probe with no calibration table is a Wialon
          // record to correct, not a machine to send a fitter to.
          { label: 'Uncalibrated', value: fmt(uncalibrated),
            frac: sensors.length ? uncalibrated / sensors.length : 0, color: '#c78a1e' },
        ],
      },
    },
    panels: [],
    insights,
    table: {
      title: 'Sensor status by unit',
      note:  sensors.length === 0 ? 'No unit in scope carries a fuel sensor' : undefined,
      columns: [
        { label: 'Unit',    width: 0.30 },
        { label: 'Sensors', width: 0.15, align: 'right' },
        { label: 'State',   width: 0.20 },
        { label: 'Detail',  width: 0.35 },
      ],
      rows: sensors.map((s) => ({
        cells: [s.plate, String(s.sensors), s.state, s.detail],
        alert: s.state !== 'WORKING',
      })),
    },
  }
}
