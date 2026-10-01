/**
 * Machine register sync — RaiFactorySuite `GET /machines` → KASULU `vehicles`.
 *
 * Mufindi Paper Mills' register says what each unit IS (Backhoe, Concrete
 * Mixer, Case Puma, …) and what the operator expects it to burn — litres per
 * engine-hour for plant, kilometres per litre for road vehicles. Neither is
 * in Wialon, which is where the KASULU rows come from.
 *
 * The join is EXACT: the register's `gpsUnitId` is the Wialon unit id, and our
 * KASULU rows carry `externalId = wialon:<that id>`. No plate matching — the
 * register's plates and our Wialon-derived ones are written differently, and
 * docs/LIVE_INTEGRATION.md forbids fuzzy plate joins across providers.
 *
 * `--by-reference` adds ONE fallback for register rows with no GPS id: the
 * fleet number ("BH-01") against the unit name ("MUFINDI: BH 01"), taken only
 * where exactly one unclaimed KASULU vehicle carries that number.
 *
 * Writes only the machine columns (see schema.prisma, "RaiFactorySuite machine
 * register"); a vehicle that held a register row which no longer matches has
 * them cleared. Re-runnable.
 *
 *   npm run sync:machines                     preview: match report, no writes
 *   npm run sync:machines -- --apply          write
 *   npm run sync:machines -- --by-reference   also try fleet-number matches
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { RaiFactorySuiteClient, type RaiFactorySuiteMachineRow } from '../src/providers/raifactorysuite/raifactorysuite.client.js'
import { fleetCodeOf, machineColumns, wialonExternalIdOf } from '../src/providers/raifactorysuite/raifactorysuite.machine.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL = process.env.RAIFACTORYSUITE_API_URL || process.env.CONTROLTECH_API_URL || 'https://factorysuite.org/api/external/v1'
const API_KEY = process.env.RAIFACTORYSUITE_API_KEY || process.env.CONTROLTECH_API_KEY || ''

const APPLY        = process.argv.includes('--apply')
const BY_REFERENCE = process.argv.includes('--by-reference')

/** The register's factory → our organisation. Only Mufindi is on it today. */
const FACTORY_TO_ORG: Record<string, string> = {
  'MUFINDI PAPER MILLS': 'KASULU',
}

const NULL_COLUMNS = {
  machineId: null, equipmentType: null, equipmentCategory: null, equipmentReference: null,
  makeModel: null, contractor: null, fuelType: null, ratedConsumption: null,
  ratedConsumptionBasis: null, fuelSensorFitted: null, machineSyncedAt: null,
} as const

async function main(): Promise<void> {
  if (!API_KEY) throw new Error('RAIFACTORYSUITE_API_KEY (or CONTROLTECH_API_KEY) is not set')
  const client   = new RaiFactorySuiteClient(API_URL, API_KEY)
  const machines = await client.listMachines()
  console.log(`register: ${machines.length} machines`)

  const now = new Date()
  type Vehicle = { id: string; externalId: string | null; name: string; registrationPlate: string; machineId: string | null }
  // vehicle id → the machine it gets
  const assign = new Map<string, { v: Vehicle; m: RaiFactorySuiteMachineRow; via: 'gps' | 'reference' }>()
  const noVehicle: RaiFactorySuiteMachineRow[] = []
  const noGps:     RaiFactorySuiteMachineRow[] = []
  const vehiclesByOrg = new Map<string, Vehicle[]>()

  for (const [factory, orgCode] of Object.entries(FACTORY_TO_ORG)) {
    const org = await prisma.organisation.findUnique({ where: { code: orgCode }, select: { id: true } })
    if (!org) throw new Error(`organisation ${orgCode} not found`)
    const vehicles: Vehicle[] = await prisma.vehicle.findMany({
      where:  { organisationId: org.id, isActive: true },
      select: { id: true, externalId: true, name: true, registrationPlate: true, machineId: true },
    })
    vehiclesByOrg.set(orgCode, vehicles)
    const byExternal = new Map(vehicles.filter(v => v.externalId).map(v => [v.externalId!, v]))

    const rows = machines.filter(m => m.factoryCode === factory && m.active !== false)
    for (const m of rows) {
      const ext = wialonExternalIdOf(m)
      if (!ext) { noGps.push(m); continue }
      const v = byExternal.get(ext)
      if (!v) { noVehicle.push(m); continue }
      assign.set(v.id, { v, m, via: 'gps' })
    }

    if (BY_REFERENCE) {
      const claimed = new Set(assign.keys())
      const byCode  = new Map<string, Vehicle[]>()
      for (const v of vehicles) {
        if (claimed.has(v.id)) continue
        const code = fleetCodeOf(v.name)
        if (code) byCode.set(code, [...(byCode.get(code) ?? []), v])
      }
      for (const m of [...noGps]) {
        const code  = fleetCodeOf(m.reference)
        const hits  = code ? byCode.get(code) ?? [] : []
        if (hits.length !== 1) continue
        assign.set(hits[0]!.id, { v: hits[0]!, m, via: 'reference' })
        byCode.delete(code!)
        noGps.splice(noGps.indexOf(m), 1)
      }
    }
  }

  // ── report ──
  const matched = [...assign.values()]
  const byType  = new Map<string, number>()
  let rated = 0
  for (const { m } of matched) {
    const c = machineColumns(m, now)
    byType.set(c.equipmentType ?? '(no category)', (byType.get(c.equipmentType ?? '(no category)') ?? 0) + 1)
    if (c.ratedConsumption != null) rated++
  }
  const allVehicles = [...vehiclesByOrg.values()].flat()
  const unregistered = allVehicles.filter(v => !assign.has(v.id))
  console.log(`matched:   ${matched.length} (gps ${matched.filter(a => a.via === 'gps').length}, reference ${matched.filter(a => a.via === 'reference').length}); ${rated} with a rated consumption`)
  console.log(`register rows with a GPS id but no active vehicle: ${noVehicle.length}`)
  for (const m of noVehicle) console.log(`   ${m.reference.padEnd(14)} ${String(m.category).padEnd(22)} gps ${m.gpsUnitId}`)
  console.log(`register rows with no GPS id (unmatched): ${noGps.length}`)
  console.log(`active vehicles the register does not cover: ${unregistered.length}`)
  for (const v of unregistered.slice(0, 40)) console.log(`   ${v.name}`)
  if (unregistered.length > 40) console.log(`   … ${unregistered.length - 40} more`)
  console.log('types:')
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${t}`)
  if (BY_REFERENCE) for (const a of matched.filter(x => x.via === 'reference')) console.log(`   ref  ${a.m.reference} → ${a.v.name}`)

  if (!APPLY) { console.log('\npreview only — re-run with --apply to write'); return }

  // Clear first: machine_id is unique, so a register row moving from one
  // vehicle to another must leave the old one before it lands.
  const stale = allVehicles.filter(v => v.machineId && assign.get(v.id)?.m.id !== v.machineId)
  for (const v of stale) await prisma.vehicle.update({ where: { id: v.id }, data: NULL_COLUMNS })
  let written = 0
  for (const { v, m } of matched) {
    await prisma.vehicle.update({ where: { id: v.id }, data: machineColumns(m, now) })
    written++
  }
  console.log(`\nwrote ${written} vehicles; cleared ${stale.length}`)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
