/**
 * Write the daily fuel trend rows — opening, closing, and the motion-slosh
 * moving average per vehicle per fleet day.
 *
 * The daily job (lib/queues/retention, 21:20 UTC) keeps this current. This is
 * for BACKFILLING history, so a trend line has something to draw before
 * tomorrow.
 *
 * Run ON THE BOX directly, not through an npm wrapper — those point
 * DOTENV_CONFIG_PATH at .env, whose DATABASE_URL is the dev SSH tunnel.
 *
 *   npx tsx prisma/fuel-trends.ts              # yesterday
 *   npx tsx prisma/fuel-trends.ts --days 14    # the last 14 complete days
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { recordFuelTrends } from '../src/modules/fuel/fuel-trend.service.js'
import { fleetDayStart } from '../src/lib/provider-time.js'

const argv = process.argv.slice(2)
const i    = argv.indexOf('--days')
const DAYS = i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 1

async function main() {
  console.log(`\n⛽  recording fuel trends for the last ${DAYS} complete fleet day(s)\n`)

  // OLDEST first, and that ordering is load-bearing. The turbulence average
  // spans days by reading previous days' stored run values, so a day computed
  // before its predecessors would find nothing behind it and report a one-run
  // average. Walking forwards, each day sees the ones already written.
  //
  // Today is deliberately excluded: a day still running has no close, and a
  // half-day turbulence average is not a trend point.
  const todayStart = fleetDayStart(new Date())
  for (let d = DAYS; d >= 1; d--) {
    const inDay = new Date(todayStart.getTime() - (d - 1) * 86_400_000 - 1)
    for (const out of await recordFuelTrends(inDay)) {
      console.log(`  ${out.day}  ${String(out.written).padStart(4)} rows written · ${out.withTurbulence} with a turbulence figure`)
    }
  }
  console.log()
}

main()
  .catch(err => { console.error('\n❌  fuel-trends failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
