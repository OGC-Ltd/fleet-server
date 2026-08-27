/**
 * Do implausible positions actually inflate the distance a judgement uses?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The claim being checked
 *
 * `lib/fix-plausibility` states, from a 24-hour measurement on SUKARI over
 * 214,925 consecutive-fix pairs: 0.91% imply a speed above 120 km/h, 1,282 of
 * them imply over 300 km/h, the 99.9th percentile is 2,141 km/h, and no fix in
 * the fleet ever REPORTS a speed above 120 km/h. That last detail is what makes
 * the test sound — the device does not claim to be moving that fast, so it is
 * the position that is wrong.
 *
 * The filter built on it is called from `yard-departure` and nowhere else.
 * `coveredSince` — which its own docstring calls "the fleet's ONE definition of
 * ground covered" — sums every hop at or above MIN_SPACING_M with NO upper
 * bound at all, and `measureKm` guards with a flat 5 km ceiling and a 20 m
 * floor against coveredSince's 15 m.
 *
 * ## Why the headline percentage is the wrong number
 *
 * A rate of bad PAIRS says nothing about how much bad DISTANCE they contribute,
 * and distance is what a litres-per-kilometre judgement divides by. 0.91% of
 * pairs could be 0.1% of the kilometres or 40% of them: a teleport is by
 * definition a long hop, so bad pairs are over-represented in metres by exactly
 * the amount that makes them dangerous.
 *
 * That is the number this harness exists for — the last table. Inflated
 * kilometres deflate L/km, and a deflated L/km makes a real loss look explained
 * by driving. It fails toward silence, which is the direction nobody notices.
 */

import { prisma } from '../src/lib/prisma.js'
import { PLAUSIBLE_KMH } from '../src/lib/fix-plausibility.js'

const DAYS = Number(process.argv.includes('--days')
  ? process.argv[process.argv.indexOf('--days') + 1] : 1)
/** Matches coveredSince. Hops below it are jitter and are never summed. */
const MIN_SPACING_M = 15

const pc = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(2)}%` : '—')
const padR = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)
const n = (x: bigint | number | null | undefined) => Number(x ?? 0).toLocaleString()

console.log(`\n  Fix plausibility over the last ${DAYS} day(s) · ceiling ${PLAUSIBLE_KMH} km/h\n`)

// ── 1. does any device ever REPORT above the ceiling? ───────────────────────
const [rep] = await prisma.$queryRaw<Array<{ mx: number | null; over: bigint; total: bigint }>>`
  SELECT max(speed_kmh) AS mx,
         count(*) FILTER (WHERE speed_kmh > ${PLAUSIBLE_KMH}) AS over,
         count(*) AS total
    FROM vehicle_telemetries
   WHERE captured_at >= now() - make_interval(days => ${DAYS}::int)
     AND speed_kmh IS NOT NULL`
console.log(`    highest REPORTED speed in the window   ${(rep?.mx ?? 0).toFixed(1)} km/h`)
console.log(`    fixes reporting above the ceiling      ${n(rep?.over)} of ${n(rep?.total)}` +
            `   ${pc(Number(rep?.over ?? 0), Number(rep?.total ?? 0))}`)

// ── 2. implied speed between consecutive fixes, per org ─────────────────────
//
// Haversine inline, matching coveredSince's own SQL rather than approximating
// it — the point is to measure the distance that function would actually sum.

const rows = await prisma.$queryRaw<Array<{
  org: string; pairs: bigint; over: bigint; over300: bigint; p999: number | null;
  m_all: number; m_over: number
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
    WINDOW w AS (PARTITION BY t.vehicle_id ORDER BY t.captured_at)
  ), h AS (
    SELECT org,
           2 * 6371000 * asin(sqrt(
             power(sin(radians(lat - plat) / 2), 2) +
             cos(radians(plat)) * cos(radians(lat)) *
             power(sin(radians(lng - plng) / 2), 2)
           )) AS hop_m,
           extract(epoch FROM (captured_at - pat)) AS dt
      FROM f WHERE plat IS NOT NULL AND pat IS NOT NULL
  ), s AS (
    SELECT org, hop_m, (hop_m / dt) * 3.6 AS kmh FROM h WHERE dt > 0
  )
  SELECT org,
         count(*)                                            AS pairs,
         count(*) FILTER (WHERE kmh > ${PLAUSIBLE_KMH})       AS over,
         count(*) FILTER (WHERE kmh > 300)                    AS over300,
         percentile_cont(0.999) WITHIN GROUP (ORDER BY kmh)::float8 AS p999,
         -- Distance as coveredSince would sum it: every hop at or above the
         -- jitter floor, with no ceiling.
         COALESCE(sum(hop_m) FILTER (WHERE hop_m >= ${MIN_SPACING_M}), 0)::float8 AS m_all,
         COALESCE(sum(hop_m) FILTER (WHERE hop_m >= ${MIN_SPACING_M}
                                       AND kmh > ${PLAUSIBLE_KMH}), 0)::float8 AS m_over
    FROM s GROUP BY 1 ORDER BY 1`

