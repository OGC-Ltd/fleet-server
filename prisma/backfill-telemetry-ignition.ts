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

/**
 * How much is left — counted with an early exit, because the obvious query is
 * a trap.
 *
 * `count(*) FILTER (WHERE ignition_source IS NULL)` over the window has to scan
 * every row in it. Measured on the live table once the pass was nearly finished:
 * **19.6 seconds**, which is past the adapter's read timeout, so the script
 * killed itself on its own progress report before touching a row. It is a
 * DISPLAY figure and it must not be able to do that.
 *
 * `LIMIT` makes it cheap in both regimes: with a lot left it stops after
 * COUNT_CAP and says "at least that many"; with little left it finds the few
 * quickly and the count is exact. Either way it stops early.
 */
const COUNT_CAP = 250_000
const [scope] = await prisma.$queryRaw<Array<{ todo: bigint }>>`
  SELECT count(*) AS todo FROM (
    SELECT 1 FROM vehicle_telemetries
     WHERE ignition_source IS NULL AND captured_at >= ${cutoff}
     LIMIT ${COUNT_CAP}
  ) x
`
const todo    = Number(scope?.todo ?? 0)
const capped  = todo >= COUNT_CAP

console.log(`\n  window            last ${DAYS} days`)
console.log(`  to process        ${capped ? `at least ${n(todo)}` : n(todo)}`)
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

/**
 * Upper bound on the next batch's ids, and the difference between this
 * finishing in an hour and not finishing at all.
 *
 * `ignition_source IS NULL` alone is CORRECT but not usable as the only
 * predicate. EXPLAIN ANALYZE on the live table, 2026-08-26:
 *
 *     Limit
 *       -> Gather Merge
 *         -> Parallel Index Scan Backward using vehicle_telemetries_pkey
 *              Filter: ((ignition_source IS NULL) AND (captured_at >= ...))
 *
 * It walks the primary key from the newest row down and FILTERS. On the first
 * batch every row it touches matches, so it costs 15 ms. On the last batch it
 * must step over every row this pass has already marked before it finds one it
 * has not — 2.3 million of them — and the whole run becomes quadratic.
 *
 * So the frontier is carried in the process instead. `IS NULL` stays in the
 * predicate, because that is what makes the pass resumable across runs and
 * idempotent on re-run; `id < cursor` is what keeps each batch O(batch). One
 * scan pays for the starting position, and after that every batch begins
 * exactly where the previous one stopped.
 *
 * ## Where this still degrades, and the fix if it ever matters
 *
 * The cursor solves a DENSE frontier — a contiguous block of unprocessed rows
 * moving downward, which is what a first pass over a window looks like. It does
 * NOT solve a SPARSE remainder. Once the window is essentially done, the only
 * unprocessed rows are the handful the live poll has inserted since the run
 * started, sitting at the very top with two million processed rows beneath them.
 * A batch then scans the whole table to find the next thousand and times out.
 *
 * Measured 2026-08-26: that is exactly what happened on the third run, with 892
 * rows left, and it is not a real failure — there was no dense work remaining to
 * find. But the script cannot tell those apart from the inside.
 *
 * The proper fix is a partial index, which this table already has a precedent
 * for (`vehicle_telemetries_moving_idx`, in its own migration because Prisma
 * cannot express one):
 *
 *     CREATE INDEX CONCURRENTLY vehicle_telemetries_unbackfilled_idx
 *       ON vehicle_telemetries (id DESC) WHERE ignition_source IS NULL;
 *
 * It costs nothing to keep, because a partial index only holds the rows still
 * matching — it shrinks to near-empty as the pass completes. Worth adding if a
 * future window has to be backfilled; not worth prod DDL for a tail that the
 * adapter is about to stop creating.
 */
let cursor: bigint
{
  const [top] = await prisma.$queryRaw<Array<{ hi: bigint | null }>>`
    SELECT max(id) AS hi FROM vehicle_telemetries
     WHERE ignition_source IS NULL AND captured_at >= ${cutoff}
  `
  if (top?.hi == null) { console.log('  Nothing to do.\n'); process.exit(0) }
  cursor = BigInt(top.hi) + 1n
}

