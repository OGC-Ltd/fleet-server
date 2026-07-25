/**
 * Vehicle registry sync — Controltech EA (factorysuite) → vehicles table.
 *
 * Production data flow: there is no on-prem GPS hardware and no IMEIs — the
 * provider's API is the source of truth for the fleet roster. This script is
 * RE-RUNNABLE (a sync, not a seed):
 *
 *   • upserts by `externalId` (the provider's vehicle UUID) — plate changes or
 *     renames upstream update the same row instead of duplicating it
 *   • `deviceId` = the same UUID: it is the identity the live telemetry
 *     adapter polls the provider by, so it doubles as the ingest key
 *   • per-type vehicle groups are ensured per org (TRACTORS / TRUCKS /
 *     COMPANY VEHICLES)
 *   • stores ONLY what the API provisions — no fabricated specs: tank
 *     capacity / fuel efficiency stay NULL until the provider supplies them
 *   • vehicles that disappear upstream (or are DECOMMISSIONED) are kept for
 *     history but flipped is_active=false, dropping them from the live fleet
 *
 * Run: npm run sync:vehicles
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL = process.env.CONTROLTECH_API_URL ?? 'https://factorysuite.org/api/external/v1'
const API_KEY = process.env.CONTROLTECH_API_KEY ?? ''

// Provider factoryCode → our organisation code. Extend as factories onboard
// (Kasulu gets its code here when Controltech provisions it).
const FACTORY_TO_ORG: Record<string, string> = {
  NDHIWA: 'SUKARI',
}

// Provider vehicle type → vehicle-group name within the org.
const GROUP_BY_TYPE: Record<string, string> = {
  TRACTOR:         'TRACTORS',
  TRUCK:           'TRUCKS',
  COMPANY_VEHICLE: 'COMPANY VEHICLES',
}

interface CtVehicle {
  id:          string
  factoryCode: string
  type:        string
  numberPlate: string
  make:        string | null
  model:       string | null
  status:      string
  active:      boolean
}

/**
 * Display name from the provider's make/model/plate. The upstream data is
 * messy: empty makes, "UNSPECIFIED" models, and internal asset codes
 * ("BCH 14049") stuffed into make — sanitise rather than pretend they're
 * manufacturers.
 */
function deriveName(v: CtVehicle): string {
  const clean = (s: string | null | undefined): string | null => {
    const t = (s ?? '').trim()
    if (!t || /^UNSPECIFIED$/i.test(t)) return null
    return t
  }
  let make  = clean(v.make)
  let model = clean(v.model)
  // "BCH nnnnn" is the factory's internal asset code, not a make — drop it
  // from make; keep it as the model only if nothing better exists.
  if (make && /^BCH\s*\d+$/i.test(make)) make = null
  if (model && make && model.toLowerCase() === make.toLowerCase()) model = null
  const label = [make, model].filter(Boolean).join(' ')
  return label ? `${label} ${v.numberPlate}` : `${v.type} ${v.numberPlate}`
}

async function fetchVehicles(): Promise<CtVehicle[]> {
  const res = await fetch(`${API_URL}/vehicles?limit=2000`, {
    headers: { accept: 'application/json', 'X-API-Key': API_KEY },
  })
  if (!res.ok) throw new Error(`Controltech /vehicles responded ${res.status}`)
  const body = await res.json() as CtVehicle[] | { data?: CtVehicle[] }
  const list = Array.isArray(body) ? body : (body.data ?? [])
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('Controltech /vehicles returned no records — refusing to deactivate the whole fleet on a bad response')
  }
  return list
}

async function main() {
  if (!API_KEY) throw new Error('CONTROLTECH_API_KEY is not set')
  console.log(`\n🔄  Vehicle sync — ${API_URL}\n`)

  const remote = await fetchVehicles()
  console.log(`  ← ${remote.length} vehicles from provider`)

  // Resolve orgs + ensure per-type groups.
  const orgByCode = new Map<string, { id: string }>()
  for (const code of new Set(Object.values(FACTORY_TO_ORG))) {
    const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
    if (org) orgByCode.set(code, org)
    else console.warn(`  ⚠ organisation ${code} not found — its vehicles will be skipped`)
  }

  const groupIdByKey = new Map<string, string>() // `${orgId}:${groupName}` → id
  const ensureGroup = async (orgId: string, orgCode: string, groupName: string): Promise<string> => {
    const key = `${orgId}:${groupName}`
    const cached = groupIdByKey.get(key)
    if (cached) return cached
    const code = `${orgCode}_${groupName.replace(/\s+/g, '_')}`
    const g = await prisma.vehicleGroup.upsert({
      where:  { organisationId_code: { organisationId: orgId, code } },
      update: {},
      create: { organisationId: orgId, name: groupName, code },
      select: { id: true },
    })
    groupIdByKey.set(key, g.id)
    return g.id
  }
  for (const [orgCode, org] of orgByCode) {
    for (const groupName of new Set(Object.values(GROUP_BY_TYPE))) {
      await ensureGroup(org.id, orgCode, groupName)
    }
  }

  let created = 0, updated = 0, skipped = 0, failed = 0
  const byType: Record<string, number> = {}

  for (const v of remote) {
    const orgCode = FACTORY_TO_ORG[v.factoryCode]
    const org = orgCode ? orgByCode.get(orgCode) : undefined
    if (!org) { skipped++; continue }

    // Unmapped provider types land in a FLEET group rather than being dropped.
    const groupName = GROUP_BY_TYPE[v.type] ?? 'FLEET'
    const groupId = await ensureGroup(org.id, orgCode!, groupName)

    const data = {
      organisationId:    org.id,
      vehicleGroupId:    groupId,
      name:              deriveName(v),
      registrationPlate: v.numberPlate.trim(),
      vehicleType:       v.type,
      status:            v.status,
      // DECOMMISSIONED units stay as rows (history) but leave the live fleet.
      isActive:          v.active && v.status !== 'DECOMMISSIONED',
    }

    try {
      const existing = await prisma.vehicle.findUnique({ where: { externalId: v.id }, select: { id: true } })
      if (existing) {
        await prisma.vehicle.update({ where: { externalId: v.id }, data })
        updated++
      } else {
        await prisma.vehicle.create({ data: { ...data, externalId: v.id, deviceId: v.id } })
        created++
      }
      byType[v.type] = (byType[v.type] ?? 0) + 1
    } catch (err) {
      failed++
      console.error(`  ✗ ${v.numberPlate} (${v.id}):`, err instanceof Error ? err.message.split('\n').at(-1) : err)
    }
  }

  // Vehicles that vanished upstream: keep for history, drop from live fleet.
  const remoteIds = remote.map(v => v.id)
  const gone = await prisma.vehicle.updateMany({
    where: {
      organisationId: { in: [...orgByCode.values()].map(o => o.id) },
      externalId:     { notIn: remoteIds, not: null },
      isActive:       true,
    },
    data: { isActive: false },
  })

  console.log(`\n  ✓ created ${created}, updated ${updated}, skipped ${skipped} (unmapped factory), failed ${failed}`)
  console.log(`  ✓ per type: ${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', ')}`)
  if (gone.count > 0) console.log(`  ✓ deactivated ${gone.count} vehicles no longer reported by the provider`)

  const active = await prisma.vehicle.count({ where: { isActive: true } })
  console.log(`\n✅  Sync complete — ${active} active vehicles in the registry.\n`)
}

main()
  .catch(err => {
    console.error('\n❌  sync-vehicles failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
