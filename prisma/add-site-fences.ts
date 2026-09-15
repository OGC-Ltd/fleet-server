/**
 * Site boundaries surveyed by hand, as geofences.
 *
 * Rings come from operator-drawn Google Earth KML, not from Wialon. Wialon's
 * own zones are synced by `sync-geofences.ts`, which upserts on `external_id`
 * and REWRITES GEOMETRY ON EVERY RUN (it preserves only `mode` and
 * `isActive`). So a hand-surveyed boundary cannot live on a synced row — it
 * would be silently replaced by the provider's looser version the next time
 * the sync ran.
 *
 * Everything created here therefore has `externalId` NULL. That is the whole
 * mechanism: no external id, no upsert match, nothing to overwrite.
 *
 * Only Raiply is created now. Naitiri already had a Wialon fence
 * (`wialon:zone:22`, 68.72 ha) naming the same site, and two rows for one site
 * meant two feed lines for one movement, so the surveyed Naitiri ring has been
 * retired — see RETIRED below. Raiply has no provider zone at all.
 *
 * ## isActive is FALSE, and that is the whole point
 *
 * These are reference geometry: something to see and to measure arrivals
 * against, not a rule to enforce. The distinction is not cosmetic, because
 * `zone-presence` derives
 *
 *     keepOut = isActive && mode === 'BLOCKLIST'
 *
 * and a keep-out zone puts "entered X, a RESTRICTED zone" in the live feed for
 * every unit that arrives. Created active, these two did exactly that: Naitiri
 * is where the lorries are SUPPOSED to go, and the feed filled with warnings
 * about trucks doing their job.
 *
 * Inactive is not the same as invisible. The overlay draws every fence
 * regardless (Mufindi's estate is 90 inactive rows out of 97), zone-presence
 * still loads them and still reports ARRIVALS from them — `arrivals` is
 * exactly the set that is NOT keepOut — and `ingest` ignores them, both
 * because it filters `isActive: true` and because it only evaluates fences
 * assigned to the vehicle.
 *
 * ALLOWLIST is NOT the fix and is strictly worse: `ingest.service.ts` reads it
 * as "the vehicle must stay INSIDE", so an allowlisted Naitiri would make a
 * violation of every unit that is anywhere else — nearly the whole fleet.
 *
 * `mode: BLOCKLIST` therefore matches all 109 fences already in the table, NOT
 * the schema's ALLOWLIST default. With isActive false it enforces nothing; it
 * is simply the mode this deployment writes.
 *
 * `geom` is left unset on purpose — the `geofences_geom_sync` trigger derives
 * it from `polygonCoords`. Nothing in the app writes it.
 *
 * GATE coordinates are recorded in the notes below rather than in a column:
 * `geofences` has nowhere to put a site's reference point, and the gate is
 * what a trip actually starts and ends at. See `webhooks/factory-map.ts`
 * FACTORIES for where a site's lat/lng is consumed today.
 *
 * Idempotent: a fence is matched on (organisation, name) before being created.
 *
 * Dry run unless --apply.
 *
 * Run: npm run add:fences
 *      npm run add:fences -- --apply
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

const APPLY = process.argv.includes('--apply')
const ORG_CODE = 'WESTSUGAR'

type Site = {
  name: string
  /** GeoJSON LinearRing, [lng, lat], first point repeated last. */
  ring: number[][]
  /** The gate: where a unit actually enters and leaves. [lng, lat]. */
  gate: [number, number]
}

const SITES: Site[] = [
  {
    name: 'Raiply',
    gate: [35.249393582, 0.530861608],
    ring: [
    [35.247621246,0.535528646], [35.247720915,0.535238519], [35.248185564,0.534054426],
    [35.248502798,0.533239726], [35.249375849,0.53095717], [35.249405943,0.530864624],
    [35.250810981,0.53137818], [35.2509454,0.531252354], [35.252014552,0.531712611],
    [35.253274214,0.532271591], [35.253874345,0.532459552], [35.253977552,0.532610115],
    [35.254002914,0.532828023], [35.253939856,0.532989237], [35.253561857,0.533274061],
    [35.252885146,0.533873394], [35.252481275,0.534522282], [35.252416651,0.534754305],
    [35.252345743,0.535091479], [35.252305682,0.535340881], [35.252264926,0.535648104],
    [35.25224443,0.535903463], [35.252091036,0.536976156], [35.252002743,0.537649969],
    [35.251868876,0.538567584], [35.251625764,0.539184517], [35.251494925,0.539407895],
    [35.250770833,0.540630795], [35.250150134,0.541520287], [35.249579331,0.54227047],
    [35.248434124,0.53915613], [35.247360001,0.536216658], [35.247621246,0.535528646]
    ],
  },
]

