/**
 * Wialon unit registry sync — KASULU (Tanzania).
 *
 * Kasulu's vehicles exist ONLY in Wialon; they are not in factorysuite. So for
 * this org the Wialon unit *is* the registry entry — this script is the
 * counterpart of `sync:vehicles` (which covers Sukari from RaiFactorySuite).
 *
 * Two things happen per run, both idempotent:
 *
 *   1. every unit is upserted into `vehicles` keyed on
 *      `external_id = wialon:<unitId>` — namespaced so a Wialon id can never
 *      collide with a factorysuite UUID in the same column;
 *   2. each unit's LAST KNOWN position is written as a telemetry ping, so the
 *      map has something to draw before the live poller exists.
 *
 * Honesty rules carried over from the RaiFactorySuite cutover:
 *   • `capturedAt` is the provider's own timestamp, never "now" — a position
 *     that is nine days old must look nine days old on the map.
 *   • a unit that has never reported gets a vehicle row and NO telemetry, so
 *     it simply has no marker rather than a fabricated one.
 *   • nothing Wialon doesn't supply (fuel, odometer, cargo) is invented.
 *
 * Run: npm run sync:wialon
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { WialonClient, positionToTelemetry, type WialonUnit } from '../src/providers/wialon/wialon.client.js'
import { tankCapacityOf } from '../src/providers/wialon/wialon.sensors.js'
import { classifyUnit } from '../src/providers/wialon/wialon.vehicle-type.js'
import { KASULU_WIALON_ACCOUNT_ID } from '../src/providers/wialon/wialon.account.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL = process.env.WIALON_API_URL ?? 'https://hst-api.wialon.com'
// `access_token` is the original name this was stored under; WIALON_TOKEN is
// the canonical one.
const TOKEN   = process.env.WIALON_TOKEN || process.env.access_token || ''

/** Wialon account → our organisation. */
const ORG_CODE   = 'KASULU'
const GROUP_NAME = 'TRACKED UNITS'

/**
 * Wialon exposes no registration plates — the custom fields on this account are
 * telematics metadata (PROBE IDENTIFIER, SIMCARD ICCID, TIGO…), not plates —
 * and unit names are unique. So the unit name IS the identifier we display.
 * Ask the reseller to populate real plates; this maps cleanly onto them later.
 */
const plateOf = (u: WialonUnit): string => u.nm.trim()


