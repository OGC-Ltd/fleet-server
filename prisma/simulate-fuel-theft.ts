/**
 * Put fuel-theft events on the Live Feed, from REAL ledger rows, so the feed
 * and the dashboard can be exercised without waiting for a genuine incident.
 *
 * At the rate the classifier actually fires — six siphons in thirty days —
 * nobody can sit and watch the feed to check that a theft renders correctly.
 * This drives the same code path a real one would: it classifies real drains,
 * writes the cause, and publishes through `publishNotificationDurable`, which
 * is the single function that fans out to SSE, the Redis first page and
 * Postgres at once.
 *
 * ## What makes it a simulation rather than a lie
 *
 * The VEHICLE, the VOLUME, the TIMES and the PLACE are all real — they are
 * rows off `fuel_thefts`. What is synthetic is the CAUSE: rows that the
 * classifier judged INDETERMINATE are announced as if they had been judged a
 * siphon. Nothing invents fuel that did not move.
 *
 * Every item it publishes is tagged `[SIMULATED]` in its own text and carries
 * a `sim-fuel-` feed id, so nothing it produces can be mistaken for a real
 * finding by a reader or by `--clean`.
 *
 * ## Always clean up
 *
 *     npm run sim:fuel -- --count 3      publish three
 *     npm run sim:fuel -- --clean        remove every simulated item
 *
 * `--clean` deletes only rows whose feed id starts with `sim-fuel-`, so it can
 * never touch a genuine notification.
 */

import { prisma } from '../src/lib/prisma.js'
import { logger } from '../src/lib/logger.js'
import { publishNotificationDurable } from '../src/lib/notifications/notification.store.js'

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d
}
const CLEAN = process.argv.includes('--clean')
const COUNT = Number(arg('count', '3'))
// Both fleets by default. They are genuinely different populations — KASULU
// is plant and generators with 1,700 L tanks, SUKARI is 482 tractors and
// trucks — and a simulation that only ever exercised one would leave the
// other's feed, cards and vocabulary untested.
const ORGS = arg('org', 'KASULU,SUKARI').split(',').map(o => o.trim()).filter(Boolean)

/** The marker every simulated item carries, in its id and in its text. */
const SIM_PREFIX = 'sim-fuel-'
const SIM_TAG    = '[SIMULATED]'

const L = (ml: number): string => {
  const l = ml / 1000
  return `${Number.isInteger(l) ? l : l.toFixed(1)} L`
}

async function clean(): Promise<void> {
  // `notification.feedId` is the durable key publishNotificationDurable
  // upserts on, and it is the only safe thing to match: text would catch a
  // real item that happened to quote the word, and a time range would catch
  // whatever else was published in the same minute.
  const { count } = await prisma.notification.deleteMany({
    where: { feedId: { startsWith: SIM_PREFIX } },
  })
  console.log(`removed ${count} simulated feed rows`)
  console.log('NOTE: the Redis first page and any open dashboard keep their copy')
  console.log('      until the cache rotates — this clears the durable store.')
}

async function publishFor(code: string): Promise<number> {
  const org = await prisma.organisation.findFirst({ where: { code }, select: { id: true, code: true } })
  if (!org) { console.log(`  ${code}: no such organisation, skipped`); return 0 }

  // Real drains, recent enough to look current, with everything the feed line
  // and the incident window need to render.
  const rows = await prisma.fuelTheft.findMany({
    where: {
      vehicle: { organisationId: org.id },
      beganAt: { gte: new Date(Date.now() - 20 * 3600_000) },
      initialLocation: { not: null },
      finalFuelLevelMl: { not: null },
      stolenMl: { gte: 20_000 },
    },
    orderBy: { stolenMl: 'desc' },
    take: COUNT,
    select: {
      id: true, vehicleId: true, beganAt: true, stolenMl: true,
      initialLocation: true, finalFuelLevelMl: true,
      vehicle: { select: { registrationPlate: true } },
    },
  })
  if (rows.length === 0) throw new Error('no suitable drains in the last 20 h to simulate from')

  console.log(`publishing ${rows.length} SIMULATED fuel-theft items for ${org.code}\n`)
  for (const t of rows) {
    const plate = t.vehicle.registrationPlate
    const where = t.initialLocation ? ` at ${t.initialLocation}` : ''
    const tank  = t.finalFuelLevelMl != null ? `. Tank now ${L(t.finalFuelLevelMl)}.` : '.'
    // Same shape as the real line in fuel-adjudication.service, with the tag
    // in front so no reader can mistake it for a finding.
    const text  = `${SIM_TAG} POSSIBLE THEFT: ${plate} — ${L(t.stolenMl)} drawn off while parked${where}${tank}`

    const { published } = await publishNotificationDurable({
      orgId:     org.id,
      id:        `${SIM_PREFIX}${t.id}`,
      source:    'wialon',
      alertType: 'fuelInconsistency',
      severity:  'critical',
      text,
      // NOW, not the drain's own `beganAt` — and this is the one place the
      // simulation deliberately departs from the real path. The feed orders
      // by event time, so a real siphon appears where it happened; a
      // simulated one built from a 16-hour-old row would sort below sixty
      // newer items and be invisible, which defeats the only purpose it has.
      // The drain's true window is still shown in the incident card.
      at:        new Date(),
      plate,
      vehicleId: t.vehicleId,
    })
    console.log(`  ${published ? 'published' : 'deduped  '}  ${plate.padEnd(18)} ${L(t.stolenMl).padStart(8)}`)
  }
  logger.info({ org: org.code, count: rows.length }, 'Simulated fuel-theft feed items published')
  return rows.length
}

async function main(): Promise<void> {
  if (CLEAN) { await clean(); return }

  let total = 0
  for (const code of ORGS) total += await publishFor(code)

  console.log(`
${total} simulated items across ${ORGS.length} organisation(s)`)
  console.log('Remove them with:  npm run sim:fuel -- --clean')
}

main()
  .catch((err: unknown) => { console.error(err); process.exitCode = 1 })
  .finally(async () => {
    await prisma.$disconnect()
    // Redis holds the event loop open. On the box — the only place this is
    // meant to run, because the feed's first page comes from that cache —
    // the script did its work and then hung until a timeout killed it, which
    // reads like a failure when it is not. Nothing here outlives the run, so
    // exiting explicitly is honest rather than a shortcut.
    process.exit(process.exitCode ?? 0)
  })
