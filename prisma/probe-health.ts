/**
 * Find fuel probes that have stopped reporting.
 *
 * Dry run by default — prints what it would raise and publishes nothing. The
 * rule and the reasoning are in `src/modules/fuel/fuel-probe-health.ts`.
 *
 * Run ON THE BOX directly, not through an npm wrapper that points
 * DOTENV_CONFIG_PATH at .env, whose DATABASE_URL is the dev SSH tunnel.
 *
 *   npx tsx prisma/probe-health.ts
 *   npx tsx prisma/probe-health.ts --notify
 *   npx tsx prisma/probe-health.ts --org SUKARI --notify
 */

import 'dotenv/config'
import { prisma } from '../src/lib/prisma.js'
import { sweepProbeHealth } from '../src/modules/fuel/fuel-probe-health.service.js'
import { DEAD_HOURS, LOOKBACK_DAYS } from '../src/modules/fuel/fuel-probe-health.js'

const argv   = process.argv.slice(2)
const NOTIFY = argv.includes('--notify')
const i      = argv.indexOf('--org')
const ORG    = i >= 0 && argv[i + 1] ? argv[i + 1]!.toUpperCase() : null

async function main() {
  console.log(`\n⛽  fuel probe health  ${NOTIFY ? '(PUBLISHING)' : '(dry run)'}`)
  console.log(`    ${LOOKBACK_DAYS}-day window · dead after ${DEAD_HOURS}h of silence\n`)

  const orgId = ORG
    ? (await prisma.organisation.findFirst({ where: { code: ORG }, select: { id: true } }))?.id
    : undefined
  if (ORG && !orgId) throw new Error(`no organisation with code ${ORG}`)

  const out = await sweepProbeHealth({ orgId, notify: NOTIFY })

  console.log(`  ${out.examined} probes examined`)
  console.log(`  ${out.died} died — read a real level, now silent`)
  console.log(`  ${out.silent} silent — never read anything`)
  console.log(`  ${out.ok} reporting · ${out.notFitted} not fitted · ${out.unknown} too little telemetry`)
  console.log(`  ${out.published} feed items published`)
  if (!NOTIFY) console.log('\n  Dry run — nothing published. Re-run with --notify\n')
  else console.log()
}

main()
  .catch(err => { console.error('\n❌  probe-health failed:', err); process.exit(1) })
  .finally(async () => {
    await prisma.$disconnect()
    // Explicit, and not paranoia. Publishing a notification opens a Redis
    // connection through lib/notifications/notification-cache, and nothing
    // closes it — so this script finished its 47 alerts and then sat on the
    // box for three hours holding the event loop open. Disconnecting Prisma is
    // not enough; that handle has no owner to close it from here.
    //
    // The adjudication CLIs need no such thing: they never publish.
    process.exit(0)
  })