async function main() {
  if (!TOKEN) throw new Error('WIALON_TOKEN (or access_token) is not set')
  console.log(`\n🔄  Wialon unit sync — ${API_URL} → org ${ORG_CODE}\n`)

  const org = await prisma.organisation.findUnique({ where: { code: ORG_CODE }, select: { id: true } })
  if (!org) throw new Error(`Organisation ${ORG_CODE} not found — run npm run seed:kasulu first`)

  const client = new WialonClient(TOKEN, API_URL)
  await client.login()

  // ONLY Kasulu's own units. The token can see eight customers' fleets — 1,504
  // units — and this script writes every unit it is handed into ORG_CODE as a
  // vehicle. Unfiltered it would have created 1,286 spurious rows here. The
  // account id is the boundary; see providers/wialon/wialon.account.
  const units = await client.listUnits(KASULU_WIALON_ACCOUNT_ID)
  if (units.length === 0) {
    throw new Error('Wialon returned no units — refusing to deactivate the whole fleet on a bad response')
  }
  console.log(`  ← ${units.length} units from Wialon account ${KASULU_WIALON_ACCOUNT_ID}`)

  // A registry sync should refresh a fleet, never replace one. If the unit list
  // has shrunk or grown by more than half, something upstream changed shape —
  // an account moved, the token lost a right — and the correct response is to
  // stop and have someone look, not to deactivate or invent hundreds of rows.
  const known = await prisma.vehicle.count({ where: { organisationId: org.id } })
  if (known > 0 && (units.length < known / 2 || units.length > known * 2)) {
    throw new Error(
      `Refusing to sync: Wialon returned ${units.length} units for account ${KASULU_WIALON_ACCOUNT_ID}, ` +
      `but ${ORG_CODE} holds ${known} vehicles. That is too large a change to apply unattended — ` +
      `check the account id and the token's access before re-running.`,
    )
  }

  // One group for the org; Wialon gives us no classification to split on.
  const groupCode = `${ORG_CODE}_${GROUP_NAME.replace(/\s+/g, '_')}`
  const group = await prisma.vehicleGroup.upsert({
    where:  { organisationId_code: { organisationId: org.id, code: groupCode } },
    update: {},
    create: { organisationId: org.id, name: GROUP_NAME, code: groupCode },
    select: { id: true },
  })

  let created = 0, updated = 0, failed = 0
  let pings = 0, noPosition = 0, stale = 0, withTank = 0
  const seen: string[] = []
  const now = Date.now()

  for (const u of units) {
    const externalId = `wialon:${u.id}`
    seen.push(externalId)

    const data = {
      organisationId:    org.id,
      vehicleGroupId:    group.id,
      name:              u.nm.trim(),
      registrationPlate: plateOf(u),
      // Wialon has no body-type field; classified from the operator's declared
      // TYPE where present, else the equipment code in the unit name.
      vehicleType:       classifyUnit(u.nm, u.flds),
      status:            u.pos ? 'TRACKING' : 'NO_SIGNAL',
      isActive:          true,
      // Tank size is not a Wialon field — the operator writes it into the fuel
      // sensor's NAME, e.g. "Main Tank Fuel Level Qty (450L)". It is the only
      // source available, and without it no fuel PERCENTAGE can be computed.
      tankCapacityLitres: tankCapacityOf(u.sens),
    }

    if (data.tankCapacityLitres != null) withTank++

    let vehicleId: string
    try {
      const existing = await prisma.vehicle.findUnique({ where: { externalId }, select: { id: true } })
      if (existing) {
        await prisma.vehicle.update({ where: { externalId }, data })
        vehicleId = existing.id
        updated++
      } else {
        const v = await prisma.vehicle.create({
          data: { ...data, externalId, deviceId: externalId },
          select: { id: true },
        })
        vehicleId = v.id
        created++
      }
    } catch (err) {
      failed++
      console.error(`  ✗ ${u.nm} (${externalId}):`, err instanceof Error ? err.message.split('\n').at(-1) : err)
      continue
    }

    // ── last known position → telemetry ────────────────────────────────────
    if (!u.pos) { noPosition++; continue }

    const t = positionToTelemetry(u.pos)
    if (!Number.isFinite(t.lat) || !Number.isFinite(t.lng)) { noPosition++; continue }
    if (now - t.capturedAt.getTime() > 30 * 86_400_000) stale++

    // Don't re-write a ping we already hold for this exact fix.
    const already = await prisma.vehicleTelemetry.findFirst({
      where:  { vehicleId, capturedAt: t.capturedAt },
      select: { id: true },
    })
    if (already) continue

    const row = await prisma.vehicleTelemetry.create({
      data: {
        vehicleId,
        deviceId:       externalId,
        capturedAt:     t.capturedAt,
        receivedAt:     new Date(),
        lat:            t.lat,
        lng:            t.lng,
        altitudeM:      t.altitudeM,
        speedKmh:       t.speedKmh,
        headingDeg:     t.headingDeg,
        engineOn:       t.engineOn,
        // Fuel, cargo and odometer are not in `pos` — left NULL, not guessed.
      },
      select: { id: true },
    })
    await prisma.vehicleTelemetryRaw.create({
      data: { telemetryId: row.id, payload: { source: 'wialon', unitId: u.id, pos: u.pos } as object },
    })
    pings++
  }

  // Units that vanished upstream keep their history but leave the live fleet.
  const gone = await prisma.vehicle.updateMany({
    where: { organisationId: org.id, externalId: { startsWith: 'wialon:', notIn: seen }, isActive: true },
    data:  { isActive: false },
  })

  console.log(`\n  ✓ vehicles: created ${created}, updated ${updated}, failed ${failed}`)
  console.log(`  ✓ positions: ${pings} new pings written, ${noPosition} units have never reported`)
  console.log(`  ✓ tank capacity resolved from the fuel sensor name for ${withTank} units`)
  if (stale > 0) console.log(`    · ${stale} of those fixes are over 30 days old — they will show on the map as long-stale`)
  if (gone.count > 0) console.log(`  ✓ deactivated ${gone.count} units no longer in Wialon`)

  const total = await prisma.vehicle.count({ where: { organisationId: org.id, isActive: true } })
  console.log(`\n✅  ${ORG_CODE} now has ${total} active vehicles.\n`)

  await client.logout()
}

main()
  .catch(err => { console.error('\n❌  sync-wialon failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
