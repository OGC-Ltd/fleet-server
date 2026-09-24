/**
 * Does this vehicle carry the truncation defect?
 *
 * The failure proven on MUFINDI - FT 13 on 2026-09-23: a drain's recovery
 * window is cut at any filling inside it (`adjudicateDrain`), fillings only
 * stop truncating once they are ruled REDISTRIBUTION, and a drain ripens at 20
 * minutes (`SETTLE_MINUTES`) while a filling ripens at 60
 * (`FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES`). So a drain is routinely judged
 * before the filling that truncated it has been checked, and
 * `adjudicatePendingDrains` only ever selects PENDING rows — once written, the
 * verdict is never revisited.
 *
 * The signature is therefore mechanical and can be searched for:
 *
 *   1. a drain settled as DRAIN,
 *   2. with a filling inside its recovery window,
 *   3. where the filling was judged AFTER the drain was,
 *   4. and the filling turned out to be REDISTRIBUTION — fuel that never arrived.
 *
 * All four together mean the drain was convicted on evidence the system itself
 * later withdrew. Three of four is still worth a look: the filling may simply
 * not have been judged yet.
 *
 * Read-only.
 *
 *   npx tsx prisma/drain-audit.ts --plate="MTR 04" --days=30 --tunnel
 */

import 'dotenv/config'
import { Client } from 'pg'

const arg = (k: string): string | undefined =>
  process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')

const PLATE  = arg('plate') ?? 'FT 13'
const DAYS   = Number(arg('days') ?? 30)
const TUNNEL = process.argv.includes('--tunnel')

/** Matches LOOKAHEAD_MS in fuel-adjudication.service — the recovery window. */
const LOOKAHEAD_HOURS = 3

function connectionString(): string {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('DIRECT_URL / DATABASE_URL not set')
  if (!TUNNEL) return url
  const u = new URL(url)
  u.hostname = 'localhost'; u.port = '15432'
  return u.toString()
}

const L = (ml: number | null): string => ml == null ? '—' : `${(ml / 1000).toFixed(1)} L`
const pad = (s: string, n: number): string => s.length >= n ? s : s + ' '.repeat(n - s.length)

