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
 * Naitiri already has a Wialon fence (`wialon:zone:22`, 68.72 ha, inactive).
 * It is deliberately left alone — the surveyed ring is 46.56 ha and 98.6%
 * contained within it, i.e. the same site drawn 22 ha tighter. Two rows, one
 * dormant, is the price of a boundary the sync cannot touch.
 *
 * `mode: BLOCKLIST` matches all 109 fences already in the table, NOT the
 * schema's ALLOWLIST default.
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
    name: 'Naitiri Factory (surveyed)',
    gate: [34.87704574, 0.781157685],
    ring: [
    [34.881483462,0.787252077], [34.875783612,0.782886858], [34.876997323,0.781201774],
    [34.877050306,0.781212639], [34.877116614,0.781149096], [34.877074397,0.781088514],
    [34.878813228,0.778702576], [34.883184238,0.78104791], [34.88133056,0.783317877],
    [34.883552014,0.78480551], [34.883294917,0.785147214], [34.883736351,0.785420209],
    [34.883578186,0.785711276], [34.883947038,0.785943223], [34.883935016,0.786050096],
    [34.883400401,0.786704398], [34.884000686,0.787245583], [34.883868107,0.787514942],
    [34.883649815,0.787600181], [34.881982677,0.787400488], [34.881483462,0.787252077]
    ],
  },
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

async function main() {
  console.log(`\n🗺  Surveyed site fences — ${APPLY ? 'APPLYING' : 'DRY RUN'}
`)

  const org = await prisma.organisation.findUnique({
    where: { code: ORG_CODE }, select: { id: true, name: true },
  })
  if (!org) throw new Error(`organisation ${ORG_CODE} not found`)
  console.log(`org: ${org.name}\n`)

  for (const site of SITES) {
    const first = site.ring[0]
    const last = site.ring[site.ring.length - 1]
    if (first[0] !== last[0] || first[1] !== last[1]) {
      throw new Error(`${site.name}: ring is not closed`)
    }

    const existing = await prisma.geofence.findFirst({
      where: { organisationId: org.id, name: site.name }, select: { id: true },
    })
    if (existing) {
      console.log(`  ${site.name.padEnd(28)} exists — left alone`)
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
          isActive: true,
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
