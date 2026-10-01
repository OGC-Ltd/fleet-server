/**
 * Machine register sync — RaiFactorySuite `GET /machines` → KASULU `vehicles`.
 *
 * Shared by the reconcile poller (hourly, see raifactorysuite.reconciler) and
 * `npm run sync:machines` (preview report / manual --apply).
 *
 * The join is EXACT: the register's `gpsUnitId` is the Wialon unit id, and our
 * KASULU rows carry `externalId = wialon:<that id>`. No plate matching — the
 * register's plates and our Wialon-derived ones are written differently, and
 * docs/LIVE_INTEGRATION.md forbids fuzzy plate joins across providers.
 *
 * `byReference` adds ONE fallback for register rows with no GPS id: the fleet
 * number ("BH-01") against the unit name ("MUFINDI: BH 01"), taken only where
 * exactly one unclaimed vehicle carries that number. The poller never uses it.
 *
 * Writes only rows whose register columns CHANGED, so `machineSyncedAt` is the
 * last time the register said something new about the vehicle, and an hourly
 * pass over an unchanged register writes nothing. A vehicle holding a register
 * row that no longer matches has the columns cleared.
 */

import type { PrismaClient } from '../../../generated/prisma/client.js'
import type { RaiFactorySuiteMachineRow } from './raifactorysuite.client.js'
import { fleetCodeOf, machineColumns, wialonExternalIdOf } from './raifactorysuite.machine.js'

/** The register's factory → our organisation. Only Mufindi is on it today. */
export const MACHINE_FACTORY_TO_ORG: Record<string, string> = {
  'MUFINDI PAPER MILLS': 'KASULU',
}

const NULL_COLUMNS = {
  machineId: null, equipmentType: null, equipmentCategory: null, equipmentReference: null,
  machineName: null, machineRegistrationNumber: null, ratedConsumptionUnit: null,
  makeModel: null, contractor: null, fuelType: null, ratedConsumption: null,
  ratedConsumptionBasis: null, fuelSensorFitted: null, machineSyncedAt: null,
} as const

/** Compared to decide whether a row needs writing — everything but the stamp. */
const COMPARED = [
  'machineId', 'equipmentType', 'equipmentCategory', 'equipmentReference', 'makeModel',
  'contractor', 'fuelType', 'ratedConsumption', 'ratedConsumptionBasis', 'fuelSensorFitted',
  'machineName', 'machineRegistrationNumber', 'ratedConsumptionUnit',
] as const

const SELECT = {
  id: true, externalId: true, name: true,
  machineId: true, equipmentType: true, equipmentCategory: true, equipmentReference: true,
  makeModel: true, contractor: true, fuelType: true, ratedConsumption: true,
  ratedConsumptionBasis: true, fuelSensorFitted: true,
  machineName: true, machineRegistrationNumber: true, ratedConsumptionUnit: true,
} as const

type VehicleRow = {
  id: string; externalId: string | null; name: string
} & { [K in typeof COMPARED[number]]: unknown }

export interface MachineSyncReport {
  register:       number
  matched:        { vehicle: string; reference: string; via: 'gps' | 'reference' }[]
  rated:          number
  /** Register rows whose GPS id names no active vehicle of ours. */
  noVehicle:      RaiFactorySuiteMachineRow[]
  /** Register rows with no GPS id that no fallback placed. */
  noGps:          number
  /** Active vehicles the register does not cover. */
  unregistered:   string[]
  types:          Map<string, number>
  written:        number
  cleared:        number
}

export async function syncMachineRegister(
  db: PrismaClient,
  machines: RaiFactorySuiteMachineRow[],
  opts: { apply: boolean; byReference?: boolean; now?: Date },
): Promise<MachineSyncReport> {
  const now = opts.now ?? new Date()
  const assign = new Map<string, { v: VehicleRow; m: RaiFactorySuiteMachineRow; via: 'gps' | 'reference' }>()
  const noVehicle: RaiFactorySuiteMachineRow[] = []
  const noGps:     RaiFactorySuiteMachineRow[] = []
  const all: VehicleRow[] = []

  for (const [factory, orgCode] of Object.entries(MACHINE_FACTORY_TO_ORG)) {
    const org = await db.organisation.findUnique({ where: { code: orgCode }, select: { id: true } })
    if (!org) throw new Error(`organisation ${orgCode} not found`)
    const vehicles = await db.vehicle.findMany({ where: { organisationId: org.id, isActive: true }, select: SELECT })
    all.push(...vehicles)
    const byExternal = new Map(vehicles.filter(v => v.externalId).map(v => [v.externalId!, v]))

    for (const m of machines.filter(r => r.factoryCode === factory && r.active !== false)) {
      const ext = wialonExternalIdOf(m)
      if (!ext) { noGps.push(m); continue }
      const v = byExternal.get(ext)
      if (!v) { noVehicle.push(m); continue }
      assign.set(v.id, { v, m, via: 'gps' })
    }

    if (opts.byReference) {
      const byCode = new Map<string, VehicleRow[]>()
      for (const v of vehicles) {
        if (assign.has(v.id)) continue
        const code = fleetCodeOf(v.name)
        if (code) byCode.set(code, [...(byCode.get(code) ?? []), v])
      }
      for (const m of [...noGps]) {
        const code = fleetCodeOf(m.reference)
        const hits = code ? byCode.get(code) ?? [] : []
        if (hits.length !== 1) continue
        assign.set(hits[0]!.id, { v: hits[0]!, m, via: 'reference' })
        byCode.delete(code!)
        noGps.splice(noGps.indexOf(m), 1)
      }
    }
  }

  const types = new Map<string, number>()
  let rated = 0
  for (const { m } of assign.values()) {
    const c = machineColumns(m, now)
    const t = c.equipmentType ?? '(no category)'
    types.set(t, (types.get(t) ?? 0) + 1)
    if (c.ratedConsumption != null) rated++
  }

  let written = 0, cleared = 0
  if (opts.apply) {
    // Clear first: machine_id is unique, so a register row moving from one
    // vehicle to another must leave the old one before it lands.
    for (const v of all) {
      if (v.machineId && assign.get(v.id)?.m.id !== v.machineId) {
        await db.vehicle.update({ where: { id: v.id }, data: NULL_COLUMNS })
        cleared++
      }
    }
    for (const { v, m } of assign.values()) {
      const data = machineColumns(m, now)
      if (COMPARED.every(k => v[k] === data[k])) continue
      await db.vehicle.update({ where: { id: v.id }, data })
      written++
    }
  }

  return {
    register: machines.length,
    matched:  [...assign.values()].map(a => ({ vehicle: a.v.name, reference: a.m.reference, via: a.via })),
    rated,
    noVehicle,
    noGps:        noGps.length,
    unregistered: all.filter(v => !assign.has(v.id)).map(v => v.name),
    types,
    written,
    cleared,
  }
}
