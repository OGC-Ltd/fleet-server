/**
 * Backfill the idle ratio's two counts on existing fuel_daily_trends rows.
 *
 * `engine_fixes` and `idle_fixes` arrived after the table did, so every row
 * written before 2026-08-20 carries nulls for them. This restates them from the
 * telemetry the days were built from.
 *
 * Separate from `prisma/fuel-trends.ts` on purpose. That script recomputes a
 * whole day through computeFleetTankState — around six seconds per org per day,
 * rebuilding levels, slosh, distance and burn — to correct two counts that one
 * grouped query produces in well under a second. Re-running it for thirty days
 * would be minutes of load on a 1 GB instance to arrive at the same numbers.
 *
 * Run ON THE BOX directly, not through an npm wrapper — those point
 * DOTENV_CONFIG_PATH at .env.example, whose DATABASE_URL is the dev SSH tunnel.
 *
 *   npx tsx prisma/trend-fixes.ts              # the last 30 days
 *   npx tsx prisma/trend-fixes.ts --days 60
 *
 * Idempotent: it rewrites the two columns for the days it covers and touches
 * nothing else on the row.
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { fixCountsForWindow } from '../src/modules/analytics/fleet-state.service.js'
import { fleetDayStart, fleetDayKey } from '../src/lib/provider-time.js'

const argv = process.argv.slice(2)
const i    = argv.indexOf('--days')
const DAYS = i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 30

/** Breathing room between days, so a backfill cannot starve the live API. */
const PAUSE_MS = 1_500

async function main() {
  console.log(`\n⏱  backfilling idle fix counts for the last ${DAYS} complete fleet day(s)\n`)
  const todayStart = fleetDayStart(new Date())

  for (let d = DAYS; d >= 1; d--) {
    const dayStart = new Date(todayStart.getTime() - d * 86_400_000)
    const day      = fleetDayKey(new Date(dayStart.getTime() + 1))
    const started  = Date.now()

    // Whole fleet in one pass — the counts are per vehicle and the day is the
    // expensive part, so splitting by org would scan the same day twice.
    const counts = await fixCountsForWindow(dayStart, new Date(dayStart.getTime() + 86_400_000))

    let updated = 0
    for (const c of counts) {
      const { count } = await prisma.fuelDailyTrend.updateMany({
        where: { vehicleId: c.vehicleId, day },
        data:  { engineFixes: c.engineFixes, idleFixes: c.idleFixes },
      })
      updated += count
    }

    // Every remaining row for a day we DID scan ran its engine zero times.
    // That is a measurement; leaving it null would say nobody looked.
    const { count: zeroed } = await prisma.fuelDailyTrend.updateMany({
      where: { day, engineFixes: null },
      data:  { engineFixes: 0, idleFixes: 0 },
    })

    console.log(`  ${day.toISOString().slice(0, 10)}  ${String(updated).padStart(4)} counted  ${String(zeroed).padStart(3)} zeroed  ${((Date.now() - started) / 1000).toFixed(1)}s`)
    if (d > 1) await new Promise(r => setTimeout(r, PAUSE_MS))
  }

  const [done, total] = await Promise.all([
    prisma.fuelDailyTrend.count({ where: { engineFixes: { not: null } } }),
    prisma.fuelDailyTrend.count(),
  ])
  console.log(`\n✓ ${done} of ${total} trend rows now carry fix counts\n`)
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
