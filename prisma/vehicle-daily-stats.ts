/**
 * Write the per-vehicle daily telemetry rollup — ping and level counts for the
 * probe report, engine-on and stationary counts for fleet-state's idle ratio.
 *
 * The daily job (lib/queues/retention, 21:40 UTC) keeps this current. This is
 * for BACKFILLING, so the probe report has a full thirty-day window and fleet-state a
 * full week, instead of each judging every unit on today alone.
 *
 * Run ON THE BOX directly, not through an npm wrapper — those point
 * DOTENV_CONFIG_PATH at .env, whose DATABASE_URL is the dev SSH tunnel.
 *
 *   npx tsx prisma/vehicle-daily-stats.ts              # yesterday
 *   npx tsx prisma/vehicle-daily-stats.ts --days 30    # the last 30 complete days
 *
 * Safe to interrupt and re-run: each day is replaced wholesale, so a day already
 * written is simply rewritten with the same figures.
 *
 * ## Pace
 *
 * One day is roughly 400 k rows and the instance has 1 GB of RAM, so the days
 * are walked one at a time with a pause between them rather than in parallel.
 * Thirty of them is a few minutes of steady load, which is why this is a script
 * to run off-hours and not something the server does at boot.
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { recordVehicleDailyStats } from '../src/modules/analytics/vehicle-daily-stats.service.js'
import { fleetDayStart } from '../src/lib/provider-time.js'

const argv = process.argv.slice(2)
const i    = argv.indexOf('--days')
const DAYS = i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 1

/** Breathing room between days, so a backfill cannot starve the live API. */
const PAUSE_MS = 2_000

async function main() {
  console.log(`\n📊  recording vehicle daily stats for the last ${DAYS} complete fleet day(s)\n`)

  // Today is deliberately excluded: the day is still running, and the report
  // adds today live precisely because a stored partial day would be wrong.
  const todayStart = fleetDayStart(new Date())

  // Oldest first, so an interrupted run leaves a contiguous window ending at
  // yesterday rather than a gap in the middle of the month.
  for (let d = DAYS; d >= 1; d--) {
    const inDay = new Date(todayStart.getTime() - (d - 1) * 86_400_000 - 1)
    const started = Date.now()
    const out = await recordVehicleDailyStats(inDay)
    console.log(`  ${out.day}  ${String(out.written).padStart(4)} rows  ${((Date.now() - started) / 1000).toFixed(1)}s`)
    if (d > 1) await new Promise(r => setTimeout(r, PAUSE_MS))
  }

  const total = await prisma.vehicleDailyStat.count()
  console.log(`\n✓ ${total} rows in vehicle_daily_stats\n`)
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
