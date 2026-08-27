/**
 * Can idle burn be separated from working burn, and does it differ?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The proposal
 *
 * Stage 3.5 blames the 2-4x within-type rate spread on idle and work being
 * blended into one number, and proposes splitting engine-on time three ways:
 *
 *   moving (speed >= 1)                          -> WORKING
 *   stationary, engine on, position CHANGING     -> WORKING  (digging, slewing)
 *   stationary, engine on, position STATIC       -> IDLE
 *
 * The stationary-but-working test is the dig detection already in
 * `vehicle-daily-stats.service` — distinct positions on a half-metre grid — so
 * this reuses that grid rather than inventing a second one.
 *
 * ## The prerequisite nobody has checked
 *
 * `engineOn` is `ignition ?? (speed > 0)`. On a unit whose ignition line reports
 * nothing, engine_on is FALSE whenever speed is zero — so "stationary with the
 * engine on", the entire quantity this split is about, CANNOT EXIST on such a
 * unit. It is not that the split would be inaccurate there; it is unobservable,
 * and would silently read as "this machine never idles".
 *
 * Section 1 measures how much of the fleet can be split at all. If the machines
 * that matter — the HOURS machines, plant and generators — are largely the ones
 * without ignition, the split reaches nothing and the spread has to be explained
 * some other way.
 *
 * ## And the question that decides it
 *
 * Section 2. Two rates that do not differ are not worth separating. Runs are
 * classified by their DOMINANT state rather than segmented at every transition:
 * segmenting fragments a working day into hundreds of pieces too short to carry
 * a fuel measurement, while a run that is 80% one thing is fairly described by
 * it and still clears the 20-minute floor the derivation already trusts.
 */

import { prisma } from '../src/lib/prisma.js'
import { resolveBasis, resolveClass } from '../src/modules/fuel/fuel-theft-classifier.js'

const DAYS = Number(process.argv.includes('--days')
  ? process.argv[process.argv.indexOf('--days') + 1] : 7)
/** The dig detector's grid: 5e-6 degrees, about 0.55 m. */
const SNAP = 0.000005
/** Below this a machine is stationary, matching DIG_SPEED_KMH's intent. */
const STILL_KMH = 1

