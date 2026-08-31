/**
 * Wialon unit registry sync — for any fleet that owns its Wialon account.
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
 * DRY RUN BY DEFAULT. This creates hundreds of rows in a shared production
 * database and there is no undo, so it prints what it would do and stops —
 * the same bargain `sync:sukari-gps` already makes.
 *
 * Run: npm run sync:wialon                    (KASULU, preview)
 *      npm run sync:wialon -- --apply
 *      npm run sync:menengai                  (MENENGAI, preview)
 *      npm run sync:menengai -- --apply
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import { WialonClient, positionToTelemetry, type WialonUnit } from '../src/providers/wialon/wialon.client.js'
import { tankCapacityOf } from '../src/providers/wialon/wialon.sensors.js'
import { classifyUnit } from '../src/providers/wialon/wialon.vehicle-type.js'
import { findFleet, syncableOrgCodes } from '../src/providers/wialon/wialon.account.js'

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

/**
 * One physical vehicle can carry two trackers, and then two units name one
 * plate. Both measured cases in Menengai are exactly that — a truck with a
 * replacement device ("… - KCC 386Z" beside "… - KCC 386Z - FMB140") and the
 * MDVR truck ("VS - Menengai - KCS 078M" beside "VS Menengai CAMERA - …").
 *
 * `registration_plate` is globally unique, so only one of each pair can hold
 * it. Both still get a row — they are separate telemetry sources — and the
 * loser is labelled with its full unit name, which is the visible, accurate
 * statement that it is the second device on that vehicle.
 *
 * The winner is the SHORTER name: a second device is announced by a suffix, so
 * the base name is the one without one. Unit id breaks a tie, only so that two
 * runs never disagree.
 */
