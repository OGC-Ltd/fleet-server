/**
 * Recompute `vehicle_daily_stats.idle_fixes` under the position-aware rule.
 *
 * ## Why history has to move
 *
 * Until 2026-08-28 `idle_fixes` was `engine_on AND speed <= IDLE_SPEED_KMH` —
 * speed alone, with no test of whether the machine had actually stayed put. A
 * digging excavator works in place, so it counted as idle throughout, and EX
 * read 66% idle over a week.
 *
 * The rollup now also requires the fix to land in the same half-metre grid cell
 * as the one before it. That fixes days written from today onward and leaves
 * every earlier day counting something else — and the API reads a WINDOW (day,
 * week, month), so a week spanning the change would blend two definitions into
 * one percentage and nothing would look wrong.
 *
 * ## Why this is not just re-running the rollup
 *
 * `recordVehicleDailyStats` also rebuilds the excavator and dozer areas, and
 * that geometry dominates: one excavator's day measured 19 s to read and union,
 * against twenty-seven of them. Thirty days of that is hours of work to correct
 * two integers.
 *
 * So this recomputes ONLY the two counts, day by day, and updates in place.
 * Everything else on the row — pings, peak, the areas, the timestamps — is left
 * exactly as the rollup wrote it.
 *
 * ## Usage
 *
 *     npx cross-env DOTENV_CONFIG_PATH=.env tsx prisma/backfill-idle-fixes.ts
 *     ...                                                                 --apply
 *     ...                                                     --days 45 --apply
 *
 * Dry run by default, and it reports the shift per category so the change is
 * visible before it is written. One day at a time with a pause between, because
 * each day's query sorts that day's telemetry and this competes with the live
 * poll for the same pooler.
 */

import { prisma } from '../src/lib/prisma.js'
import { vehicleFiguresForDay } from '../src/modules/analytics/vehicle-daily-stats.service.js'
import { fleetDayStart, fleetDayKey } from '../src/lib/provider-time.js'
import { machinePrefix } from '../src/modules/fuel/fuel-theft-classifier.js'

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt
}
const APPLY = process.argv.includes('--apply')
const DAYS  = Number(arg('days', '30'))
const PAUSE_MS = Number(arg('pause', '250'))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const padR = (s: string, w: number) => s.padEnd(w)
const padL = (s: string, w: number) => s.padStart(w)

console.log(`\n⏱  recomputing idle_fixes with the position test  ${APPLY ? '(APPLYING)' : '(dry run)'}`)
console.log(`    ${DAYS} fleet days back from the last complete one\n`)

const plates = new Map(
  (await prisma.vehicle.findMany({ select: { id: true, registrationPlate: true } }))
    .map(v => [v.id, v.registrationPlate]),
)

/** category → old idle fixes, new idle fixes, engine fixes. */
const shift = new Map<string, { before: number; after: number; engine: number }>()
let rowsSeen = 0, rowsChanged = 0

for (let back = 1; back <= DAYS; back++) {
  const dayStart = new Date(fleetDayStart().getTime() - back * 86_400_000)
  const dayEnd   = new Date(dayStart.getTime() + 86_400_000)
  const day      = fleetDayKey(new Date(dayStart.getTime() + 3 * 3_600_000))

  const [figures, stored] = await Promise.all([
    vehicleFiguresForDay(dayStart, dayEnd),
    prisma.vehicleDailyStat.findMany({
      where:  { day },
      select: { vehicleId: true, idleFixes: true, engineFixes: true },
    }),
  ])
  const storedBy = new Map(stored.map(s => [s.vehicleId, s]))

  let changedToday = 0
  for (const f of figures) {
    const was = storedBy.get(f.vehicleId)
    if (was == null) continue          // no row to correct
    rowsSeen++

    const cat = machinePrefix(plates.get(f.vehicleId) ?? '') ?? 'OTHER'
    const s = shift.get(cat) ?? { before: 0, after: 0, engine: 0 }
    s.before += was.idleFixes ?? 0
    s.after  += f.idleFixes
    s.engine += f.engineFixes
    shift.set(cat, s)

    if ((was.idleFixes ?? -1) === f.idleFixes && (was.engineFixes ?? -1) === f.engineFixes) continue
    rowsChanged++
    changedToday++
    if (!APPLY) continue
    await prisma.vehicleDailyStat.updateMany({
      where: { vehicleId: f.vehicleId, day },
      data:  { idleFixes: f.idleFixes, engineFixes: f.engineFixes },
    })
  }

  console.log(`    ${day.toISOString().slice(0, 10)}  ${padL(String(figures.length), 4)} units` +
              `  ${padL(String(changedToday), 4)} ${APPLY ? 'updated' : 'would change'}`)
  await sleep(PAUSE_MS)
}

console.log(`\n    idle share by category, old rule vs new`)
console.log('    cat       engine fixes    was idle    now idle     shift')
for (const [cat, s] of [...shift].sort((a, b) => b[1].engine - a[1].engine)) {
  if (s.engine < 500) continue
  const p = (x: number) => `${((x / s.engine) * 100).toFixed(1)}%`
  console.log(`    ${padR(cat, 10)}${padL(s.engine.toLocaleString(), 13)}` +
              `${padL(p(s.before), 12)}${padL(p(s.after), 12)}` +
              `${padL(`${(((s.after - s.before) / s.engine) * 100).toFixed(1)} pp`, 10)}`)
}

console.log(`\n    ${rowsSeen} rows examined · ${rowsChanged} ${APPLY ? 'updated' : 'would change'}`)
if (!APPLY) console.log('\n    Dry run — nothing written. Re-run with --apply\n')
else console.log()

process.exit(0)
