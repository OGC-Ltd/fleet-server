/**
 * Geofence enforcement — activate zones and bind them to vehicles.
 *
 * `sync:geofences` imports DEFINITIONS only, inactive and unbound. This is the
 * deliberate second step that decides which zones actually raise violations,
 * because that choice has real operational weight: every bound fence is
 * evaluated against every telemetry ping of every vehicle.
 *
 * Current policy — KEEP-OUT on water infrastructure:
 *   rivers and drains are BLOCKLIST zones for the whole Kasulu fleet. A
 *   vehicle inside one is a genuine incident (a truck in a drainage channel
 *   or river course), and the false-positive risk is low because no normal
 *   route passes through them.
 *
 * Everything else stays reference-only until there is a reason to enforce it.
 * Notably an ALLOWLIST "operational area" is NOT applied: units currently sit
 * near Nairobi, Dar and Mwanza, so a keep-in rule would flag them immediately.
 *
 * ALWAYS dry-runs first. Pass --apply to write.
 *
 * Run: npm run geofence:assign            (preview)
 *      npm run geofence:assign -- --apply (commit)
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { isInsideFence, type FenceGeometry } from '../src/lib/geofence.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const APPLY    = process.argv.includes('--apply')
const ORG_CODE = 'KASULU'

/**
 * Zones to enforce, by name. Matched case-insensitively as a prefix so
 * "DRAINS1".."DRAINS5" and "Main river malagarasi2/3" are all covered.
 */
const KEEP_OUT_PREFIXES = ['DRAINS', 'Main river']

function toGeometry(f: {
  type: string; centerLat: number | null; centerLng: number | null; radiusM: number | null
  polygonCoords: unknown; widthM: number | null
}): FenceGeometry | null {
  if (f.type === 'CIRCLE') {
    if (f.centerLat == null || f.centerLng == null || f.radiusM == null) return null
    return { type: 'CIRCLE', centerLat: f.centerLat, centerLng: f.centerLng, radiusM: f.radiusM }
  }
  if (f.type === 'LINE') {
    if (!f.polygonCoords || f.widthM == null) return null
    return { type: 'LINE', pathCoords: f.polygonCoords as [number, number][], widthM: f.widthM }
  }
  if (!f.polygonCoords) return null
  return { type: 'POLYGON', polygonCoords: f.polygonCoords as [number, number][] }
}

async function main() {
  console.log(`\n🛡  Geofence enforcement — ${ORG_CODE}  ${APPLY ? '(APPLYING)' : '(dry run)'}\n`)

  const org = await prisma.organisation.findUnique({ where: { code: ORG_CODE }, select: { id: true } })
  if (!org) throw new Error(`Organisation ${ORG_CODE} not found`)

  const all = await prisma.geofence.findMany({
    where:  { organisationId: org.id },
    select: {
      id: true, name: true, type: true, mode: true, isActive: true,
      centerLat: true, centerLng: true, radiusM: true, polygonCoords: true, widthM: true,
    },
  })

  const targets = all.filter(f =>
    KEEP_OUT_PREFIXES.some(p => f.name.toLowerCase().startsWith(p.toLowerCase())))

  if (targets.length === 0) {
    console.log('  No zones matched the policy — nothing to do.\n')
    return
  }
  console.log(`  Zones to enforce as BLOCKLIST (${targets.length}):`)
  targets.forEach(f => console.log(`    [${f.type.padEnd(7)}] ${f.name}`))

  const vehicles = await prisma.vehicle.findMany({
    where:  { organisationId: org.id, isActive: true },
    select: { id: true, registrationPlate: true },
  })
  console.log(`\n  Vehicles in scope: ${vehicles.length}`)

  // ── blast radius: how many vehicles are ALREADY inside a keep-out zone? ──
  // Enforcing a rule that is already violated would raise a violation for each
  // on the very next ping, so it is worth knowing the number beforehand.
  const latest = await prisma.$queryRawUnsafe<Array<{ plate: string; lat: number; lng: number }>>(`
    select distinct on (t.vehicle_id) v.registration_plate as plate, t.lat, t.lng
    from vehicle_telemetries t
    join vehicles v on v.id = t.vehicle_id
    where v.organisation_id = $1 and t.lat is not null
    order by t.vehicle_id, t.captured_at desc
  `, org.id)

  const offenders: Array<{ plate: string; zone: string }> = []
  for (const p of latest) {
    for (const f of targets) {
      const g = toGeometry(f)
      if (g && isInsideFence(Number(p.lat), Number(p.lng), g)) offenders.push({ plate: p.plate, zone: f.name })
    }
  }
  console.log(`  Vehicles currently inside a keep-out zone: ${offenders.length}`)
  offenders.slice(0, 8).forEach(o => console.log(`    ⚠ ${o.plate} in ${o.zone}`))

  const bindings = targets.length * vehicles.length
  console.log(`\n  Would create ${bindings.toLocaleString()} vehicle↔fence bindings and activate ${targets.length} fences.`)

  if (!APPLY) {
    console.log('\n  Dry run — nothing written. Re-run with:  npm run geofence:assign -- --apply\n')
    return
  }

  await prisma.geofence.updateMany({
    where: { id: { in: targets.map(f => f.id) } },
    data:  { mode: 'BLOCKLIST', isActive: true },
  })

  let created = 0
  for (const f of targets) {
    const existing = await prisma.vehicleGeofence.findMany({
      where:  { geofenceId: f.id },
      select: { vehicleId: true },
    })
    const have = new Set(existing.map(e => e.vehicleId))
    const rows = vehicles.filter(v => !have.has(v.id)).map(v => ({ vehicleId: v.id, geofenceId: f.id }))
    if (rows.length === 0) continue
    const res = await prisma.vehicleGeofence.createMany({ data: rows, skipDuplicates: true })
    created += res.count
  }

  console.log(`\n  ✓ activated ${targets.length} fences, created ${created.toLocaleString()} bindings`)
  const active = await prisma.geofence.count({ where: { organisationId: org.id, isActive: true } })
  console.log(`\n✅  ${active} fence(s) enforced. Violations will be raised on the next telemetry ping.\n`)
}

main()
  .catch(err => { console.error('\n❌  geofence-assign failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
