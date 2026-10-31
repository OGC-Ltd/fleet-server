/**
 * Did `TRAVEL_CATEGORIES` agree with `resolveBasis`?
 *
 * READ-ONLY. This is the measurement behind the 2026-08-28 change that deleted
 * the first of those in favour of the second.
 *
 * Both answered the same question in the same words — TRAVEL_CATEGORIES was
 * "categories whose work IS travel", resolveBasis is "things whose WORK is
 * travelling take distance" — but they were two hand-maintained lists, and this
 * prints every prefix where they disagreed, with the km per engine hour that
 * settles which one was right.
 *
 * It answers the CTR question directly: at 4.4 km per engine hour a cane
 * tractor belongs with the graders, not the buses, so it stays on hours.
 *
 *     npx cross-env DOTENV_CONFIG_PATH=.env tsx prisma/measure-travel-categories.ts
 */

import { prisma } from '../src/lib/prisma.js'
import { machinePrefix, resolveBasis } from '../src/modules/fuel/fuel-theft-classifier.js'

/**
 * The retired list, kept here so the finding stays reproducible.
 *
 * `fleet-state.service` no longer holds this — it asks `resolveBasis` per
 * machine — but the whole argument for that change is the diff below, and a
 * measurement that cannot be re-run is an assertion.
 */
const TRAVEL_CATEGORIES = new Set(['LMV', 'FT', 'FTT', 'MTR', 'BUS', 'TRK'])

const DAYS = 30
const since = new Date(Date.now() - DAYS * 86_400_000)

const orgs = await prisma.organisation.findMany({ select: { id: true, code: true } })

interface Row {
  prefix: string
  n: number
  types: Map<string, number>
  km: number
  hours: number
  distanceBasis: number     // vehicles resolveBasis calls DISTANCE
}

for (const org of orgs) {
  const vehicles = await prisma.vehicle.findMany({
    where:  { organisationId: org.id, isActive: true },
    select: { id: true, registrationPlate: true, vehicleType: true, tankCapacityLitres: true },
  })
  if (vehicles.length === 0) continue

  // Ground and engine time over the window, per vehicle. `distance_m` is known
  // to run ~35% high (no jitter floor, no speed test) — fine here, where the
  // question is which ORDER OF MAGNITUDE a prefix sits in, not its exact rate.
  const totals = await prisma.$queryRaw<Array<{
    vehicle_id: string; m: bigint | null; s: bigint | null
  }>>`
    SELECT t.vehicle_id,
           sum(t.distance_m)::bigint    AS m,
           sum(t.engine_seconds)::bigint AS s
      FROM fuel_daily_trends t
      JOIN vehicles v ON v.id = t.vehicle_id
     WHERE v.organisation_id = ${org.id} AND v.is_active
       AND t.day >= ${since}
     GROUP BY 1`
  const byVehicle = new Map(totals.map(t => [t.vehicle_id, t]))

  const rows = new Map<string, Row>()
  for (const v of vehicles) {
    const prefix = machinePrefix(v.registrationPlate) || 'OTHER'
    const r = rows.get(prefix) ?? {
      prefix, n: 0, types: new Map<string, number>(), km: 0, hours: 0, distanceBasis: 0,
    }
    r.n++
    const ty = v.vehicleType ?? '—'
    r.types.set(ty, (r.types.get(ty) ?? 0) + 1)
    const t = byVehicle.get(v.id)
    r.km    += Number(t?.m ?? 0) / 1000
    r.hours += Number(t?.s ?? 0) / 3600
    if (resolveBasis(org.code, {
      plate: v.registrationPlate,
      vehicleType: v.vehicleType,
      tankCapacityLitres: v.tankCapacityLitres,
    }) === 'DISTANCE') r.distanceBasis++
    rows.set(prefix, r)
  }

  console.log(`\n\n  ${org.code} — ${vehicles.length} active vehicles, ${DAYS} days`)
  console.log('  ' + '─'.repeat(84))
  console.log('  prefix      n   km/engine-h   in TRAVEL_CATEGORIES   resolveBasis      agree')
  const sorted = [...rows.values()].sort((a, b) => {
    const ka = a.hours > 0 ? a.km / a.hours : -1
    const kb = b.hours > 0 ? b.km / b.hours : -1
    return kb - ka
  })
  const disagreements: string[] = []
  for (const r of sorted) {
    const kmh = r.hours > 0 ? (r.km / r.hours) : null
    const inSet = TRAVEL_CATEGORIES.has(r.prefix)
    // A prefix is DISTANCE under resolveBasis when every unit under it is.
    const allDistance = r.distanceBasis === r.n
    const anyDistance = r.distanceBasis > 0
    const basis = allDistance ? 'DISTANCE'
      : anyDistance ? `MIXED ${r.distanceBasis}/${r.n}` : 'HOURS'
    const agree = inSet === allDistance
    if (!agree) disagreements.push(r.prefix)
    console.log(
      `  ${r.prefix.padEnd(8)}${String(r.n).padStart(4)}` +
      `${(kmh == null ? '—' : kmh.toFixed(1)).padStart(14)}` +
      `${(inSet ? 'yes' : 'no').padStart(23)}` +
      `${basis.padStart(15)}` +
      `${(agree ? '' : '   ← NO').padStart(11)}`)
  }

  // The two consequences of being outside the set, spelled out per prefix,
  // because the columns they null out are the whole point of the question.
  if (disagreements.length > 0) {
    console.log(`\n  Disagreeing: ${disagreements.join(', ')}`)
    for (const p of disagreements) {
      const r = rows.get(p)!
      const types = [...r.types].map(([k, n]) => `${k}×${n}`).join(' ')
      const inSet = TRAVEL_CATEGORIES.has(p)
      console.log(`    ${p.padEnd(6)} ${String(r.n).padStart(3)} units · ${types}`)
      console.log(`           ${inSet
        ? 'reported as IDLING when standing still, and given an idle-hours figure'
        : 'reported as STATIONARY, idleHoursToday and litresPerKm both null'}`)
    }
  }
}

// ── What the change actually moves, per unit ────────────────────────────────
let gained = 0, lost = 0, same = 0
for (const org of orgs) {
  const vs = await prisma.vehicle.findMany({
    where:  { organisationId: org.id, isActive: true },
    select: { registrationPlate: true, vehicleType: true, tankCapacityLitres: true },
  })
  for (const v of vs) {
    const was = TRAVEL_CATEGORIES.has(machinePrefix(v.registrationPlate) || 'OTHER')
    const now = resolveBasis(org.code, {
      plate: v.registrationPlate,
      vehicleType: v.vehicleType,
      tankCapacityLitres: v.tankCapacityLitres,
    }) === 'DISTANCE'
    if (was === now) same++
    else if (now) gained++
    else lost++
  }
}
console.log(`\n  Units whose idle figure and L/km APPEAR:   ${gained}`)
console.log(`  Units where they correctly DISAPPEAR:     ${lost}`)
console.log(`  Unchanged:                                ${same}`)

// Codes the set names that no plate actually carries — a member that can never
// match is a member nobody has checked.
const allPlates = await prisma.vehicle.findMany({
  where: { isActive: true }, select: { registrationPlate: true },
})
const live = new Set(allPlates.map(v => machinePrefix(v.registrationPlate)))
const dead = [...TRAVEL_CATEGORIES].filter(c => !live.has(c))
console.log(`\n\n  TRAVEL_CATEGORIES members matching no active plate: ${dead.length > 0 ? dead.join(', ') : 'none'}\n`)

process.exit(0)