console.log('\n    implied speed between consecutive fixes')
console.log('      org           pairs      over ceiling     over 300      p99.9')
for (const r of rows) {
  console.log(`      ${padR(r.org, 10)}${padL(n(r.pairs), 10)}` +
              `${padL(`${n(r.over)} (${pc(Number(r.over), Number(r.pairs))})`, 18)}` +
              `${padL(n(r.over300), 13)}${padL(`${Math.round(r.p999 ?? 0)} km/h`, 11)}`)
}

// ── 3. the number that decides it ───────────────────────────────────────────
console.log('\n    ground covered, and how much of it is impossible')
console.log('      org          summed km    from bad hops     share')
let tAll = 0, tOver = 0
for (const r of rows) {
  tAll += r.m_all; tOver += r.m_over
  console.log(`      ${padR(r.org, 10)}${padL((r.m_all / 1000).toFixed(0), 11)}` +
              `${padL((r.m_over / 1000).toFixed(0), 17)}${padL(pc(r.m_over, r.m_all), 10)}`)
}
console.log(`      ${padR('TOTAL', 10)}${padL((tAll / 1000).toFixed(0), 11)}` +
            `${padL((tOver / 1000).toFixed(0), 17)}${padL(pc(tOver, tAll), 10)}`)
console.log(`\n    A litres-per-kilometre judgement divides by the first column.`)
console.log(`    Whatever share the third column holds is loss made to look like driving.\n`)

// ── 4. concentrated in a few trackers, or everywhere? ───────────────────────
//
// A handful of bad units is an installer's problem and a per-unit exclusion; a
// flat rate across the fleet is a filter this code has to apply. The two have
// completely different fixes, so the distinction is worth one more query.

const per = await prisma.$queryRaw<Array<{
  plate: string; org: string; km_all: number; km_over: number; share: number
}>>`
  WITH f AS (
    SELECT v.registration_plate AS plate, o.code AS org, t.vehicle_id, t.captured_at, t.lat, t.lng,
           lag(t.lat)         OVER w AS plat,
           lag(t.lng)         OVER w AS plng,
           lag(t.captured_at) OVER w AS pat
      FROM vehicle_telemetries t
      JOIN vehicles v      ON v.id = t.vehicle_id
      JOIN organisations o ON o.id = v.organisation_id
     WHERE t.captured_at >= now() - make_interval(days => ${DAYS}::int)
       AND t.lat IS NOT NULL AND t.lng IS NOT NULL
    WINDOW w AS (PARTITION BY t.vehicle_id ORDER BY t.captured_at)
  ), s AS (
    SELECT plate, org,
           2 * 6371000 * asin(sqrt(
             power(sin(radians(lat - plat) / 2), 2) +
             cos(radians(plat)) * cos(radians(lat)) *
             power(sin(radians(lng - plng) / 2), 2)
           )) AS hop_m,
           extract(epoch FROM (captured_at - pat)) AS dt
      FROM f WHERE plat IS NOT NULL AND pat IS NOT NULL
  ), k AS (
    SELECT plate, org, hop_m, (hop_m / dt) * 3.6 AS kmh FROM s WHERE dt > 0
  )
  SELECT plate, org,
         (sum(hop_m) FILTER (WHERE hop_m >= ${MIN_SPACING_M}) / 1000)::float8 AS km_all,
         (COALESCE(sum(hop_m) FILTER (WHERE hop_m >= ${MIN_SPACING_M} AND kmh > ${PLAUSIBLE_KMH}), 0) / 1000)::float8 AS km_over,
         (COALESCE(sum(hop_m) FILTER (WHERE hop_m >= ${MIN_SPACING_M} AND kmh > ${PLAUSIBLE_KMH}), 0)
            / nullif(sum(hop_m) FILTER (WHERE hop_m >= ${MIN_SPACING_M}), 0))::float8 AS share
    FROM k GROUP BY 1, 2
  HAVING sum(hop_m) FILTER (WHERE hop_m >= ${MIN_SPACING_M}) > 1000
   ORDER BY km_over DESC NULLS LAST LIMIT 15`

const affected = per.filter(p => (p.share ?? 0) > 0.05).length
console.log(`    worst 15 units by impossible kilometres` +
            `   (${affected} of ${per.length} shown are over 5%)`)
console.log('      plate                org        km summed   impossible    share')
for (const p of per) {
  console.log(`      ${padR(p.plate, 20)} ${padR(p.org, 9)}${padL(p.km_all.toFixed(0), 10)}` +
              `${padL(p.km_over.toFixed(0), 13)}${padL(pc(p.km_over, p.km_all), 9)}`)
}
console.log()

process.exit(0)
