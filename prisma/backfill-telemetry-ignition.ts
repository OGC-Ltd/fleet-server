/**
 * Copy `ignition_known` and the engine-hours counter out of the raw payload and
 * into the columns `20260826120000_telemetry_ignition_provenance` created.
 *
 * DRY RUN by default. Pass `--apply` to write.
 *
 * ## Why this is a script and not part of the migration
 *
 * Measured against production, 2026-08-26:
 *
 *     vehicle_telemetries      ~10,884,446 rows   4,358 MB
 *     vehicle_telemetry_raws   ~11,077,928 rows   8,571 MB
 *
 * Nearly 13 GB across the pair, on an instance with roughly 1 GB of RAM that is
 * also serving a poll every two seconds. One `UPDATE ... FROM` across that join
 * would hold a connection and locks for as long as it took and starve the live
 * path — the same reason the retention sweep batches its DELETEs, and more so
 * here because the join is the expensive half.
 *
 * Narrowing the window does not rescue it either: 10,882,231 of the 10,884,446
 * rows fall inside the last 30 days, so the table already holds about a month
 * and "backfill 30 days" means "backfill everything". Seven days is 2,311,286
 * rows, which is why that is the default.
 *
 * ## How a row is known to be done
 *
 * `ignition_source` is the marker, and this is the reason the enum carries a
 * NONE member. Every row this pass touches gets a non-null source — NONE when
 * nothing could be established — so `ignition_source IS NULL` means "not yet
 * processed" and nothing else. That makes the pass resumable with no cursor to
 * store, idempotent if re-run, and safe to interrupt: stop it whenever, start it
 * again later, and it picks up where it left off.
 *
 * It also fixes the meaning of the other column, which the migration deliberately
 * left open:
 *
 *     ignition_known IS NULL   this row has not been processed
 *     ignition_known = false   processed, and the unit reported no ignition
 *     ignition_known = true    processed, and a genuine binary line answered
 *
 * ## Why SENSOR is the only source it can assign
 *
 * `ignition_known` in the payload is `ignitionOn !== null`, and `ignitionOn`
 * comes from `readIgnition`, which accepts a value only when it is actually
 * binary. So a historical `true` is always a genuine digital line: SENSOR.
 *
 * METER and VOLTAGE are deliberately NOT derived here. Both need more than one
 * row — a meter delta needs the previous fix, a voltage threshold needs the
 * unit's own distribution — and neither rule has been validated yet. Deriving
 * them now would bake an unvalidated judgement into 2.3 million rows.
 *
 * That is not a deferral so much as a sequencing win: this pass pays the
 * expensive raws join ONCE and lands `engine_hours_meter` in a narrow column, so
 * the meter derivation that follows can read 4 GB of telemetry instead of
 * joining 8.6 GB of JSON.
 *
 * ## Newest first
 *
 * Walks `id` descending, because everything that reads these columns reads a
 * recent window — the rate derivation looks back three days, the classifier
 * hours. If the pass is interrupted, the part that matters is the part already
 * done.
 *
 * ## Usage
 *
 *     npx cross-env DOTENV_CONFIG_PATH=.env.example tsx prisma/backfill-telemetry-ignition.ts
 *     ...                                                                       --apply
 *     ...                                                     --days 30 --batch 2000 --apply
 *
 * Widen `--days` or `--batch` with someone watching the box. The defaults are
 * chosen to be dull, not fast.
 */

import { prisma } from '../src/lib/prisma.js'

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt
}
const APPLY = process.argv.includes('--apply')
const DAYS  = Number(arg('days', '7'))

/**
 * Rows per statement. Deliberately small — this competes with the telemetry
 * poll for the same pooler, and the poll must win.
 */
const BATCH = Number(arg('batch', '1000'))

/** Pause between batches, so the connection pool is yielded rather than held. */
const PAUSE_MS = Number(arg('pause', '250'))

/**
 * Hard stop on one run, so an unattended pass cannot grind all night. At the
 * defaults this is 2 million rows, about one seven-day window.
 */
const MAX_BATCHES = Number(arg('max-batches', '2000'))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const cutoff = new Date(Date.now() - DAYS * 86_400_000)
const n = (x: number | bigint) => Number(x).toLocaleString()

// ── what is there to do ─────────────────────────────────────────────────────

const [scope] = await prisma.$queryRaw<Array<{ todo: bigint; done: bigint }>>`
  SELECT count(*) FILTER (WHERE ignition_source IS NULL)     AS todo,
         count(*) FILTER (WHERE ignition_source IS NOT NULL) AS done
    FROM vehicle_telemetries
   WHERE captured_at >= ${cutoff}
`
const todo = Number(scope?.todo ?? 0)
const done = Number(scope?.done ?? 0)

