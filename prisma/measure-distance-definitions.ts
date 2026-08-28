/**
 * Three definitions of "ground covered", measured against each other.
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## Why this exists
 *
 * Stage 3.4 wants a litres-per-kilometre sibling of the tank-balance rate, and
 * the obvious denominator is `fuel_daily_trends.distance_m`, which is already
 * computed per fleet day. Before dividing anything by it, it is worth knowing
 * that this fleet has THREE distance definitions and they do not agree:
 *
 * | where | jitter floor | upper bound | speed test |
 * | --- | --- | --- | --- |
 * | `coveredSince` (dispatch.repository) | 15 m | — | yes, since 2026-08-27 |
 * | `measureKm` (trip-builder) | 20 m | 5 km flat | yes, since 2026-08-27 |
 * | `distance_m` (fuel-tank-state.service) | **none** | 10 km flat | **no** |
 *
 * The third is the one 3.4 would divide by, and it is the least guarded of the
 * three: it has no jitter floor at all, so a parked machine's satellite wander
 * accumulates into its daily distance, and no speed test, so the teleports that
 * were 34.76% of SUKARI's `coveredSince` metres are still counted in full here.
 *
 * Both faults push the same way — distance UP — and an inflated denominator
 * deflates L/km, which makes a real loss look explained by driving. That fails
 * toward silence, which is the direction nobody notices.
 *
 * ## What this reports
 *
 * The same fixes summed four ways over the same window, so the columns are
 * directly comparable: as `distance_m` does it today, with a jitter floor
 * added, with the plausibility test added, and with both. The gap between the
 * first and last column is what 3.4 would inherit if it used the column as it
 * stands, and it also settles the 15 m-versus-20 m floor question that has been
 * deferred twice for want of a measurement.
 */

import { prisma } from '../src/lib/prisma.js'
import { PLAUSIBLE_KMH } from '../src/lib/fix-plausibility.js'

const DAYS = Number(process.argv.includes('--days')
  ? process.argv[process.argv.indexOf('--days') + 1] : 1)
const MAX_HOP_M = 10_000   // fuel-tank-state's MAX_HOP_KM
const FLOOR_15 = 15        // coveredSince
const FLOOR_20 = 20        // measureKm

const padR = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)
const pc = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(2)}%` : '—')

const rows = await prisma.$queryRaw<Array<{
  org: string; raw_m: number; f15_m: number; f20_m: number; plaus_m: number; both15_m: number; both20_m: number
}>>`
  WITH f AS (
    SELECT o.code AS org, t.vehicle_id, t.captured_at, t.lat, t.lng,
           lag(t.lat)         OVER w AS plat,
           lag(t.lng)         OVER w AS plng,
           lag(t.captured_at) OVER w AS pat
      FROM vehicle_telemetries t
      JOIN vehicles v      ON v.id = t.vehicle_id
      JOIN organisations o ON o.id = v.organisation_id
     WHERE t.captured_at >= now() - make_interval(days => ${DAYS}::int)
       AND t.lat IS NOT NULL AND t.lng IS NOT NULL
       AND NOT (t.lat = 0 AND t.lng = 0)
       AND v.is_active
    WINDOW w AS (PARTITION BY t.vehicle_id ORDER BY t.captured_at)
  ), h AS (
    SELECT org,
           6371000 * 2 * asin(sqrt(
             power(sin(radians(lat - plat) / 2), 2)
             + cos(radians(plat)) * cos(radians(lat))
               * power(sin(radians(lng - plng) / 2), 2)
           )) AS hop_m,
           extract(epoch FROM (captured_at - pat)) AS dt
      FROM f WHERE plat IS NOT NULL AND pat IS NOT NULL
  ), k AS (
    SELECT org, hop_m, dt,
           (hop_m / nullif(dt, 0)) * 3.6 AS kmh
      FROM h WHERE hop_m < ${MAX_HOP_M}
  )
  SELECT org,
         sum(hop_m)::float8                                                        AS raw_m,
         sum(hop_m) FILTER (WHERE hop_m >= ${FLOOR_15})::float8                    AS f15_m,
         sum(hop_m) FILTER (WHERE hop_m >= ${FLOOR_20})::float8                    AS f20_m,
         sum(hop_m) FILTER (WHERE kmh <= ${PLAUSIBLE_KMH})::float8                 AS plaus_m,
         sum(hop_m) FILTER (WHERE hop_m >= ${FLOOR_15}
                              AND kmh <= ${PLAUSIBLE_KMH})::float8                 AS both15_m,
         sum(hop_m) FILTER (WHERE hop_m >= ${FLOOR_20}
                              AND kmh <= ${PLAUSIBLE_KMH})::float8                 AS both20_m
    FROM k GROUP BY 1 ORDER BY 1`

const km = (m: number | null) => ((m ?? 0) / 1000)

console.log(`\n  "Ground covered" over ${DAYS} day(s), the same fixes summed four ways`)
console.log(`  (all columns already drop hops over ${MAX_HOP_M / 1000} km, as distance_m does)\n`)
console.log('  org        as distance_m   +15 m floor   +20 m floor   +speed test   floor+speed')
for (const r of rows) {
  console.log(`  ${padR(r.org, 10)}${padL(km(r.raw_m).toFixed(0), 14)}` +
              `${padL(km(r.f15_m).toFixed(0), 14)}${padL(km(r.f20_m).toFixed(0), 14)}` +
              `${padL(km(r.plaus_m).toFixed(0), 14)}${padL(km(r.both15_m).toFixed(0), 14)}`)
}

console.log('\n  what each guard removes, against distance_m as it stands')
console.log('  org        jitter (<15 m)   teleports   both      15 m vs 20 m floor')
for (const r of rows) {
  const jitter = km(r.raw_m) - km(r.f15_m)
  const tele   = km(r.raw_m) - km(r.plaus_m)
  const both   = km(r.raw_m) - km(r.both15_m)
  const floorGap = km(r.both15_m) - km(r.both20_m)
  console.log(`  ${padR(r.org, 10)}` +
              `${padL(`${jitter.toFixed(0)} km (${pc(jitter, km(r.raw_m))})`, 17)}` +
              `${padL(`${pc(tele, km(r.raw_m))}`, 12)}` +
              `${padL(`${pc(both, km(r.raw_m))}`, 10)}` +
              `${padL(`${floorGap.toFixed(0)} km (${pc(floorGap, km(r.both15_m))})`, 22)}`)
}

console.log(`\n  The first data column is what 3.4 would divide by if it used distance_m`)
console.log(`  unchanged. The last is what the rest of the fleet already calls distance.`)
console.log(`  The final column is the 15-vs-20 m question, which has been deferred`)
console.log(`  twice for want of exactly this number.\n`)

process.exit(0)
