/**
 * Rewrite stored registrations into the form they are written in.
 *
 * `sync:wialon` stored the COMPARISON form of a plate rather than the written
 * one when Menengai and West Sugar were onboarded on 2026-08-31 — the parser
 * returned `normalisePlate`, which strips the space. The result was one
 * database holding a registration in two shapes:
 *
 *     SUKARI     KHMA 994J    (598 rows, from factorysuite)
 *     MENENGAI   KAT087E      (225 rows)
 *     WESTSUGAR  KTCB686Z     (420 rows)
 *
 * …and a plate on screen that matched neither the vehicle's own name
 * ("LOGYARD - Menengai - KAT 087E") nor anything printed on a vehicle.
 *
 * The code is fixed, so anything synced from now on is written correctly. This
 * is the one-off for rows already in the table.
 *
 * ## Collisions are reported, never resolved
 *
 * Three West Sugar machines name Sukari plant. Today they do not collide only
 * because the two rows are spelled differently — "KHMA520K" against
 * "KHMA 520K" — and putting them in one format makes them byte-identical on a
 * UNIQUE column. This script refuses those three and prints them, because
 * which organisation owns a loader is not a question a formatting script gets
 * to answer. (For what it is worth: the Sukari rows carry factorysuite UUIDs
 * and have never received a single fix, while the West Sugar ones are
 * Wialon-bound and reporting today.)
 *
 * Idempotent. Dry-run unless --apply.
 *
 * Run: npm run fix:plates
 *      npm run fix:plates -- --apply
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { formatPlate, normalisePlate } from '../src/providers/wialon/wialon.unit-name.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(`\n🔤  Registration format — ${APPLY ? 'APPLYING' : 'dry run'}\n`)

  const vehicles = await prisma.vehicle.findMany({
    select: {
      id: true, registrationPlate: true, name: true,
      organisation: { select: { code: true } },
    },
  })
  console.log(`  ${vehicles.length} vehicles in the database`)

  // Every plate currently held, so a rewrite can be checked before it is tried.
  const taken = new Map(vehicles.map(v => [v.registrationPlate, v.organisation.code]))

  const changes: Array<{ id: string; from: string; to: string; org: string; name: string }> = []
  const blocked: Array<{ from: string; to: string; org: string; heldBy: string; name: string }> = []

  for (const v of vehicles) {
    const next = formatPlate(v.registrationPlate)
    if (next === v.registrationPlate) continue          // already right, or not a plate

    const holder = taken.get(next)
    if (holder != null) {
      blocked.push({ from: v.registrationPlate, to: next, org: v.organisation.code, heldBy: holder, name: v.name })
      continue
    }
    changes.push({ id: v.id, from: v.registrationPlate, to: next, org: v.organisation.code, name: v.name })
  }

  const byOrg = new Map<string, number>()
  for (const c of changes) byOrg.set(c.org, (byOrg.get(c.org) ?? 0) + 1)

  console.log(`\n  to rewrite: ${changes.length}`)
  for (const [org, n] of [...byOrg].sort((a, b) => b[1] - a[1])) console.log(`      ${String(n).padStart(4)}  ${org}`)
  for (const c of changes.slice(0, 8)) {
    console.log(`      ${c.from.padEnd(12)} → ${c.to.padEnd(12)}  ${c.name}`)
  }
  if (changes.length > 8) console.log(`      … and ${changes.length - 8} more`)

  if (blocked.length > 0) {
    console.log(`\n  ⚠  ${blocked.length} refused — the formatted plate is already held by another row:`)
    for (const b of blocked) {
      console.log(`      ${b.from.padEnd(12)} → ${b.to.padEnd(12)}  held by ${b.heldBy}`)
      console.log(`      ${''.padEnd(12)}   ${b.org}: "${b.name}"`)
    }
    console.log(`      These keep their current spelling. Same machine in two organisations —`)
    console.log(`      an operator has to say which registry is right.`)
  }

  if (!APPLY) {
    console.log(`\n  Dry run — nothing written. Re-run with:  npm run fix:plates -- --apply\n`)
    return
  }

  let done = 0, failed = 0
  for (const c of changes) {
    try {
      await prisma.vehicle.update({ where: { id: c.id }, data: { registrationPlate: c.to } })
      done++
    } catch (err) {
      failed++
      console.error(`  ✗ ${c.from}: ${err instanceof Error ? err.message.split('\n').at(-1) : err}`)
    }
  }
  console.log(`\n  ✓ rewrote ${done} registration(s)${failed ? `, ${failed} failed` : ''}`)

  // Prove the outcome rather than assert it: every plate-shaped row should now
  // carry a space, and the whole column should still be unique.
  const after  = await prisma.vehicle.findMany({ select: { registrationPlate: true } })
  const plates = after.map(v => v.registrationPlate)
  const shaped = plates.filter(p => /^[A-Z]{2,4}\d{3,4}[A-Z]?$/.test(p))
  console.log(`  ✓ ${new Set(plates).size} distinct of ${plates.length} rows`)
  console.log(`  ${shaped.length === 0 ? '✓' : '⚠'} ${shaped.length} row(s) still stored without a space`)
  if (shaped.length > 0) console.log(`      ${shaped.slice(0, 5).map(normalisePlate).join(', ')}`)
  console.log()
}

main()
  .catch(err => { console.error('\n❌  fix-plate-format failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
