/**
 * Is the fuel pipeline actually working?
 *
 * READ-ONLY. Run it whenever, as often as you like. It answers the four
 * questions that decide whether the detector is alive, in the order they fail:
 *
 *   1. Is adjudication RUNNING?      a verdict written recently
 *   2. Is it CLASSIFYING?            causes written, not just verdicts
 *   3. Is it ANNOUNCING sensibly?    volume per day, and how concentrated
 *   4. Is anything BACKING UP?       PENDING rows past their settle window
 *
 * ## Why a script rather than reading the logs
 *
 * Twice tonight the cycle log looked healthy while nothing was being judged —
 * the adjudication pass is wrapped in a try/catch that warns and lets the
 * cycle report normal-looking counts. And `pm2 logs --lines N` is dominated by
 * poll output, so a quarter-hourly event scrolls out of any window worth
 * grepping. The database is the only honest witness.
 *
 * A silent feed is NOT evidence of health: at the current rate a genuine
 * siphon is about one a week, so "no alerts" is the expected state. What
 * proves the thing is running is causes accumulating and PENDING staying near
 * zero.
 */

import { prisma } from '../src/lib/prisma.js'

const HOURS = Number(process.argv.includes('--hours')
  ? process.argv[process.argv.indexOf('--hours') + 1] : 24)

const ago = (d: Date | null): string => {
  if (!d) return 'never'
  const m = Math.round((Date.now() - d.getTime()) / 60000)
  return m < 60 ? `${m} min ago` : `${(m / 60).toFixed(1)} h ago`
}

const since = new Date(Date.now() - HOURS * 3600_000)

// ── 1. running ──────────────────────────────────────────────────────────────
const [pulse] = await prisma.$queryRaw<Array<{ last: Date | null; judged: bigint }>>`
  SELECT max(verdict_at) AS last,
         count(*) FILTER (WHERE verdict_at >= ${since})::bigint AS judged
    FROM fuel_thefts`
console.log(`\nADJUDICATION`)
console.log(`  last verdict written : ${pulse!.last?.toISOString() ?? 'never'}  (${ago(pulse!.last)})`)
console.log(`  judged in ${HOURS} h        : ${Number(pulse!.judged)}`)
// The cycle is quarter-hourly. Anything past an hour means it is not running,
// whatever the logs say.
if (!pulse!.last || Date.now() - pulse!.last.getTime() > 3600_000) {
  console.log(`  *** STALE — the cycle is quarter-hourly; check the box ***`)
}

// ── 2. classifying ──────────────────────────────────────────────────────────
const causes = await prisma.$queryRaw<Array<{ c: string | null; n: bigint }>>`
  SELECT drain_cause::text AS c, count(*)::bigint AS n
    FROM fuel_thefts WHERE verdict_at >= ${since} GROUP BY 1 ORDER BY 2 DESC`
console.log(`\nCAUSES in the last ${HOURS} h`)
if (causes.length === 0) console.log('  (nothing judged)')
for (const r of causes) {
  const total = causes.reduce((a, x) => a + Number(x.n), 0)
  console.log(`  ${(r.c ?? '(none)').padEnd(18)} ${String(Number(r.n)).padStart(5)}  ${((Number(r.n) / total) * 100).toFixed(1)}%`)
}

// ── 3. announcing ───────────────────────────────────────────────────────────
const ann = await prisma.$queryRaw<Array<{ plate: string; reason: string | null; n: bigint }>>`
  SELECT v.registration_plate AS plate, t.cause_reason AS reason, count(*)::bigint AS n
    FROM fuel_thefts t JOIN vehicles v ON v.id = t.vehicle_id
   WHERE t.verdict_at >= ${since}
     AND (t.drain_cause::text = 'SIPHON'
       OR t.cause_reason IN ('burn-above-class-ceiling','burn-far-above-band',
                             'drop-exceeds-distance','drop-while-stationary'))
   GROUP BY 1,2 ORDER BY 3 DESC`
const annTotal = ann.reduce((a, x) => a + Number(x.n), 0)
console.log(`\nANNOUNCED in the last ${HOURS} h: ${annTotal}  (${(annTotal / (HOURS / 24)).toFixed(1)}/day)`)
for (const r of ann.slice(0, 10)) {
  console.log(`  ${r.plate.padEnd(20)} ${String(Number(r.n)).padStart(3)}  ${r.reason}`)
}
// One machine carrying most of the alerts has been wrong every time it has
// happened — a miscategorised crawler, a generator, a probe. It is the first
// thing to look at, not the last.
if (annTotal > 0) {
  const top = Number(ann[0]!.n) / annTotal
  if (top > 0.4) console.log(`  *** ${ann[0]!.plate} is ${(top * 100).toFixed(0)}% of all alerts — check the machine before the fuel ***`)
}

// ── 4. backing up ───────────────────────────────────────────────────────────
const [q] = await prisma.$queryRaw<Array<{ pending: bigint; ripe: bigint; oldest: Date | null }>>`
  SELECT count(*)::bigint AS pending,
         count(*) FILTER (WHERE detected_at < now() - interval '20 minutes')::bigint AS ripe,
         min(began_at) AS oldest
    FROM fuel_thefts WHERE verdict = 'PENDING'`
console.log(`\nQUEUE`)
console.log(`  PENDING            : ${Number(q!.pending)}`)
console.log(`  ...past settle     : ${Number(q!.ripe)}${Number(q!.ripe) > 0 ? '   <- should be judged on the next cycle' : ''}`)
if (Number(q!.ripe) > 50) console.log('  *** a real backlog — adjudication is behind or failing ***')

// ── coverage, because it caps everything above ──────────────────────────────
const [cov] = await prisma.$queryRaw<Array<{ n: bigint; indet: bigint }>>`
  SELECT count(*)::bigint AS n,
         count(*) FILTER (WHERE drain_cause::text = 'INDETERMINATE')::bigint AS indet
    FROM fuel_thefts WHERE verdict_at >= now() - interval '7 days' AND drain_cause IS NOT NULL`
if (Number(cov!.n) > 0) {
  const pct = (Number(cov!.indet) / Number(cov!.n)) * 100
  console.log(`\nCOVERAGE (7 d): ${pct.toFixed(0)}% INDETERMINATE of ${Number(cov!.n)} judged`)
  console.log('  Driven by machines with no class or no usable rate — the bands are what move this.')
}
console.log('')
await prisma.$disconnect()