const pc = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(1)}%` : '—')
const padR = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)
const q = (xs: number[], p: number) =>
  xs.length === 0 ? NaN : [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!

const orgs = await prisma.organisation.findMany({ select: { id: true, code: true } })
const codeOf = new Map(orgs.map(o => [o.id, o.code]))
const vehicles = await prisma.vehicle.findMany({
  where:  { isActive: true },
  select: {
    id: true, registrationPlate: true, vehicleType: true,
    tankCapacityLitres: true, organisationId: true,
  },
})
const meta = new Map(vehicles.map(v => {
  const code = codeOf.get(v.organisationId) ?? ''
  const m = { plate: v.registrationPlate, vehicleType: v.vehicleType, tankCapacityLitres: v.tankCapacityLitres }
  return [v.id, { code, plate: v.registrationPlate, basis: resolveBasis(code, m), cls: resolveClass(code, m) }]
}))

// ── 1. is the split observable at all? ──────────────────────────────────────

console.log(`\n  1. Can "stationary with the engine on" even be seen?  (${DAYS} days)\n`)

const obs = await prisma.$queryRaw<Array<{
  vehicle_id: string; fixes: bigint; sensor: bigint; eng_on: bigint; eng_still: bigint
}>>`
  SELECT vehicle_id,
         count(*)                                                        AS fixes,
         count(*) FILTER (WHERE ignition_source::text = 'SENSOR')        AS sensor,
         count(*) FILTER (WHERE engine_on)                               AS eng_on,
         count(*) FILTER (WHERE engine_on
                            AND coalesce(speed_kmh, 0) < ${STILL_KMH})   AS eng_still
    FROM vehicle_telemetries
   WHERE captured_at >= now() - make_interval(days => ${DAYS}::int)
   GROUP BY 1`

const tally = new Map<string, { units: number; withSensor: number; splittable: number }>()
for (const r of obs) {
  const m = meta.get(r.vehicle_id)
  if (m == null) continue
  const key = m.basis
  const t = tally.get(key) ?? { units: 0, withSensor: 0, splittable: 0 }
  t.units++
  // A unit is only splittable if it BOTH reports a real ignition line and
  // actually shows engine-on-while-stationary time to divide.
  if (Number(r.sensor) > Number(r.fixes) * 0.5) t.withSensor++
  if (Number(r.eng_still) > 0) t.splittable++
  tally.set(key, t)
}
console.log('    basis      units   majority-SENSOR   any engine-on-while-still')
for (const [k, t] of tally) {
  console.log(`    ${padR(k, 10)}${padL(String(t.units), 6)}` +
              `${padL(`${t.withSensor} (${pc(t.withSensor, t.units)})`, 18)}` +
              `${padL(`${t.splittable} (${pc(t.splittable, t.units)})`, 26)}`)
}

// ── 2. do the two rates differ? ─────────────────────────────────────────────
//
// Same run segmentation the derivation uses, plus a per-run share of time spent
// stationary-and-static. A run is called IDLE when that share dominates.

console.log(`\n\n  2. Do idle and working runs burn differently?\n`)

const runs = await prisma.$queryRaw<Array<{
  vehicle_id: string; lph: number; idle_share: number; hours: number
}>>`
  WITH s AS (
    SELECT x.vehicle_id, x.captured_at, x.fuel_level_ml, x.engine_on,
           coalesce(x.speed_kmh, 0) AS spd,
           ST_SnapToGrid(ST_MakePoint(x.lng, x.lat), ${SNAP}) AS cell,
           lag(ST_SnapToGrid(ST_MakePoint(x.lng, x.lat), ${SNAP})) OVER w AS prev_cell,
           lag(x.captured_at) OVER w AS prev_at,
           lag(x.engine_on)   OVER w AS prev_on
      FROM vehicle_telemetries x
     WHERE x.captured_at >= now() - make_interval(days => ${DAYS}::int)
       AND x.fuel_level_ml IS NOT NULL
       AND x.lat IS NOT NULL AND x.lng IS NOT NULL
    WINDOW w AS (PARTITION BY x.vehicle_id ORDER BY x.captured_at)
  ), b AS (
    SELECT *, extract(epoch FROM (captured_at - prev_at)) AS dt,
           sum(CASE WHEN prev_on IS DISTINCT FROM engine_on OR prev_at IS NULL
                      OR extract(epoch FROM (captured_at - prev_at)) > 900
                    THEN 1 ELSE 0 END)
             OVER (PARTITION BY vehicle_id ORDER BY captured_at) AS grp
      FROM s
  ), r AS (
    SELECT vehicle_id, grp, bool_and(engine_on) AS eng, count(*) AS n,
           extract(epoch FROM (max(captured_at) - min(captured_at))) / 3600.0 AS hours,
           min(captured_at) AS t0, max(captured_at) AS t1,
           (array_agg(fuel_level_ml ORDER BY captured_at))[1]      AS l0,
           (array_agg(fuel_level_ml ORDER BY captured_at DESC))[1] AS l1,
           -- Seconds spent stationary AND not having moved a grid cell: the
           -- machine is running and doing nothing observable.
           sum(CASE WHEN dt BETWEEN 1 AND 900 AND spd < ${STILL_KMH}
                     AND prev_cell IS NOT NULL AND cell ~= prev_cell
                    THEN dt ELSE 0 END) AS idle_s,
           sum(CASE WHEN dt BETWEEN 1 AND 900 THEN dt ELSE 0 END) AS total_s
      FROM b GROUP BY 1, 2
  )
  SELECT vehicle_id,
         (((l0 - l1) / 1000.0) / hours)::float8 AS lph,
         (idle_s / nullif(total_s, 0))::float8  AS idle_share,
         hours::float8                          AS hours
    FROM r
   WHERE eng AND n >= 10 AND hours >= 0.33
     AND l0 > l1 AND (l0 - l1) BETWEEN 300 AND 200000
     AND total_s > 0
     AND NOT EXISTS (SELECT 1 FROM fuel_fillings f
                      WHERE f.vehicle_id = r.vehicle_id AND f.filled_at BETWEEN r.t0 AND r.t1)
     AND NOT EXISTS (SELECT 1 FROM fuel_thefts t
                      WHERE t.vehicle_id = r.vehicle_id AND t.began_at BETWEEN r.t0 AND r.t1)`

const idle: number[] = [], work: number[] = []
const perClass = new Map<string, { idle: number[]; work: number[] }>()
for (const r of runs) {
  const m = meta.get(r.vehicle_id)
  if (m == null || m.basis !== 'HOURS') continue
  if (!Number.isFinite(r.lph) || r.lph <= 0) continue
  const bucket = r.idle_share >= 0.8 ? 'idle' : r.idle_share <= 0.2 ? 'work' : null
  if (bucket == null) continue
  ;(bucket === 'idle' ? idle : work).push(r.lph)
  const key = m.cls ?? '(unclassed)'
  const c = perClass.get(key) ?? { idle: [], work: [] }
  c[bucket].push(r.lph)
  perClass.set(key, c)
}

console.log(`    HOURS-machine runs classified: ${idle.length} idle · ${work.length} working`)
console.log(`    (runs between 20% and 80% idle are mixed and excluded)\n`)
if (idle.length > 0 && work.length > 0) {
  console.log(`               n      p25      p50      p75`)
  for (const [label, xs] of [['idle', idle], ['working', work]] as const) {
    console.log(`    ${padR(label, 10)}${padL(String(xs.length), 5)}` +
                `${padL(q(xs, 0.25).toFixed(1), 9)}${padL(q(xs, 0.5).toFixed(1), 9)}${padL(q(xs, 0.75).toFixed(1), 9)}`)
  }
  console.log(`\n    working median / idle median = ${(q(work, 0.5) / q(idle, 0.5)).toFixed(2)}x`)
  console.log(`    A ratio near 1.0 means the split explains none of the spread.\n`)

  console.log('    by class (classes with at least 3 of each)')
  for (const [cls, c] of [...perClass].sort((a, b) => b[1].work.length - a[1].work.length)) {
    if (c.idle.length < 3 || c.work.length < 3) continue
    console.log(`      ${padR(cls, 22)}idle ${padL(q(c.idle, 0.5).toFixed(1), 6)}` +
                `   working ${padL(q(c.work, 0.5).toFixed(1), 6)}` +
                `   ${padL(`${(q(c.work, 0.5) / q(c.idle, 0.5)).toFixed(2)}x`, 7)}` +
                `   n=${c.idle.length}/${c.work.length}`)
  }
} else {
  console.log('    Not enough of one or both kinds to compare.')
}
console.log()

process.exit(0)