function resolvePlates(units: WialonUnit[], plateOf: (nm: string) => string): Map<number, string> {
  const claims = new Map<string, WialonUnit[]>()
  for (const u of units) {
    const p = plateOf(u.nm)
    claims.set(p, [...(claims.get(p) ?? []), u])
  }

  const out = new Map<number, string>()
  for (const [plate, claimants] of claims) {
    if (claimants.length === 1) { out.set(claimants[0]!.id, plate); continue }
    const ranked = [...claimants].sort((a, b) => a.nm.trim().length - b.nm.trim().length || a.id - b.id)
    out.set(ranked[0]!.id, plate)
    for (const loser of ranked.slice(1)) out.set(loser.id, loser.nm.trim())
  }
  return out
}

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
      `A fleet with no account of its own (West Kenya Sugar, Sukari) cannot be synced here — ` +
      `see providers/wialon/wialon.account.`,
    )
  }

  console.log(`\n🔄  Wialon unit sync — ${API_URL} → org ${fleet.orgCode}  ${APPLY ? '(APPLYING)' : '(dry run)'}\n`)

  const org = await prisma.organisation.findUnique({ where: { code: fleet.orgCode }, select: { id: true } })
  if (!org) throw new Error(`Organisation ${fleet.orgCode} not found — run: npm run seed:org -- --code=${fleet.orgCode}`)

  const client = new WialonClient(TOKEN, API_URL)
  await client.login()

  // ONLY this fleet's own units. The token can see eight customers' fleets —
  // 1,496 units — and this script writes every unit it is handed into the org
  // as a vehicle. Unfiltered it would create over a thousand spurious rows.
  // The account id is the boundary; see providers/wialon/wialon.account.
  const units = await client.listUnits(fleet.accountId)
  if (units.length === 0) {
    throw new Error('Wialon returned no units — refusing to deactivate the whole fleet on a bad response')
  }
  console.log(`  ← ${units.length} units from Wialon account ${fleet.accountId}`)

  // A registry sync should refresh a fleet, never replace one. If the unit list
  // has shrunk or grown by more than half, something upstream changed shape —
  // an account moved, the token lost a right — and the correct response is to
  // stop and have someone look, not to deactivate or invent hundreds of rows.
  const known = await prisma.vehicle.count({ where: { organisationId: org.id } })
  if (known > 0 && (units.length < known / 2 || units.length > known * 2)) {
    throw new Error(
      `Refusing to sync: Wialon returned ${units.length} units for account ${fleet.accountId}, ` +
      `but ${fleet.orgCode} holds ${known} vehicles. That is too large a change to apply unattended — ` +
      `check the account id and the token's access before re-running.`,
    )
  }

  // ── plates ────────────────────────────────────────────────────────────────
  const plateFor = resolvePlates(units, fleet.plateOf)
  const shared   = units.filter(u => plateFor.get(u.id) === u.nm.trim() && fleet.plateOf(u.nm) !== u.nm.trim())
  if (shared.length > 0) {
    console.log(`\n  ⚠  ${shared.length} unit(s) share a plate with another unit — a second device on one vehicle:`)
    for (const u of shared) {
      console.log(`      "${u.nm}" keeps its unit name; plate ${fleet.plateOf(u.nm)} goes to the shorter-named unit`)
    }
  }

  // `registration_plate` is unique across the WHOLE table, not per org. A
  // collision with another organisation's vehicle would fail mid-apply, one
  // row at a time, so it is worth knowing before rather than during.
  const wanted   = [...plateFor.values()]
  const conflict = await prisma.vehicle.findMany({
    where:  { registrationPlate: { in: wanted }, organisationId: { not: org.id } },
    select: { registrationPlate: true, organisation: { select: { code: true } } },
  })
  if (conflict.length > 0) {
    console.log(`\n  ⚠  ${conflict.length} plate(s) already belong to another organisation and will be SKIPPED:`)
    for (const c of conflict.slice(0, 10)) console.log(`      ${c.registrationPlate} → ${c.organisation.code}`)
  }
  const blocked = new Set(conflict.map(c => c.registrationPlate))

  // ── groups ────────────────────────────────────────────────────────────────
  const groups = new Map<string, { name: string; count: number }>()
  for (const u of units) {
    const g = fleet.groupOf(u.nm)
    groups.set(g.code, { name: g.name, count: (groups.get(g.code)?.count ?? 0) + 1 })
  }
  console.log(`\n  vehicle groups (${groups.size}):`)
  for (const [code, g] of [...groups].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`      ${String(g.count).padStart(4)}  ${g.name.padEnd(24)} ${code}`)
  }

  // ── what the sync would change ────────────────────────────────────────────
  const withTank = units.filter(u => tankCapacityOf(u.sens) != null).length
  const withPos  = units.filter(u => u.pos).length
  const existing = new Set(
    (await prisma.vehicle.findMany({
      where:  { organisationId: org.id, externalId: { startsWith: 'wialon:' } },
      select: { externalId: true },
    })).map(v => v.externalId!),
  )
  const toCreate = units.filter(u => !existing.has(`wialon:${u.id}`) && !blocked.has(plateFor.get(u.id)!))
  const toUpdate = units.filter(u =>  existing.has(`wialon:${u.id}`))

  console.log(`\n  ── plan ─────────────────────────────────────────────────`)
  console.log(`  create ${toCreate.length} vehicle(s), update ${toUpdate.length}, skip ${blocked.size} on a plate conflict`)
  console.log(`  ${withPos} unit(s) carry a last known position and would get one telemetry ping each`)
  console.log(`  ${withTank} unit(s) state a tank capacity in the fuel sensor name; ${units.length - withTank} do not.`)
  console.log(`  A vehicle with no stated capacity keeps a NULL one, so litres still land and the`)
  console.log(`  gauge stays blank rather than showing a percentage of an assumed tank.`)
  for (const u of toCreate.slice(0, 8)) {
    console.log(`      ${String(plateFor.get(u.id)).padEnd(28)} ${String(classifyUnit(u.nm, u.flds)).padEnd(12)} ${u.nm}`)
  }
  if (toCreate.length > 8) console.log(`      … and ${toCreate.length - 8} more`)

  if (!APPLY) {
    console.log(`\n  Dry run — nothing written. Re-run with:  npm run sync:wialon -- --org=${fleet.orgCode} --apply\n`)
    await client.logout()
    return
  }

  // ── apply ─────────────────────────────────────────────────────────────────
  const groupId = new Map<string, string>()
  for (const [code, g] of groups) {
    const row = await prisma.vehicleGroup.upsert({
      where:  { organisationId_code: { organisationId: org.id, code } },
      update: {},
      create: { organisationId: org.id, name: g.name, code },
      select: { id: true },
    })
    groupId.set(code, row.id)
  }

  let created = 0, updated = 0, failed = 0, skipped = 0
  let pings = 0, noPosition = 0, stale = 0
  const seen: string[] = []
  const now = Date.now()

  for (const u of units) {
    const externalId = `wialon:${u.id}`
    seen.push(externalId)

    const plate = plateFor.get(u.id)!
    if (blocked.has(plate)) { skipped++; continue }

    const data = {
      organisationId:    org.id,
      vehicleGroupId:    groupId.get(fleet.groupOf(u.nm).code)!,
      name:              u.nm.trim(),
      registrationPlate: plate,
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

    let vehicleId: string
    try {
      const existingRow = await prisma.vehicle.findUnique({ where: { externalId }, select: { id: true } })
      if (existingRow) {
        await prisma.vehicle.update({ where: { externalId }, data })
        vehicleId = existingRow.id
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

  console.log(`\n  ✓ vehicles: created ${created}, updated ${updated}, skipped ${skipped}, failed ${failed}`)
  console.log(`  ✓ positions: ${pings} new pings written, ${noPosition} units have never reported`)
  if (stale > 0) console.log(`    · ${stale} of those fixes are over 30 days old — they will show on the map as long-stale`)
  if (gone.count > 0) console.log(`  ✓ deactivated ${gone.count} units no longer in Wialon`)

  const total = await prisma.vehicle.count({ where: { organisationId: org.id, isActive: true } })
  console.log(`\n✅  ${fleet.orgCode} now has ${total} active vehicles.\n`)

  await client.logout()
}

main()
  .catch(err => { console.error('\n❌  sync-wialon failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
