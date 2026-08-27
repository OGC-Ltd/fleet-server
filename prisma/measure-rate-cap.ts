/**
 * What does the flat 40 L/h plausibility cap actually exclude?
 *
 * READ-ONLY. It writes nothing and changes nothing.
 *
 * ## The claim
 *
 * `MAX_PLAUSIBLE_L_PER_HOUR = 40` is enforced three times in
 * `fuel-rate.service` — per run, on the aggregate, and as a DELETE over stored
 * rows — and its docstring defends it as "over three times the heaviest class
 * anyone has measured", citing a 12.47 L/h fleet maximum.
 *
 * That was true of the fleet as it was then understood. It is not true of the
 * operator's own CLASS_BANDS, which were supplied later and put six classes
 * partly or wholly above it:
 *
 *     GENERATOR         35-95   (ceiling 120)
 *     DOZER_CAT_D11     59-97
 *     DOZER_CAT_D10     43-71
 *     DOZER_CAT_D9      30-49
 *     TRACTOR_LARGE     18-45
 *     DOZER_CAT_D8T     25-40
 *
 * If the cap is doing what the plan suspects, then every honest run on those
 * machines is discarded, and the DELETE guarantees no such rate can ever
 * persist even if one were derived. A generator would then be permanently
 * without a rate of its own — the largest tanks on the fleet, and the machines
 * that can never reach SIPHON because their engines are on 87-96% of the time.
 *
 * ## What would have to be true to raise it
 *
 * Not simply that runs are excluded — an impossible rate SHOULD be excluded,
 * and the cap was introduced because `MUFINDI - DG 12` was deriving 109.89 L/h
 * off probe noise on a 1,696 L tank. The question is whether the excluded runs
 * land inside the band the operator already specified for that machine's class,
 * or above it. Inside means the cap is discarding real measurements; above
 * means it is doing its job and a per-class cap would let noise through.
 *
 * That split is the last table, and it is what decides the change.
 */

import { prisma } from '../src/lib/prisma.js'
import { resolveClass, CLASS_BANDS, CLASS_CEILING_LPH } from '../src/modules/fuel/fuel-theft-classifier.js'
import { MAX_PLAUSIBLE_L_PER_HOUR, RATE_WINDOW_DAYS } from '../src/modules/fuel/fuel-rate.service.js'

const DAYS = Number(process.argv.includes('--days')
  ? process.argv[process.argv.indexOf('--days') + 1] : RATE_WINDOW_DAYS)

const padR = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)
const pc = (x: number, d: number) => (d ? `${((x / d) * 100).toFixed(1)}%` : '—')

console.log(`\n  The flat ${MAX_PLAUSIBLE_L_PER_HOUR} L/h cap, over ${DAYS} days\n`)