/**
 * Fences this script used to create and must now remove.
 *
 * Naitiri was double-covered: Wialon's own `wialon:zone:22` already names the
 * same site, so one lorry leaving produced two feed lines —
 * "left Naitiri Factory." and "left Naitiri Factory (surveyed)." — and
 * sometimes both inside one sentence. The surveyed ring was the tighter and
 * better of the two, but the visual it existed to provide now comes from the
 * `naitiri-site.geojson` site plan in `dash`, which needs no row here. So the
 * duplicate goes and the provider's row stays, since that is the one the
 * provider will keep re-creating anyway.
 *
 * Raiply has no Wialon zone. Its fence is the only thing that knows where
 * Raiply is, and it stays.
 *
 * Listed rather than deleted-and-forgotten so a re-run converges on the same
 * state instead of resurrecting what the last run removed.
 */
const RETIRED: string[] = ['Naitiri Factory (surveyed)']

async function main() {
  console.log(`\n🗺  Surveyed site fences — ${APPLY ? 'APPLYING' : 'DRY RUN'}
`)

  const org = await prisma.organisation.findUnique({
    where: { code: ORG_CODE }, select: { id: true, name: true },
  })
  if (!org) throw new Error(`organisation ${ORG_CODE} not found`)
  console.log(`org: ${org.name}\n`)

  for (const name of RETIRED) {
    const gone = await prisma.geofence.findFirst({
      where: { organisationId: org.id, name },
      select: { id: true, _count: { select: { vehicles: true, violations: true } } },
    })
    if (!gone) {
      console.log(`  ${name.padEnd(28)} already absent`)
      continue
    }
    // `VehicleGeofence` cascades; `GeofenceViolation` does not, and deleting a
    // fence that has violations would erase the evidence for them, so refuse.
    if (gone._count.violations > 0) {
      throw new Error(
        `${name}: ${gone._count.violations} violation(s) reference this fence — not deleting`)
    }
    console.log(
      `  ${name.padEnd(28)} REMOVE  ${gone._count.vehicles} assignment(s) cascade`)
    if (APPLY) await prisma.geofence.delete({ where: { id: gone.id } })
  }

  for (const site of SITES) {
    const first = site.ring[0]
    const last = site.ring[site.ring.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw new Error(`${site.name}: ring is not closed`)
    }

    const existing = await prisma.geofence.findFirst({
      where: { organisationId: org.id, name: site.name },
      select: { id: true, isActive: true },
    })
    if (existing) {
      // Repair, not just report: the first run of this script created both
      // fences ACTIVE, which made them keep-out zones. Anything already in
      // that state is corrected here rather than left for someone to find in
      // the feed.
      if (existing.isActive) {
        console.log(`  ${site.name.padEnd(28)} exists, ACTIVE — deactivating (was a keep-out)`)
        if (APPLY) {
          await prisma.geofence.update({
            where: { id: existing.id }, data: { isActive: false },
          })
        }
      } else {
        console.log(`  ${site.name.padEnd(28)} exists — left alone`)
      }
      continue
    }

    if (APPLY) {
      await prisma.geofence.create({
        data: {
          organisationId: org.id,
          name: site.name,
          type: 'POLYGON',
          mode: 'BLOCKLIST',
          polygonCoords: site.ring,
          // See the note above — active would make this a keep-out.
          isActive: false,
        },
      })
    }
    console.log(
      `  ${site.name.padEnd(28)} CREATE  ${site.ring.length} pts  ` +
      `gate ${site.gate[1].toFixed(6)}, ${site.gate[0].toFixed(6)}`)
  }

  if (!APPLY) console.log('\nDRY RUN — nothing written. Re-run with --apply.')
}

main()
  .catch((e) => { console.error('\n✗', e.message); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
