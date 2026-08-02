/**
 * Backfill fuel fillings and drains from Wialon's own fuel reports.
 *
 * `fuel_fillings` and `fuel_thefts` had been empty since the simulator was
 * retired on 2026-07-25 — the tables, the REST module and the analytics that
 * read them all survived, with nothing writing to them. This fills history.
 *
 * ## This is the BACKFILL. The live path is a job, not this script.
 *
 * Ongoing fuel events reach the Live Feed from `lib/queues/fuel-events.ts`,
 * a repeatable job running inside the server. That is not a preference: the
 * notification read path serves its first page from the Redis cache, and a CLI
 * has no Redis, so items published from here are durable but invisible in the
 * dashboard until the cache rolls over. Measured against the live box on
 * 2026-08-02, the same request returned 21 fuel items with `?before=`
 * (Postgres) and 0 without it (cache).
 *
 * So use this for history and for one-off repairs; leave the feed to the job.
 * Both share `modules/fuel/fuel-sync.service.ts`, so the rows are identical.
 *
 * ## Per-org, per-resource
 *
 * Each org's units are reported from its OWN Wialon resource, and templates
 * are matched by NAME rather than id — see the service for why.
 *
 * ## Cost
 *
 * One report execution per vehicle, serialised because Wialon rejects
 * concurrent calls on a session (error 1003). A full 7-day run over both orgs
 * took roughly 50 minutes and wrote 1,119 fillings and 479 drains. Vehicles
 * with no known tank are skipped up front.
 *
 * Idempotent: a row already stored for the same vehicle and timestamp is left
 * alone, so overlapping windows are safe and re-running costs only time.
 *
 * Run: npm run sync:fuel                          (dry run, all orgs, 7 days)
 *      npm run sync:fuel -- --apply
 *      npm run sync:fuel -- --org SUKARI --days 30 --apply
 *      npm run sync:fuel -- --limit 5             (probe a handful of units)
 */

import 'dotenv/config'
import { WialonClient } from '../src/providers/wialon/wialon.client.js'
import { prisma } from '../src/lib/prisma.js'
import {
  resolveOrgFuelSources, syncVehicleFuelEvents,
} from '../src/modules/fuel/fuel-sync.service.js'

const API_URL = process.env.WIALON_API_URL ?? 'https://hst-api.wialon.com'
const TOKEN   = process.env.WIALON_TOKEN || process.env.access_token || ''

const argv  = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const flag  = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : null
}
const DAYS     = Number(flag('days') ?? 7)
const ONLY_ORG = flag('org')?.toUpperCase() ?? null
const LIMIT    = flag('limit') ? Number(flag('limit')) : null

/**
 * Put newly-found events on the Live Feed as well as in the ledger.
 *
 * OFF by default, and deliberately so: a 7-day backfill finds hundreds of
 * events, and replaying week-old drains into a feed labelled "live" would be
 * both useless and misleading. `--notify-age` bounds it further — only events
 * younger than this many hours are published, however wide the window is.
 *
 * Prefer the in-process job for anything ongoing; see the header.
 */
const NOTIFY       = argv.includes('--notify')
const NOTIFY_AGE_H = Number(flag('notify-age') ?? 6)