async function main() {
  const c = new Client({ connectionString: connectionString() })
  await c.connect()

  const { rows: vehicles } = await c.query(
    `SELECT v.id, v.name, v.registration_plate, v.vehicle_type, v.tank_capacity_litres, o.code AS org
       FROM vehicles v JOIN organisations o ON o.id = v.organisation_id
      WHERE v.name ILIKE $1 OR v.registration_plate ILIKE $1
      ORDER BY v.name`,
    [`%${PLATE.replace(/^MUFINDI\s*[-:]?\s*/i, '')}%`],
  )
  if (vehicles.length === 0) { console.log(`\n  No vehicle matching "${PLATE}"\n`); await c.end(); return }

  for (const v of vehicles) {
    console.log(`\n${'═'.repeat(80)}`)
    console.log(`  ${v.name}   ${v.org} · ${v.vehicle_type} · tank ${v.tank_capacity_litres ?? '—'} L`)
    console.log(`${'═'.repeat(80)}`)

    // Every drain in the window, with the earliest filling that sits inside its
    // recovery window — the row that would have truncated its evidence.
    const { rows } = await c.query(
      `SELECT t.id,
              to_char(t.began_at    + interval '3 hours', 'DD Mon HH24:MI') AS began_eat,
              to_char(t.detected_at + interval '3 hours', 'DD Mon HH24:MI') AS det_eat,
              to_char(t.verdict_at  + interval '3 hours', 'DD Mon HH24:MI') AS judged_eat,
              t.stolen_ml, t.verdict, t.verdict_reason, t.verdict_confidence, t.recovered_ml,
              t.drain_cause, t.cause_reason,
              t.fall_seconds, t.measured_drop_ml, t.step_fraction, t.engine_evidence,
              f.id AS fill_id,
              to_char(f.filled_at  + interval '3 hours', 'DD Mon HH24:MI') AS fill_eat,
              to_char(f.verdict_at + interval '3 hours', 'DD Mon HH24:MI') AS fill_judged_eat,
              f.filled_ml, f.verdict AS fill_verdict, f.verdict_reason AS fill_reason,
              f.observed_rise_ml,
              EXTRACT(EPOCH FROM (f.verdict_at - t.verdict_at))/60 AS judged_gap_min
         FROM fuel_thefts t
         LEFT JOIN LATERAL (
           SELECT * FROM fuel_fillings ff
            WHERE ff.vehicle_id = t.vehicle_id
              AND ff.filled_at >= t.began_at
              AND ff.filled_at <= t.detected_at + interval '${LOOKAHEAD_HOURS} hours'
            ORDER BY ff.filled_at ASC LIMIT 1
         ) f ON true
        WHERE t.vehicle_id = $1
          AND t.detected_at >= now() - interval '${DAYS} days'
        ORDER BY t.detected_at DESC`,
      [v.id],
    )

    if (rows.length === 0) { console.log(`\n  No drains recorded in the last ${DAYS} days.\n`); continue }

    let suspect = 0
    for (const r of rows) {
      // The four-part signature.
      const hasFill      = r.fill_id != null
      const drainVerdict = r.verdict === 'DRAIN'
      const fillPhantom  = r.fill_verdict === 'REDISTRIBUTION'
      const judgedAfter  = r.judged_gap_min != null && Number(r.judged_gap_min) > 0
      const flagged      = hasFill && drainVerdict && fillPhantom && judgedAfter
      const partial      = hasFill && drainVerdict && !flagged

      if (flagged) suspect++
      // The signature says the two ledgers were judged against each other out
      // of order. It does NOT say WHICH of them is wrong, and the two
      // possibilities are opposites:
      //
      //   probe artefact  — the level went out and came back to where it
      //                     started, so the DRAIN is false and the filling is
      //                     correctly a phantom. (MUFINDI - FT 13, 23 Sep: net
      //                     -0.4 L, recovery completed on engine restart.)
      //   real movement   — fuel genuinely left and was partly replaced, so the
      //                     drain is right and the FILLING is wrongly written
      //                     off, because FILL_LOOKBEHIND_MINUTES reached back
      //                     across the drop and took its baseline from before
      //                     it. (MUFINDI: MTR 04, 23 Sep: net -2.3 L on a probe
      //                     whose p90 parked swing is 0.7 L.)
      //
      // Deciding between them needs the vehicle's own history, not this row —
      // see prisma/probe-behaviour.ts. Labelling it here would be guessing.
      const tag = flagged ? '  ◀── TRUNCATED · which ledger is wrong? see probe-behaviour.ts'
                : partial ? '  ◀── filling in window, not yet judged'
                : ''

      console.log(`\n  ${r.began_eat} → ${r.det_eat}   claimed ${L(r.stolen_ml)}${tag}`)
      console.log(`    verdict  ${pad(r.verdict, 16)} ${r.verdict_reason ?? '—'}  ` +
                  `conf ${r.verdict_confidence?.toFixed?.(3) ?? '—'}  recovered ${L(r.recovered_ml)}`)
      console.log(`    cause    ${pad(r.drain_cause ?? '—', 16)} ${r.cause_reason ?? '—'}   judged ${r.judged_eat ?? '—'}`)
      console.log(`    shape    fall ${r.fall_seconds ?? '—'}s · measured ${L(r.measured_drop_ml)} · ` +
                  `step ${r.step_fraction?.toFixed?.(3) ?? '—'} · engineEvidence ${r.engine_evidence ?? '—'}`)
      if (hasFill) {
        const gap = r.judged_gap_min == null ? '—' : `${Math.round(Number(r.judged_gap_min))} min later`
        console.log(`    FILLING  ${r.fill_eat}  ${L(r.filled_ml)} claimed · observed rise ${L(r.observed_rise_ml)}`)
        console.log(`             ${pad(r.fill_verdict, 16)} ${r.fill_reason ?? '—'}  judged ${r.fill_judged_eat ?? '—'} (${gap})`)
      } else {
        console.log(`    FILLING  none in the recovery window`)
      }
    }

    console.log(`\n  ${'─'.repeat(76)}`)
    console.log(`  ${rows.length} drains in ${DAYS} days · ${suspect} judged against a filling later disowned`)
    const counted = rows.filter((r: { verdict: string }) => r.verdict === 'DRAIN')
      .reduce((s: number, r: { stolen_ml: number }) => s + r.stolen_ml, 0)
    console.log(`  ${L(counted)} currently counted as fuel that left the tank`)
  }

  console.log('')
  await c.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