// The derivation's own run segmentation, with the cap REMOVED so the excluded
// runs are visible. Everything else — the 10-reading floor, the 20-minute
// floor, the 0.3-200 L drop bounds, the filling and theft exclusions — is
// unchanged, so a run here is a run the derivation would otherwise have used.
const runs = await prisma.$queryRaw<Array<{
  vehicle_id: string; plate: string; org: string; vtype: string | null;
  tank: number | null; n: bigint; lph: number
}>>`
  WITH s AS (
    SELECT x.vehicle_id, x.captured_at, x.fuel_level_ml, x.engine_on,
           lag(x.captured_at) OVER w AS prev_at,
           lag(x.engine_on)   OVER w AS prev_on
      FROM vehicle_telemetries x
     WHERE x.captured_at >= now() - make_interval(days => ${DAYS}::int)
       AND x.fuel_level_ml IS NOT NULL
    WINDOW w AS (PARTITION BY x.vehicle_id ORDER BY x.captured_at)
  ), b AS (
    SELECT *, extract(epoch FROM (captured_at - prev_at)) AS dt,
           sum(CASE WHEN prev_on IS DISTINCT FROM engine_on OR prev_at IS NULL
                      OR extract(epoch FROM (captured_at - prev_at)) > 900
                    THEN 1 ELSE 0 END)
             OVER (PARTITION BY vehicle_id ORDER BY captured_at) AS grp
      FROM s
  ), r AS (
    SELECT vehicle_id, grp, bool_and(engine_on) AS eng,
           min(captured_at) AS t0, max(captured_at) AS t1, count(*) AS n,
           extract(epoch FROM (max(captured_at) - min(captured_at))) / 3600.0 AS hours,
           (array_agg(fuel_level_ml ORDER BY captured_at))[1]      AS l0,
           (array_agg(fuel_level_ml ORDER BY captured_at DESC))[1] AS l1
      FROM b GROUP BY 1, 2
  ), clean AS (
    SELECT r.*, ((r.l0 - r.l1) / 1000.0) / r.hours AS lph FROM r
     WHERE r.eng AND r.n >= 10 AND r.hours >= 0.33
       AND r.l0 > r.l1 AND (r.l0 - r.l1) BETWEEN 300 AND 200000
       AND NOT EXISTS (SELECT 1 FROM fuel_fillings f
                        WHERE f.vehicle_id = r.vehicle_id AND f.filled_at BETWEEN r.t0 AND r.t1)
       AND NOT EXISTS (SELECT 1 FROM fuel_thefts t
                        WHERE t.vehicle_id = r.vehicle_id AND t.began_at BETWEEN r.t0 AND r.t1)
  )
  SELECT c.vehicle_id, v.registration_plate AS plate, o.code AS org,
         v.vehicle_type AS vtype, v.tank_capacity_litres AS tank,
         count(*) AS n,
         round((sum((c.l0 - c.l1) / 1000.0) / nullif(sum(c.hours), 0))::numeric, 2)::float8 AS lph
    FROM clean c
    JOIN vehicles v      ON v.id = c.vehicle_id
    JOIN organisations o ON o.id = v.organisation_id
   GROUP BY 1, 2, 3, 4, 5
  HAVING sum(c.hours) > 0
   ORDER BY lph DESC`

interface Row { plate: string; org: string; cls: string; lph: number; n: number; band: string; verdict: string }
const rows: Row[] = []
let over = 0

for (const r of runs) {
  const cls = resolveClass(r.org, {
    plate: r.plate, vehicleType: r.vtype, tankCapacityLitres: r.tank,
  })
  const band = cls != null ? CLASS_BANDS.get(cls) : undefined
  const ceiling = cls != null ? CLASS_CEILING_LPH.get(cls) : undefined
  if (r.lph <= MAX_PLAUSIBLE_L_PER_HOUR) continue
  over++

  // The decisive question: does the excluded aggregate sit inside the band the
  // operator specified for this class, or above it?
  const verdict =
    band == null                   ? 'no class band — cannot say'
    : r.lph <= band.highLph        ? 'INSIDE the operator band'
    : ceiling != null && r.lph <= ceiling ? 'above band, under class ceiling'
    : ceiling != null              ? 'ABOVE the class ceiling'
    : 'above band, no ceiling set'

  rows.push({
    plate: r.plate, org: r.org, cls: cls ?? '—', lph: r.lph, n: Number(r.n),
    band: band ? `${band.lowLph}-${band.highLph}` : '—', verdict,
  })
}

console.log(`    vehicles producing an aggregate rate      ${padL(String(runs.length), 6)}`)
console.log(`    ...excluded by the flat cap               ${padL(String(over), 6)}   ${pc(over, runs.length)}\n`)

if (rows.length === 0) {
  console.log('    Nothing exceeds the cap in this window — it is costing nothing today.\n')
} else {
  console.log('    plate                class                  L/h   runs   operator band   verdict')
  for (const r of rows) {
    console.log(`    ${padR(r.plate, 20)} ${padR(r.cls, 20)}${padL(r.lph.toFixed(1), 7)}` +
                `${padL(String(r.n), 6)}   ${padR(r.band, 14)}  ${r.verdict}`)
  }
  const inside = rows.filter(r => r.verdict === 'INSIDE the operator band').length
  const under  = rows.filter(r => r.verdict === 'above band, under class ceiling').length
  console.log(`\n    inside the operator's own band        ${padL(String(inside), 5)}` +
              `   <- real measurements the cap discards`)
  console.log(`    above band but under the ceiling      ${padL(String(under), 5)}`)
  console.log(`    above ceiling / unclassed             ${padL(String(rows.length - inside - under), 5)}` +
              `   <- the cap is right about these\n`)
}

process.exit(0)