async function main() {
  if (!TOKEN) throw new Error('WIALON_TOKEN / access_token is not set')
  if (!Number.isFinite(DAYS) || DAYS <= 0) throw new Error(`--days must be a positive number, got ${flag('days')}`)

  const to   = new Date()
  const from = new Date(to.getTime() - DAYS * 86_400_000)

  console.log(`\n⛽  Wialon fuel events → fuel_fillings / fuel_thefts  ${APPLY ? '(APPLYING)' : '(dry run)'}`)
  console.log(`    window: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}  (${DAYS}d)\n`)

  const client = new WialonClient(TOKEN, API_URL)
  await client.login()

  const notifyCutoff = new Date(Date.now() - NOTIFY_AGE_H * 3_600_000)
  if (NOTIFY) {
    console.log(`    --notify: feed items for events after ${notifyCutoff.toISOString().slice(0, 16).replace('T', ' ')} (last ${NOTIFY_AGE_H}h)`)
    console.log('    NOTE: items published from a CLI are durable but will not appear on a')
    console.log('          dashboard served with Redis until the cached first page rolls over.\n')
  }

  const sources = await resolveOrgFuelSources(client)
  let grandFillings = 0, grandThefts = 0, grandNotified = 0, grandCorrected = 0

  for (const source of sources) {
    if (ONLY_ORG && source.code !== ONLY_ORG) continue

    // Only vehicles bound to a Wialon unit AND known to have a tank can carry
    // a fuel event. The capacity is the cheap proxy for "has a fuel probe" —
    // it is read from the probe's own sensor name at sync time.
    const vehicles = await prisma.vehicle.findMany({
      where:   { organisationId: source.orgId, deviceId: { startsWith: 'wialon:' }, tankCapacityLitres: { not: null } },
      select:  { id: true, deviceId: true, registrationPlate: true },
      orderBy: { registrationPlate: 'asc' },
      ...(LIMIT ? { take: LIMIT } : {}),
    })

    console.log(`  ── ${source.code} · resource ${source.resourceId} · template [${source.templateId}] "${source.templateName}"`)
    console.log(`     ${vehicles.length} vehicle(s) with a tracker and a known tank\n`)

    let fillings = 0, thefts = 0, dupFill = 0, dupTheft = 0, failed = 0, done = 0, notified = 0, corrected = 0

    for (const v of vehicles) {
      try {
        const out = await syncVehicleFuelEvents(client, source, v, {
          from, to,
          apply:        APPLY,
          notify:       NOTIFY,
          notifyCutoff: NOTIFY ? notifyCutoff : undefined,
        })
        fillings += out.fillings
        thefts   += out.thefts
        dupFill  += out.dupFill
        dupTheft += out.dupTheft
        corrected += out.corrected
        notified += out.published
      } catch (err) {
        failed++
        console.log(`     ✗ ${v.registrationPlate}: ${err instanceof Error ? err.message : err}`)
        continue
      }

      done++
      if (done % 25 === 0) {
        console.log(`     … ${done}/${vehicles.length} units — ${fillings} filling(s), ${thefts} drain(s) so far`)
      }
    }

    console.log(`\n     ${source.code}: ${fillings} filling(s), ${thefts} drain(s) ${APPLY ? 'written' : 'to write'}`)
    console.log(`     already stored: ${dupFill} filling(s), ${dupTheft} drain(s)${failed ? `  ·  ${failed} unit(s) failed` : ''}`)
    // The whole point of a re-run over old dates: Wialon refines an event's
    // figures after the fact, and a row stored at first sight keeps the
    // roughest of them. Silent corrections would make a repair pass look
    // identical to a no-op.
    if (APPLY && corrected > 0) console.log(`     corrected: ${corrected} row(s) whose figures the provider has since revised`)
    if (NOTIFY) console.log(`     live feed: ${notified} item(s) published`)
    console.log()

    grandCorrected += corrected
    grandFillings += fillings
    grandThefts   += thefts
    grandNotified += notified
  }

  console.log(`  ── total: ${grandFillings} filling(s), ${grandThefts} drain(s) ${APPLY ? 'written' : 'pending'}`)
  if (APPLY && grandCorrected > 0) console.log(`     ${grandCorrected} existing row(s) corrected`)
  if (NOTIFY) console.log(`     ${grandNotified} feed item(s) published`)
  if (!APPLY) console.log('\n  Dry run — nothing written. Re-run with:  npm run sync:fuel -- --apply')
  console.log()

  await client.logout().catch(() => {})
}

main()
  .catch(err => { console.error('\n❌  sync-fuel-events failed:', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect() })
