/**
 * Wialon unit registry sync — for any fleet whose registry IS Wialon.
 *
 * Some fleets exist ONLY in Wialon; they are not in factorysuite. For those the
 * Wialon unit *is* the registry entry, and this script is the counterpart of
 * `sync:vehicles` (which covers Sukari from RaiFactorySuite). Which fleets, and
 * how each one's names are read, lives in providers/wialon/wialon.account.
 *
 * Two things happen per run, both idempotent:
 *
 *   1. every unit is upserted into `vehicles` keyed on
 *      `external_id = wialon:<unitId>` — namespaced so a Wialon id can never
 *      collide with a factorysuite UUID in the same column;
 *   2. each unit's LAST KNOWN position is written as a telemetry ping, so the
 *      map has something to draw before the live poller picks it up.
 *
 * Honesty rules carried over from the RaiFactorySuite cutover:
 *   • `capturedAt` is the provider's own timestamp, never "now" — a position
 *     that is nine days old must look nine days old on the map.
 *   • a unit that has never reported gets a vehicle row and NO telemetry, so
 *     it simply has no marker rather than a fabricated one.
 *   • nothing Wialon doesn't supply (fuel, odometer, cargo) is invented.
 *
 * The sync itself lives in src/providers/wialon/wialon.registry-sync.ts and also
 * runs every 30 minutes inside the server (lib/queues/wialon-registry.ts); this
 * script is the by-hand way in, and still the only way past the guard that
 * refuses a fleet whose unit count halved or doubled.
 *
 * DRY RUN BY DEFAULT. This creates hundreds of rows in a shared production
 * database and there is no undo, so it prints what it would do and stops —
 * the same bargain `sync:sukari-gps` already makes.
 *
 * Run: npm run sync:wialon                    (KASULU, preview)
 *      npm run sync:menengai                  (MENENGAI, preview)
 *      npm run sync:westsugar                 (WESTSUGAR, preview)
 *      …add -- --apply to any of them to commit.
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { WialonClient } from '../src/providers/wialon/wialon.client.js'
import { findFleet, syncableOrgCodes } from '../src/providers/wialon/wialon.account.js'
import { WialonUnitSource, syncWialonFleet } from '../src/providers/wialon/wialon.registry-sync.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL = process.env.WIALON_API_URL ?? 'https://hst-api.wialon.com'
// `access_token` is the original name this was stored under; WIALON_TOKEN is
// the canonical one.
const TOKEN   = process.env.WIALON_TOKEN || process.env.access_token || ''

/**
 * Read a `--flag=value` argument. The LAST occurrence wins, which is not a
 * detail: the npm scripts bake an org in (`sync:wialon` passes --org=KASULU),
 * so `npm run sync:wialon -- --org=MENENGAI` arrives with both. First-wins
 * would silently sync the wrong fleet while echoing the right name.
 */
const argValue = (flag: string): string | null => {
  for (let i = process.argv.length - 1; i >= 0; i--) {
    const a = process.argv[i]!
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1)
  }
  return null
}
const ORG_CODE = argValue('--org')
const APPLY    = process.argv.includes('--apply')