while (batches < MAX_BATCHES) {
  const t0 = Date.now()

  // One statement: pick the batch and update it in the same query, so no id
  // list travels back and forth and no row can be claimed twice.
  //
  // LEFT JOIN, not JOIN. A telemetry row whose raw payload is missing must
  // still be marked NONE — under an inner join it would be skipped, stay NULL,
  // and be re-selected by the next batch for ever.
  const rows = await prisma.$queryRaw<Array<{ id: bigint }>>`
    WITH batch AS (
      SELECT id FROM vehicle_telemetries
       WHERE ignition_source IS NULL AND captured_at >= ${cutoff} AND id < ${cursor}
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
    RETURNING t.id
  `

  const ms = Date.now() - t0
  batches++
  const updated = rows.length
  processed += updated

  if (updated === 0) break

  // The batch was taken id-DESC, so its lowest id is the new frontier. Strictly
  // below it, so the rows just written cannot be re-selected.
  for (const r of rows) { const id = BigInt(r.id); if (id < cursor) cursor = id }

  if (batches % 25 === 0 || updated < BATCH) {
    const rate = processed / Math.max(1, (Date.now() - started) / 1000)
    // `todo` is a floor when the count was capped, so "left" would be a lie the
    // moment it hits zero. Say nothing rather than something wrong.
    const left = capped ? '' : ` · ~${n(Math.max(0, todo - processed))} left`
    console.log(`  ${n(processed).padStart(11)} rows · batch ${batches} · ${ms} ms · ` +
                `${Math.round(rate)}/s${left}`)
  }

  await sleep(PAUSE_MS)
}

// ── what it left behind ─────────────────────────────────────────────────────

console.log(`\n  processed this run  ${n(processed)} rows in ${batches} batches, ` +
            `${Math.round((Date.now() - started) / 1000)} s`)

/**
 * The coverage summary is a REPORT, and the rows are already committed. It scans
 * the whole window — about 20 seconds once the window is full — so it is the one
 * query here that can still trip a read timeout. Wrapped, because a summary that
 * fails must not make a completed pass look like a failed one. That is exactly
 * how the first resume read: the work landed, the report threw, and the stack
 * trace buried every progress line.
 */
let after: { todo: bigint; sensor: bigint; none: bigint; meter: bigint } | undefined
try {
  ;[after] = await prisma.$queryRaw<Array<{
    todo: bigint; sensor: bigint; none: bigint; meter: bigint
  }>>`
    SELECT count(*) FILTER (WHERE ignition_source IS NULL)        AS todo,
           count(*) FILTER (WHERE ignition_source = 'SENSOR')     AS sensor,
           count(*) FILTER (WHERE ignition_source = 'NONE')       AS none,
           count(*) FILTER (WHERE engine_hours_meter IS NOT NULL) AS meter
      FROM vehicle_telemetries
     WHERE captured_at >= ${cutoff}
  `
} catch (err) {
  console.log(`\n  The pass COMPLETED and its rows are written. The coverage summary`)
  console.log(`  could not be read: ${(err as Error).message}`)
  console.log(`  Re-run without --apply for the counts once the table settles.\n`)
  process.exit(0)
}

const sensor = Number(after?.sensor ?? 0)
const none   = Number(after?.none ?? 0)
const seen   = sensor + none
const pct    = (x: number) => seen ? `${((x / seen) * 100).toFixed(1)}%` : '—'

console.log(`  still to process    ${n(after?.todo ?? 0)}`)
console.log(`\n  of the rows now marked, in the last ${DAYS} days:`)
console.log(`    ignition measured (SENSOR)  ${n(sensor).padStart(11)}  ${pct(sensor)}`)
console.log(`    no ignition       (NONE)    ${n(none).padStart(11)}  ${pct(none)}`)
console.log(`    engine-hours meter present  ${n(after?.meter ?? 0).padStart(11)}  ` +
            `${pct(Number(after?.meter ?? 0))}`)
console.log(`\n  The meter column is what the METER derivation reads next — it can now do so`)
console.log(`  without touching the 8.6 GB raws table again.\n`)

process.exit(0)
