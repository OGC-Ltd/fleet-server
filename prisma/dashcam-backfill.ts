/**
 * Save the dashcam alarms VSS still holds (about two weeks back) into
 * dashcam_alarms / dashcam_capture_days, once, before VSS drops them
 * (operator, 2026-11-24). The nightly job (lib/queues/dashcam-capture) keeps
 * them saved from then on.
 *
 * Gentle on VSS on purpose: this runs beside the live server, whose Alarms page
 * shares the same VSS account and its one-search-every-10-s limit. One day at
 * a time, `--gap` seconds apart (default 30), and a "too frequent" answer is
 * waited out and tried again. Re-running is safe: alarms already held are not
 * written twice.
 *
 * Run: npm run dashcam:backfill                                  (dry run: reads VSS, writes nothing)
 *      npm run dashcam:backfill -- --apply
 *      npm run dashcam:backfill -- --org AQUAMIST --from 2026-11-11 --to 2026-11-23 --apply
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { captureDay, dayWindow, fleetDayOf, lastDays, organisationsWithCameras } from '../src/modules/dashcam/dashcam-capture.js'
import { VSS_TOO_FREQUENT } from '../src/providers/vss/index.js'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const apply = process.argv.includes('--apply')
const gapMs = Number(arg('gap') ?? 30) * 1000
const onlyOrg = arg('org')?.toUpperCase()
const DAY = 86_400_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Default: the oldest day VSS still holds (13 full days back) to yesterday
const all = lastDays(13)
const from = arg('from') ?? all[0]!
const to = arg('to') ?? all.at(-1)!
const days: string[] = []
for (let t = dayWindow(from).from + 12 * 3_600_000; fleetDayOf(t) <= to; t += DAY) days.push(fleetDayOf(t))

async function main() {
  console.log(`${apply ? 'APPLY' : 'DRY RUN (nothing written)'}: ${days[0]} to ${days.at(-1)} (${days.length} days), ${gapMs / 1000} s between days`)
  const orgs = (await organisationsWithCameras()).filter((o) => !onlyOrg || o.code === onlyOrg)
  console.log(`organisations with dashcams: ${orgs.map((o) => o.code).join(', ') || 'none'}`)
  const totals = { alarms: 0, added: 0, untyped: 0, failed: 0 }
  for (const o of orgs) {
    for (const day of days) {
      let done = false
      for (let attempt = 1; attempt <= 4 && !done; attempt++) {
        try {
          const r = await captureDay(o.id, day, { apply })
          if (r.skipped) console.log(`${o.code.padEnd(10)} ${day}  skipped: ${r.skipped}`)
          else console.log(`${o.code.padEnd(10)} ${day}  ${String(r.alarms).padStart(5)} alarms, ${apply ? `${r.added} new, ${r.typed} typed now, ` : ''}${r.untyped} untyped${r.partial ? ', PARTIAL' : ''}`)
          totals.alarms += r.alarms; totals.added += r.added; totals.untyped += r.untyped
          done = true
        } catch (err) {
          const busy = (err as { status?: number })?.status === VSS_TOO_FREQUENT
          console.log(`${o.code.padEnd(10)} ${day}  attempt ${attempt}: ${busy ? 'VSS says too frequent, waiting 2 min' : String((err as Error)?.message ?? err).slice(0, 100)}`)
          if (!busy) break
          await sleep(120_000)
        }
      }
      if (!done) totals.failed += 1
      await sleep(gapMs)
    }
  }
  console.log(`total: ${totals.alarms} alarms, ${totals.added} saved new, ${totals.untyped} untyped, ${totals.failed} days not captured${totals.failed ? ' (run again for those)' : ''}`)
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
