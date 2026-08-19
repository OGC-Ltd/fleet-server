/**
 * What the provider says is FITTED to each unit.
 *
 * ## Why this is a separate question from probe health
 *
 * `fuel-probe-health` reads TELEMETRY and answers "is this channel alive". It
 * cannot answer "is there anything there to be alive", and the two failures
 * want different people: a probe that has died needs a workshop visit, a
 * sensor that was never calibrated needs somebody in the Wialon account.
 *
 * Told apart, they are 12 DIED and 31 SILENT on this fleet (measured
 * 2026-08-20). Conflated, they are 43 units with "no fuel reading" and a fitter
 * sent to look at machines whose probes are fine.
 *
 * ## The case this exists to name
 *
 * A Wialon fuel sensor converts a raw parameter to litres through a calibration
 * table. `calibrateFuel` returns null when that table is empty, and
 * `readFuelProbeFault` skips such a sensor outright — so a unit whose sensor
 * exists but carries no table produces no level AND no fault. It is invisible
 * to every rule we have. `calibrationPoints = 0` is that unit.
 *
 * Sensor configuration changes when an engineer edits the account, which is
 * rarely, so this is a sweep rather than anything on the telemetry path.
 */

import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { wialonDeviceId } from '../../providers/wialon/wialon.adapter.js'
import { WialonClient, type WialonUnit } from '../../providers/wialon/wialon.client.js'
import { env } from '../../config/env.js'

/** Wialon's type string for a fuel-level sensor. */
export const FUEL_SENSOR_TYPE = 'fuel level'

export interface SensorSyncOutcome {
  units:      number
  /** Units the registry knows; the rest of the account is not ours. */
  matched:    number
  sensors:    number
  /** Fuel sensors carrying no calibration table — cannot produce a level. */
  uncalibrated: number
  removed:    number
}

/** One sensor as we store it, from the provider's own record. */
function toRow(vehicleId: string, externalId: string, s: {
  n?: string; t?: string; p?: string; tbl?: Array<{ x: number }>
}) {
  const tbl = s.tbl ?? []
  return {
    vehicleId,
    externalId,
    name:      s.n ?? '(unnamed)',
    type:      s.t ?? '(untyped)',
    parameter: s.p ?? '',
    calibrationPoints: tbl.length,
    // The top of the calibrated domain. Above it a reading is a fault code
    // rather than a measurement — see wialon.sensors.calibrateFuel.
    calibratedMax: tbl.length > 0 ? Math.max(...tbl.map(pt => pt.x)) : null,
  }
}

/**
 * Refresh the sensor inventory for every unit the registry knows.
 *
 * Wholesale per vehicle: the provider's record is the truth, so a sensor that
 * has gone from the account is deleted here rather than left to look fitted.
 */
export async function syncSensorInventory(opts: { client?: WialonClient } = {}): Promise<SensorSyncOutcome> {
  const out: SensorSyncOutcome = { units: 0, matched: 0, sensors: 0, uncalibrated: 0, removed: 0 }

  const client = opts.client ?? new WialonClient(
    env.WIALON_TOKEN || process.env['access_token'] || '', env.WIALON_API_URL,
  )
  if (!opts.client) await client.login()

  const units: WialonUnit[] = await client.listUnits()
  out.units = units.length

  // One lookup for the whole account rather than a query per unit: the account
  // carries ~1,500 units and the registry a few hundred of them.
  const vehicles = await prisma.vehicle.findMany({ select: { id: true, deviceId: true } })
  const byDevice = new Map(vehicles.map(v => [v.deviceId, v.id]))

  // Built in memory first, then written in three statements.
  //
  // The obvious shape — a transaction per vehicle doing one delete and N
  // upserts — died on P2028 at 6.1 s against a 5 s limit, because every upsert
  // is its own round trip and there are hundreds of units. Sensor config is a
  // few thousand small rows in total, so assembling the whole desired state
  // here costs nothing and turns the write into a fixed number of statements.
  const desired: ReturnType<typeof toRow>[] = []
  for (const u of units) {
    const vehicleId = byDevice.get(wialonDeviceId(u.id))
    if (!vehicleId) continue
    out.matched++
    for (const [externalId, sensor] of Object.entries(u.sens ?? {})) {
      desired.push(toRow(vehicleId, externalId, sensor))
    }
  }
  out.sensors      = desired.length
  out.uncalibrated = desired.filter(r => r.type === FUEL_SENSOR_TYPE && r.calibrationPoints === 0).length

  const vehicleIds = [...new Set(desired.map(r => r.vehicleId))]
  if (vehicleIds.length === 0) {
    logger.warn('Sensor inventory sync matched no vehicles — nothing written')
    return out
  }

  // Carried forward across the rewrite. Without this, "first seen" would be
  // "last synced" and the column would say nothing.
  const existing = await prisma.vehicleSensor.findMany({
    where:  { vehicleId: { in: vehicleIds } },
    select: { vehicleId: true, externalId: true, firstSeenAt: true },
  })
  const firstSeen = new Map(existing.map(e => [`${e.vehicleId}:${e.externalId}`, e.firstSeenAt]))

  const now = new Date()
  const rows = desired.map(r => ({
    ...r,
    firstSeenAt: firstSeen.get(`${r.vehicleId}:${r.externalId}`) ?? now,
    syncedAt:    now,
  }))

  // Replace wholesale for the units we just read. A sensor removed from the
  // account must stop looking fitted, and `deleteMany` scoped to those vehicles
  // is what makes the inventory the provider's state rather than an accumulation
  // of everything ever seen. Units NOT in this sweep keep their rows untouched.
  await prisma.$transaction([
    prisma.vehicleSensor.deleteMany({ where: { vehicleId: { in: vehicleIds } } }),
    prisma.vehicleSensor.createMany({ data: rows }),
  ], { timeout: 60_000 })
  out.removed = Math.max(existing.length - rows.length, 0)

  logger.info(out, 'Sensor inventory sync complete')
  return out
}