async function main() {
  if (!TOKEN) throw new Error('WIALON_TOKEN (or access_token) is not set')
  if (!ORG_CODE) {
    throw new Error(
      `--org=CODE is required. Known fleets: ${syncableOrgCodes().join(', ')}. ` +
      `It is not defaulted because this script writes a whole fleet into whichever org it is given.`,
    )
  }
  const fleet = findFleet(ORG_CODE)
  if (!fleet) {
    throw new Error(
      `No Wialon fleet is defined for "${ORG_CODE}". Known: ${syncableOrgCodes().join(', ')}. ` +
      `A fleet whose registry comes from another provider (Sukari) cannot be synced here — ` +
      `see providers/wialon/wialon.account.`,
    )
  }

  console.log(`\n🔄  Wialon unit sync — ${API_URL} → org ${fleet.orgCode}  ${APPLY ? '(APPLYING)' : '(dry run)'}\n`)

  const client = new WialonClient(TOKEN, API_URL)
  await client.login()
  try {
    const r = await syncWialonFleet(prisma, new WialonUnitSource(client), fleet, { apply: APPLY, positions: 'all' })

    console.log(
      `  ← ${r.units} units from Wialon account ${r.accountId}` +
      (fleet.nameMask ? ` matching ${fleet.nameMask} (of ${r.inAccount} in the account)` : ''),
    )
    if (r.twoDevice.length > 0) {
      console.log(`\n  ⚠  ${r.twoDevice.length} unit(s) share a plate with another unit — a second device on one vehicle:`)
      for (const u of r.twoDevice.slice(0, 10)) console.log(`      "${u.name}" → "${u.plate}"; plate ${u.wanted} goes to the shorter-named unit`)
    }
    if (r.sameName.length > 0) {
      console.log(`\n  ⚠  ${r.sameName.length} unit(s) carry no plate AND share their name with another unit.`)
      console.log(`      Qualified with the Wialon unit id, because nothing else about them is distinct:`)
      for (const u of r.sameName.slice(0, 6)) console.log(`      "${u.name}" → "${u.plate}"`)
      if (r.sameName.length > 6) console.log(`      … and ${r.sameName.length - 6} more`)
    }
    if (r.crossOrg.length > 0) {
      console.log(`\n  ⚠  ${r.crossOrg.length} registration(s) already exist under another organisation:`)
      for (const c of r.crossOrg.slice(0, 10)) {
        console.log(`      ${c.plate.padEnd(12)} → ${c.code.padEnd(9)} ${c.blocked ? 'SKIPPED — identical plate string' : 'imported anyway — same machine, different formatting'}`)
        console.log(`      ${''.padEnd(12)}   "${c.name}"`)
      }
    }
    console.log(`\n  vehicle groups (${r.groups.length}):`)
    for (const g of r.groups) console.log(`      ${String(g.count).padStart(4)}  ${g.name.padEnd(24)} ${g.code}`)

    console.log(`\n  ── plan ─────────────────────────────────────────────────`)
    console.log(`  create ${r.toCreate.length}, update ${r.toUpdate.length} (${r.unchanged} unchanged), deactivate ${r.toDeactivate.length}, skip ${r.skipped} on a plate conflict`)
    console.log(`  ${r.withPos} unit(s) carry a last known position and would get one telemetry ping each`)
    console.log(`  ${r.withTank} unit(s) state a tank capacity in the fuel sensor name; ${r.units - r.withTank} do not.`)
    for (const v of r.toCreate.slice(0, 8)) console.log(`      + ${v.plate.padEnd(28)} ${v.type.padEnd(12)} ${v.name}`)
    if (r.toCreate.length > 8) console.log(`      … and ${r.toCreate.length - 8} more`)
    for (const v of r.toUpdate.slice(0, 8)) console.log(`      ~ ${v.plate.padEnd(28)} ${v.fields.join(', ')}`)
    if (r.toUpdate.length > 8) console.log(`      … and ${r.toUpdate.length - 8} more`)
    for (const v of r.toDeactivate.slice(0, 8)) console.log(`      − ${v.plate.padEnd(28)} ${v.name} (gone from Wialon)`)
    if (r.toDeactivate.length > 8) console.log(`      … and ${r.toDeactivate.length - 8} more`)
    if (r.handOvers.length > 0) {
      console.log(`\n  ↪  ${r.handOvers.length} plate(s) pass from a unit that left Wialon to its replacement:`)
      for (const h of r.handOvers) console.log(`      ${h.plate}: ${h.externalId} "${h.name}" (gone) → released`)
    }

    if (!r.applied) {
      console.log(`\n  Dry run — nothing written. Re-run with:  npm run sync:wialon -- --org=${fleet.orgCode} --apply\n`)
      return
    }
    const a = r.applied
    console.log(`\n  ✓ vehicles: created ${a.created}, updated ${a.updated}, unchanged ${r.unchanged}, skipped ${r.skipped}, failed ${a.failed}`)
    for (const f of a.failures) console.error(`  ✗ ${f.name} (${f.externalId}): ${f.error}`)
    console.log(`  ✓ positions: ${a.pings} new pings written`)
    if (a.stale > 0) console.log(`    · ${a.stale} of those fixes are over 30 days old — they will show on the map as long-stale`)
    if (a.deactivated > 0) console.log(`  ✓ deactivated ${a.deactivated} units no longer in Wialon`)

    const org = await prisma.organisation.findUnique({ where: { code: fleet.orgCode }, select: { id: true } })
    const total = await prisma.vehicle.count({ where: { organisationId: org!.id, isActive: true } })
    console.log(`\n✅  ${fleet.orgCode} now has ${total} active vehicles.\n`)
  } finally {
    await client.logout()
  }
}

main()
  .catch(err => { console.error('\n❌  sync-wialon failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
