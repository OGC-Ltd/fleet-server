/**
 * Dispatch backfill / reconciliation — RaiFactorySuite (factorysuite).
 *
 * Dispatches arrive by WEBHOOK (POST /api/v1/webhooks/raifactorysuite/events)
 * and the reconciler re-reads a window every few minutes, so this script is not
 * part of steady-state operation. It exists for the one thing a push channel
 * cannot do: load the history that already happened.
 *
 * That history is what makes an ETA possible at all. The provider gives a
 * destination as free text and no coordinates, so the only honest way to say
 * when a vehicle is due back is the fleet's own record of how long this exact
 * run has taken before. Measured on the live provider (2026-07-30): 931 of
 * 1000 rows are completed round trips, 56 destinations have 5 or more of them,
 * and those 56 cover 48 of the 55 currently-open dispatches.
 *
 * URGENCY: `/dispatches` is capped at 1000 rows and IGNORES offset/page/skip,
 * so it is a sliding window. Every day this is not run, the oldest completed
 * trips fall off the end and their durations are gone for good.
 *
 * Idempotent — rows upsert on the provider's dispatch id, so overlapping with
 * live webhook traffic or the reconciler never duplicates. Nothing is narrated
 * into the Live Feed: replaying a thousand historical dispatches would bury it.
 *
 * Run: npm run sync:dispatches  [-- --limit=1000] [-- --dry]
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { parseProviderTime, parseProviderTimeOr } from '../src/lib/provider-time.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL = process.env.RAIFACTORYSUITE_API_URL ?? process.env.CONTROLTECH_API_URL
             ?? 'https://factorysuite.org/api/external/v1'
const API_KEY = process.env.RAIFACTORYSUITE_API_KEY ?? process.env.CONTROLTECH_API_KEY
             ?? process.env.FACTORY_SUITE_API_KEY ?? ''

const args  = process.argv.slice(2)
const DRY   = args.includes('--dry')
const LIMIT = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? 1000)

/** Provider factoryCode → our organisation code (mirrors the webhook service). */
const FACTORY_TO_ORG: Record<string, string> = { NDHIWA: 'SUKARI' }

interface Row {
  id: string
  factoryCode: string
  vehicleNumberPlate: string
  driverName: string
  vehicleType?: string | null
  destinationOrPurpose?: string | null
  status?: string | null
  dispatchTime?: string | null
  expectedReturnTime?: string | null
  actualReturnTime?: string | null
}

const norm = (s: string | null | undefined) =>
  (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

async function main() {
  if (!API_KEY) throw new Error('No provider API key (RAIFACTORYSUITE_API_KEY)')

  console.log(`→ GET ${API_URL}/dispatches?limit=${LIMIT}`)
  const res = await fetch(`${API_URL}/dispatches?limit=${LIMIT}`, {
    headers: { accept: 'application/json', 'X-API-Key': API_KEY },
  })
  if (!res.ok) throw new Error(`provider ${res.status} ${res.statusText}`)
  const rows = (await res.json()) as Row[]
  console.log(`  ← ${rows.length} dispatch rows`)

  // Org ids and the plate → vehicle map, resolved once. 597 vehicles is one
  // query; doing it per row would be 1000.
  const orgIds = new Map<string, string>()
  for (const code of new Set(Object.values(FACTORY_TO_ORG))) {
    const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
    if (org) orgIds.set(code, org.id)
    else console.warn(`  ! organisation ${code} not found — its dispatches will be skipped`)
  }
  const vehicles = await prisma.vehicle.findMany({
    where:  { organisationId: { in: [...orgIds.values()] } },
    select: { id: true, registrationPlate: true },
  })
  const byPlate = new Map(vehicles.map(v => [norm(v.registrationPlate), v.id]))

  let created = 0, updated = 0, skipped = 0, unmatched = 0
  for (const d of rows) {
    const orgCode = FACTORY_TO_ORG[d.factoryCode]
    const organisationId = orgCode ? orgIds.get(orgCode) : undefined
    if (!organisationId) { skipped++; continue }

    const plate = norm(d.vehicleNumberPlate)
    const vehicleId = byPlate.get(plate) ?? null
    if (!vehicleId) unmatched++

    const row = {
      organisationId,
      vehicleId,
      plate,
      driverName:       d.driverName?.trim() ?? '',
      destination:      d.destinationOrPurpose?.trim() || null,
      status:           (d.status ?? 'DISPATCHED').toUpperCase(),
      dispatchedAt:     parseProviderTimeOr(d.dispatchTime),
      expectedReturnAt: parseProviderTime(d.expectedReturnTime),
      actualReturnAt:   parseProviderTime(d.actualReturnTime),
      source:           'backfill',
    }

    if (DRY) { created++; continue }
    const before = await prisma.dispatch.findUnique({ where: { externalId: d.id }, select: { id: true } })
    await prisma.dispatch.upsert({
      where:  { externalId: d.id },
      create: { externalId: d.id, ...row },
      update: row,
    })
    if (before) updated++; else created++
  }

  console.log(
    `${DRY ? '[dry] ' : ''}dispatches: ${created} new, ${updated} updated, ` +
    `${skipped} skipped (unknown factory), ${unmatched} with no vehicle match`,
  )

  // What the ETA can actually be built from, stated plainly rather than assumed.
  const stats = await prisma.$queryRaw<{ destination: string; n: bigint; median_h: number }[]>`
    SELECT destination,
           COUNT(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (actual_return_at - dispatched_at)) / 3600
           ) AS median_h
    FROM dispatches
    WHERE actual_return_at IS NOT NULL
      AND destination IS NOT NULL
      AND actual_return_at > dispatched_at
    GROUP BY destination
    HAVING COUNT(*) >= 5
    ORDER BY n DESC
    LIMIT 10
  `
  const open = await prisma.dispatch.count({ where: { actualReturnAt: null, status: { in: ['DISPATCHED', 'OVERDUE'] } } })
  console.log(`\nopen dispatches now: ${open}`)
  console.log('destinations with >= 5 completed trips (top 10):')
  for (const s of stats) {
    console.log(`  ${s.destination.padEnd(22)} n=${String(s.n).padStart(3)}  median ${Number(s.median_h).toFixed(1)} h`)
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
