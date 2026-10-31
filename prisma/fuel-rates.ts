/**
 * Derive each vehicle's fuel rate from its own telemetry.
 *
 * Both figures are derived for every machine — litres per engine-hour and per
 * kilometre — and `primary_basis` records which one is really its rate. See
 * `resolveBasis`; plant and tractors take hours, road vehicles take kilometres.
 *
 * Dry run by default — derives, prints, stores nothing. The method, the measured
 * values and the caveats are in `docs/fuel-consumption-rates.md`; the rule is in
 * `src/modules/fuel/fuel-rate.ts`.
 *
 * Run ON THE BOX directly, not through an npm wrapper that points
 * DOTENV_CONFIG_PATH at .env, whose DATABASE_URL is the dev SSH tunnel.
 *
 *   npx tsx prisma/fuel-rates.ts
 *   npx tsx prisma/fuel-rates.ts --apply
 *   npx tsx prisma/fuel-rates.ts --days 7 --apply
 *
 * ⚠️ `--days` widens a query that sorts the full fuel-carrying telemetry window
 * on an instance with ~1 GB of RAM for a 5.9 GB database. Three days is the only
 * window this has been shown to survive. Widen it with someone watching the box,
 * not because thirty days would be a better number — it would, and that is why
 * the flag exists rather than a new default.
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { deriveFuelRates, MAX_PLAUSIBLE_L_PER_HOUR, RATE_WINDOW_DAYS } from '../src/modules/fuel/fuel-rate.service.js'
import { MIN_RUNS } from '../src/modules/fuel/fuel-rate.js'
import { persistMeasuredBurnRates } from '../src/modules/fuel/fuel-burn-rate.service.js'

const argv  = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const i     = argv.indexOf('--days')
const DAYS  = i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : RATE_WINDOW_DAYS

async function main() {
  if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error(`--days must be a positive number, got ${argv[i + 1]}`)

  console.log(`\n⛽  fuel consumption rates  ${APPLY ? '(STORING)' : '(dry run)'}`)
  console.log(`    ${DAYS}-day window · a vehicle needs ${MIN_RUNS} runs to use its own rate\n`)

  const out = await deriveFuelRates({ days: DAYS, apply: APPLY })

  console.log(`  ${out.derived} vehicles produced a rate`)
  console.log(`  ${out.usable} of them cleared ${MIN_RUNS} runs — the rest fall back to their org+type median`)
  console.log(`  ${out.distanceBasis} of them are judged per KILOMETRE, ${out.derived - out.distanceBasis} per engine-hour`)
  console.log(`  ${out.withIdleRate} have a separate IDLE rate · ${out.withWorkRate} a separate WORKING rate`)
  console.log(`  ${out.stored} rows stored`)
  if (out.pruned > 0) {
    console.log(`  ${out.pruned} stale rows ${APPLY ? 'pruned' : 'WOULD be pruned'} as implausible` +
                ` (over ${MAX_PLAUSIBLE_L_PER_HOUR} L/h)`)
  }
  // The weekly RATE_JOB does both, so this does too — a CLI that refreshed
  // only half would leave a fresh derivation beside a stale balance and make
  // the two disagree for reasons nobody could reconstruct later.
  if (APPLY) {
    const m = await persistMeasuredBurnRates()
    console.log(`\n  measured balance: ${m.measured} vehicles · ${m.stored} written` +
                ` · ${m.withKm} also carry a measured L/km` +
                `${m.orphaned > 0 ? ` · ${m.orphaned} had no rate row to attach to` : ''}`)
  }

  if (!APPLY) console.log('\n  Dry run — nothing stored. Re-run with --apply\n')
  else console.log()
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