console.log(`\n  window            last ${DAYS} days`)
console.log(`  already processed ${n(done)}`)
console.log(`  to process        ${n(todo)}`)
console.log(`  batch / pause     ${n(BATCH)} rows / ${PAUSE_MS} ms`)
console.log(`  mode              ${APPLY ? 'APPLY — writing' : 'DRY RUN — pass --apply to write'}\n`)

if (todo === 0) {
  console.log('  Nothing to do.\n')
  process.exit(0)
}

if (!APPLY) {
  // A dry run must not lie about cost, so it measures one batch's SELECT rather
  // than guessing a rate. It never writes.
  const t0 = Date.now()
  const probe = await prisma.$queryRaw<Array<{ id: bigint }>>`
    SELECT id FROM vehicle_telemetries
     WHERE ignition_source IS NULL AND captured_at >= ${cutoff}
     ORDER BY id DESC LIMIT ${BATCH}
  `
  const ms = Date.now() - t0
  const batches = Math.ceil(todo / BATCH)
  console.log(`  probe: selected ${n(probe.length)} ids in ${ms} ms`)
  console.log(`  ${n(batches)} batches at ${PAUSE_MS} ms pause = at least ` +
              `${Math.round((batches * PAUSE_MS) / 60_000)} min of pauses alone`)
  console.log('\n  Nothing was written.\n')
  process.exit(0)
}

// ── the pass ────────────────────────────────────────────────────────────────

let processed = 0
let batches   = 0
const started = Date.now()

while (batches < MAX_BATCHES) {
  const t0 = Date.now()

  // One statement: pick the batch and update it in the same query, so no id
  // list travels back and forth and no row can be claimed twice.
  //
  // LEFT JOIN, not JOIN. A telemetry row whose raw payload is missing must
  // still be marked NONE — under an inner join it would be skipped, stay NULL,
  // and be re-selected by the next batch for ever.
  const updated = await prisma.$executeRaw`
    WITH batch AS (
      SELECT id FROM vehicle_telemetries
       WHERE ignition_source IS NULL AND captured_at >= ${cutoff}
       ORDER BY id DESC
       LIMIT ${BATCH}
    )
    UPDATE vehicle_telemetries t
       SET ignition_known     = COALESCE((r.payload->>'ignition_known')::boolean, false),
           ignition_source    = CASE
                                  WHEN (r.payload->>'ignition_known')::boolean IS TRUE
                                  THEN 'SENSOR'::"IgnitionSource"
                                  ELSE 'NONE'::"IgnitionSource"
                                END,
           engine_hours_meter = NULLIF(r.payload->>'engine_hours', '')::double precision
      FROM batch b
      LEFT JOIN vehicle_telemetry_raws r ON r.telemetry_id = b.id
     WHERE t.id = b.id
  `

  const ms = Date.now() - t0
  batches++
  processed += updated

  if (updated === 0) break

  if (batches % 25 === 0 || updated < BATCH) {
    const rate = processed / Math.max(1, (Date.now() - started) / 1000)
    const left = Math.max(0, todo - processed)
    console.log(`  ${n(processed).padStart(11)} rows · batch ${batches} · ${ms} ms · ` +
                `${Math.round(rate)}/s · ~${n(left)} left`)
  }

  await sleep(PAUSE_MS)
}

// ── what it left behind ─────────────────────────────────────────────────────

const [after] = await prisma.$queryRaw<Array<{
  todo: bigint; sensor: bigint; none: bigint; meter: bigint
}>>`
  SELECT count(*) FILTER (WHERE ignition_source IS NULL)              AS todo,
         count(*) FILTER (WHERE ignition_source = 'SENSOR')           AS sensor,
         count(*) FILTER (WHERE ignition_source = 'NONE')             AS none,
         count(*) FILTER (WHERE engine_hours_meter IS NOT NULL)       AS meter
    FROM vehicle_telemetries
   WHERE captured_at >= ${cutoff}
`
const sensor = Number(after?.sensor ?? 0)
const none   = Number(after?.none ?? 0)
const seen   = sensor + none
const pct    = (x: number) => seen ? `${((x / seen) * 100).toFixed(1)}%` : '—'

console.log(`\n  processed this run  ${n(processed)} rows in ${batches} batches, ` +
            `${Math.round((Date.now() - started) / 1000)} s`)
console.log(`  still to process    ${n(after?.todo ?? 0)}`)
console.log(`\n  of the rows now marked, in the last ${DAYS} days:`)
console.log(`    ignition measured (SENSOR)  ${n(sensor).padStart(11)}  ${pct(sensor)}`)
console.log(`    no ignition       (NONE)    ${n(none).padStart(11)}  ${pct(none)}`)
console.log(`    engine-hours meter present  ${n(after?.meter ?? 0).padStart(11)}  ` +
            `${pct(Number(after?.meter ?? 0))}`)
console.log(`\n  The meter column is what the METER derivation reads next — it can now do so`)
console.log(`  without touching the 8.6 GB raws table again.\n`)

process.exit(0)
