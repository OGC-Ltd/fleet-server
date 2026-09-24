/**
 * Fuel events — a BullMQ repeatable job that puts Wialon's fillings and drains
 * on the Live Feed, in-process.
 *
 * ## Why this exists rather than a cron running the CLI
 *
 * `prisma/sync-fuel-events.ts` writes the same rows perfectly well, and on the
 * production box its feed items were still invisible. The read path serves the
 * first page from the Redis cache whenever the cache holds enough items and
 * never falls through to Postgres (notification.reader), and the CLI cannot
 * write that cache — it has no Redis. Measured 2026-08-02 against the live
 * box: the same request returned 21 fuel items with `?before=` and 0 without.
 *
 * Running inside the server means `publishNotification` does all three writes
 * at once — SSE to connected dashboards, the Redis first page, and Postgres —
 * so the feed, the cache and the history cannot disagree.
 *
 * ## Why it is affordable at this cadence
 *
 * One report execution per vehicle takes seconds, and Wialon serialises calls
 * per session, so sweeping every instrumented vehicle takes tens of minutes.
 * That is a nightly batch, not a quarter-hourly one. So the job does not sweep:
 * it asks our own telemetry which tanks actually moved (findFuelCandidates) and
 * executes a report only for those. On a normal cycle that is a handful of
 * vehicles, and when nothing moved it makes no Wialon calls at all.
 *
 * The threshold is a TRIGGER, never a measurement — every volume, time and
 * place on the feed still comes from Wialon's own report.
 *
 * ## Everything here is optional
 *
 * No REDIS_URL means no queue and no job, exactly like the retention sweep.
 * The backfill CLI remains the way to populate history.
 */

import { Queue, Worker, type Job } from 'bullmq'
import { getQueueRedis } from '../redis.js'
import { env } from '../../config/env.js'
import { logger } from '../logger.js'
import { WialonClient } from '../../providers/wialon/wialon.client.js'
import {
  resolveOrgFuelSources, findFuelCandidates, listVehicleSlice, syncVehicleFuelEvents,
} from '../../modules/fuel/fuel-sync.service.js'
import { adjudicatePendingDrains } from '../../modules/fuel/fuel-adjudication.service.js'
import { adjudicateFillings } from '../../modules/fuel/fuel-filling-adjudication.service.js'

export const FUEL_QUEUE = 'fuel'
const SYNC_JOB = 'fuel:sync'

/**
 * A SEPARATE queue for adjudication, not just a separate schedule.
 *
 * The sync worker runs at concurrency 1 so two cycles cannot open two Wialon
 * sessions. A one-minute job on that queue would wait behind every slow sweep —
 * precisely the starvation the split exists to end.
 */
export const FUEL_ADJUDICATION_QUEUE = 'fuel-adjudication'
const ADJUDICATE_JOB = 'fuel:adjudicate'

/**
 * How far back each cycle looks.
 *
 * Wider than the interval on purpose. Wialon's report only recognises a
 * filling or a drain once enough settled readings follow it, so an event is
 * not visible the instant it happens; a window equal to the interval would
 * miss events that matured a few minutes late, permanently. Overlap is free —
 * the ledger dedupes on vehicle+timestamp and the feed upserts on `feedId`.
 */
const WINDOW_MS = 3 * 60 * 60_000

/**
 * How far back the CANDIDATE check looks — deliberately much shorter than the
 * report window.
 *
 * These answer different questions. "Whose tank moved recently?" wants a short
 * window, or every cycle re-asks Wialon about the same vehicles: measured on
 * the live data, a 3-hour trigger window returns 47 vehicles, and at a
 * quarter-hourly cadence that re-executes each of their reports about twelve
 * times for the same events. "What exactly happened?" wants a long one, so
 * Wialon has the settled readings either side of the event to compute it.
 *
 * Three cycles' worth, so a vehicle is still caught if one cycle is missed.
 */
const CANDIDATE_WINDOW_MS = 45 * 60_000

/**
 * Feed items are published for events inside this age. Slightly tighter than
 * the window: the extra window depth exists to catch late-maturing events, not
 * to re-announce old ones on every cycle.
 *
 * This is the SYNC path's cutoff — refuellings, which are published from a
 * window the poller has just read. Two hours is right for them and wrong for
 * an adjudicated drain: see ADJUDICATION_NOTIFY_AGE_MS.
 */
const NOTIFY_AGE_MS = 2 * 60 * 60_000

/**
 * The same gate for the ADJUDICATION pass, which needs a far longer reach.
 *
 * ## Why one constant could not serve both
 *
 * The two paths publish on completely different clocks. The sync publishes an
 * event the poller has just read from the provider, so it is always minutes
 * old. Adjudication publishes only after a drain has settled and been JUDGED,
 * and measured over the live ledger on 2026-08-19 that takes a mean of 8.9
 * hours — four times the cutoff it was being held to.
 *
 * The result was silent and total for the slow cases. Every announceable drain
 * judged inside two hours reached the feed; every one that took longer was
 * dropped without a trace:
 *
 *     lag 0.5, 0.5, 0.6, 0.6, 0.8, 0.8, 0.9, 0.9 h   all published
 *     lag 3.0, 3.0, 3.7, 8.4 h                       none published
 *
 * `MUFINDI - DG 13` is what that costs. Two findings on the same generator
 * three hours apart, 337.9 L between them, both judged, both sitting red on the
 * dashboard, and neither ever announced.
 *
 * ## Why 24 h and not simply "no cutoff"
 *
 * The guard is still needed and its reason has not changed: the ledger holds 30
 * days, and a first run over a backlog would replay all of it onto a feed that
 * is meant to show what is happening now. Twenty-four hours matches
 * SETTLE_SPAN_MS, so the reach of the announcement matches the reach of the
 * pass that produces it, and nothing older than a day can ever arrive.
 *
 * Measured over 30 days: 13 announceable drains published under the 2 h rule,
 * 5 more are recovered by this, and 6 were judged more than 24 h after they
 * began and are still dropped. Those six are the honest cost of keeping the
 * backlog guard, and a fuel finding two days late is worth little anyway.
 *
 * Deliberately NOT applied to the sync path. Widening that one too would have
 * published 23 refuellings from the last 24 hours in a single cycle — the exact
 * flood this guard exists to prevent.
 */
const ADJUDICATION_NOTIFY_AGE_MS = 24 * 60 * 60_000

/** A tank whose level moved less than this cannot have been filled or drained. */
const CANDIDATE_THRESHOLD_ML = 15_000

/** Stop one cycle running away — a bad window should not hold the session for hours. */
const MAX_CANDIDATES_PER_CYCLE = 60

/**
 * Warn when a cycle takes longer than the interval it is scheduled on.
 *
 * The default cadence is quarter-hourly; a cycle that exceeds it means the next
 * tick is already queued behind this one. Hardcoded against the DEFAULT rather
 * than parsed out of FUEL_SYNC_CRON — a cron expression does not reduce to a
 * single interval, and being approximately right about "this is too slow" is
 * all the threshold needs to be.
 */
const CYCLE_OVERRUN_WARN_MS = 15 * 60_000

// ─── the settle pass ───────────────────────────────────────────────────────
//
// The live pass above only ever inserts and updates, and it only ever looks at
// vehicles whose own telemetry moved. Two things escape it, both measured on
// the live account:
//
//   · RETRACTIONS. Wialon offers an event, then a wider settled read no longer
//     considers it one. Eight of MUFINDI: DZ 04's 29 stored drains for
//     2026-08-03 had no counterpart in the provider's settled answer.
//   · SPARSE REPORTERS. A vehicle sending one fuel reading a day has a zero
//     spread and never becomes a candidate, so its events are never fetched at
//     all — MUFINDI: 009's 957.9 L drain, never recorded.
//
// So a slice of vehicles is re-read every cycle over a window that has finished
// maturing, with `reconcile` on, until the rotation comes round again. This is
// the pass that makes the ledger EQUAL the provider rather than merely overlap
// it. Cost is bounded by the slice size, not by fleet size.

/** Youngest event the settle pass will touch. Below this, a window is still moving. */
const SETTLE_MIN_AGE_MS = 6 * 60 * 60_000

/** How much history each settle read covers, ending at the maturity horizon. */
const SETTLE_SPAN_MS = 24 * 60 * 60_000

export interface FuelSyncResult {
  candidates: number
  fillings:   number
  thefts:     number
  published:  number
  /** Re-offered events suppressed as exact republishes — see SyncOutcome. */
  deduped:    number
  /** Ledger rows rewritten because the provider revised the event. */
  corrected:  number
  /** Vehicles re-read by the settle pass this cycle. */
  settled:    number
  /** Ledger rows deleted because the provider has retracted them. */
  removed:    number
  // (The verdict counters lived here until 2026-09-24. They moved to
  // FuelAdjudicationResult with the pass itself — a field this cycle can no
  // longer compute must not stay on its result reading zero.)
  failed:     number
  /** Wall clock, so an overrunning cycle is visible rather than inferred. */
  ms:         number
}

/**
 * Consecutive cycles in which the adjudication pass has thrown.
 *
 * Module state rather than a database column because the question it answers —
 * "is the detector down RIGHT NOW" — is about this process, and a restart
 * genuinely does reset it: the first cycle after a restart re-establishes
 * whether the fault is still there.
 */
let adjudicationFailStreak = 0

/**
 * How many consecutive failures stop being a blip and become an outage.
 *
 * The cycle is quarter-hourly, so three is roughly forty-five minutes. Chosen
 * against a real incident: on 2026-08-17 the pass failed 110 times across about
 * ten hours while every cycle-complete line looked ordinary, and nothing in the
 * logs ever said the failures were CONSECUTIVE. One timeout against a 1 GB RDS
 * is background noise; three in a row is the fuel detector being off.
 */
const ADJUDICATION_OUTAGE_STREAK = 3

/** Run one cycle. Exported so it can be invoked by hand or from a test. */
export async function runFuelSync(): Promise<FuelSyncResult> {
  const startedAt = Date.now()
  const result: FuelSyncResult = {
    candidates: 0, fillings: 0, thefts: 0, published: 0, deduped: 0,
    corrected: 0, settled: 0, removed: 0,
    failed: 0, ms: 0,
  }

  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  if (!token) {
    logger.warn('Fuel sync: no WIALON_TOKEN — skipping cycle')
    return result
  }

  const to     = new Date()
  const from   = new Date(to.getTime() - WINDOW_MS)
  const cutoff = new Date(to.getTime() - NOTIFY_AGE_MS)

  const client = new WialonClient(token, env.WIALON_API_URL)

  try {
    const sources = await resolveOrgFuelSources(client)

    for (const source of sources) {
      const candidates = await findFuelCandidates(
        source.orgId,
        new Date(to.getTime() - CANDIDATE_WINDOW_MS),
        CANDIDATE_THRESHOLD_ML,
      )
      result.candidates += candidates.length

      if (candidates.length > MAX_CANDIDATES_PER_CYCLE) {
        logger.warn(
          { org: source.code, candidates: candidates.length, cap: MAX_CANDIDATES_PER_CYCLE },
          'Fuel sync: more candidates than one cycle will process — the rest are picked up next cycle',
        )
      }

      for (const vehicle of candidates.slice(0, MAX_CANDIDATES_PER_CYCLE)) {
        try {
          const out = await syncVehicleFuelEvents(client, source, vehicle, {
            from, to, apply: true, notify: true, notifyCutoff: cutoff,
          })
          result.fillings  += out.fillings
          result.thefts    += out.thefts
          result.published += out.published
          result.deduped   += out.deduped
          result.corrected += out.corrected
        } catch (err) {
          // One unit's report failing must not abandon the rest of the cycle.
          result.failed++
          logger.warn({ err, plate: vehicle.registrationPlate }, 'Fuel sync: report failed for vehicle')
        }
      }

      // ── settle pass ──
      // Runs inside the same cycle rather than on a queue of its own: both
      // passes drive one Wialon session, and Wialon rejects concurrent calls on
      // a session (error 1003). Sequential here is the only safe arrangement,
      // and it also means the `running` guard already covers both.
      if (env.FUEL_SETTLE_ENABLED && env.FUEL_SETTLE_BATCH > 0) {
        const settleTo   = new Date(to.getTime() - SETTLE_MIN_AGE_MS)
        const settleFrom = new Date(settleTo.getTime() - SETTLE_SPAN_MS)
        // Rotation position from the clock, so it survives restarts and needs
        // no cursor: consecutive cycles read consecutive slices.
        const slice = Math.floor(startedAt / 60_000 / 15)
        const batch = await listVehicleSlice(source.orgId, slice, env.FUEL_SETTLE_BATCH)

        for (const vehicle of batch) {
          try {
            const out = await syncVehicleFuelEvents(client, source, vehicle, {
              from: settleFrom, to: settleTo,
              apply: true,
              // Never: these events are hours old, and the live pass already
              // announced them when they were news.
              notify: false,
              reconcile: true,
            })
            result.settled++
            result.fillings  += out.fillings
            result.thefts    += out.thefts
            result.corrected += out.corrected
            result.removed   += out.removed
          } catch (err) {
            result.failed++
            logger.warn({ err, plate: vehicle.registrationPlate }, 'Fuel settle: report failed for vehicle')
          }
        }
      }
    }
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }

  // (The adjudication pass used to run here, at the tail of this cycle. It was
  // moved to its own queue on 2026-09-24 — see `runAdjudication` below. It
  // touches only our own database, so sharing a quarter-hourly Wialon cadence
  // cost up to fifteen minutes of dead wait before a ripe drain was judged.)

  result.ms = Date.now() - startedAt

  // A quiet cycle is logged at debug, which production never emits. The
  // equivalent guard for a DEAD detector now lives on the adjudication pass,
  // which owns that failure since the split.
  const log = result.published > 0 || result.fillings > 0 || result.thefts > 0
           || result.corrected > 0 || result.removed > 0
    ? logger.info.bind(logger)
    : logger.debug.bind(logger)
  log(result, 'Fuel sync cycle complete')

  // A cycle that outlasts its own interval means the next tick is already
  // waiting, and BullMQ will run it the moment this one lands — which turns a
  // slow Wialon session into back-to-back cycles rather than a paused one.
  // Nothing here can fix that; it just must not be silent.
  if (result.ms > CYCLE_OVERRUN_WARN_MS) {
    logger.warn({ ms: result.ms, candidates: result.candidates, cron: env.FUEL_SYNC_CRON },
      'Fuel sync cycle overran its interval — the next tick was already due')
  }

  return result
}


// ─── the adjudication pass, on its own clock ───────────────────────────────

/**
 * Judge the fillings and drains whose evidence has matured.
 *
 * ## Why this is not part of the sync cycle any more
 *
 * It sat at the tail of `runFuelSync` until 2026-09-24, and so inherited
 * `FUEL_SYNC_CRON` — a quarter-hourly cadence chosen for a completely different
 * reason, namely that executing Wialon reports for 460 vehicles is expensive and
 * the provider should not be asked more often.
 *
 * This pass asks Wialon nothing. It reads rows we already hold and writes
 * verdicts, and the comment it used to live under said so: "it touches only our
 * own database". Sharing that cadence cost up to fifteen minutes of dead wait
 * between a drain becoming ripe and anything looking at it — on top of
 * SETTLE_MINUTES, and for no reason at all.
 *
 * A drain detected at 14:48 ripened at 15:08 and was judged at 15:15. The
 * fifteen minutes in the middle is what this removes.
 *
 * ## Its own queue, not just its own schedule
 *
 * The sync worker runs at concurrency 1 so two cycles cannot open two Wialon
 * sessions. Putting a one-minute job on that queue would have it wait behind
 * every slow sweep — exactly the starvation this is meant to end. A separate
 * queue gives the two independent workers.
 */
export interface FuelAdjudicationResult {
  fillingsJudged:  number
  fillingsPhantom: number
  adjudicated:     number
  redistributed:   number
  published:       number
  adjudicationFailed: boolean
  adjudicationFailStreak: number
  ms: number
}

export async function runAdjudication(): Promise<FuelAdjudicationResult> {
  const startedAt = Date.now()
  const out: FuelAdjudicationResult = {
    fillingsJudged: 0, fillingsPhantom: 0,
    adjudicated: 0, redistributed: 0, published: 0,
    adjudicationFailed: false, adjudicationFailStreak: 0, ms: 0,
  }
  const to = new Date()

// ── adjudication pass ──
// Judge the drains whose settle window has elapsed, and put the survivors on
// the feed. Deliberately AFTER the Wialon session is closed: it touches only
// our own database, so it must not hold a provider session open, and it must
// still run on a cycle where every report failed.
  // ── fillings first, and the ORDER is the whole point ──
  //
  // `adjudicateDrain` takes a filling in its window as real and cuts the
  // recovery window at it, excluding only fillings already judged
  // REDISTRIBUTION (see the `verdict: { not: 'REDISTRIBUTION' }` filter in
  // fuel-adjudication.service). A PENDING filling still counts, deliberately:
  // unjudged is not disproved.
  //
  // That was safe only if fillings were judged at least as often as drains,
  // and they were not. Drains run on FUEL_SYNC_CRON (quarter-hourly); the
  // filling sweep was a daily repeatable at 04:05 on the maintenance queue.
  // So a filling recorded at 10:00 stayed PENDING for eighteen hours, and
  // every drain judged in between had its evidence cut short by a "delivery"
  // nobody had checked — on an oscillating probe, by the up-swing of the very
  // noise the drain was. That manufactures DRAIN verdicts out of undulation,
  // which is the one failure this module exists to prevent.
  //
  // retention.ts already said so — "judging fillings first is what stops a
  // phantom one truncating a drain's evidence" — while scheduling the two
  // 288 cycles apart. This puts them on one clock, in that order.
  //
  // Ripeness is unchanged: FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES = 60, so a
  // filling becomes judgeable an hour after the pump stops. Running quarter-
  // hourly does not judge anything sooner than its own evidence allows; it
  // just stops the verdict waiting until morning for a cycle to come round.
  try {
    const fills = await adjudicateFillings({ apply: true })
    // Rows that actually got a verdict this cycle: not the ones still inside
    // their hold window, and not the ones the re-judge guard left alone.
    out.fillingsJudged = fills.examined - fills.stillPending - fills.kept
    out.fillingsPhantom = fills.redistribution
  } catch (err) {
    // Not fatal to the cycle. Drains are still judged below — exactly as they
    // were when this pass ran once a day — because judging them against a
    // stale filling ledger is what happens today and is better than judging
    // nothing. But it is logged at ERROR, because every drain in this cycle
    // is now reading fillings this pass failed to refresh.
    logger.error({ err },
      'Fuel filling adjudication failed — drains this cycle may be truncated by unjudged fillings')
  }

  try {
    // The same KIND of age gate the sync uses — a backlog being worked
    // through must not narrate weeks of history onto the live feed — but a
    // much longer one, because a judged drain is hours old by construction.
    const verdicts = await adjudicatePendingDrains({
      apply: true, notify: true,
      // NOT `cutoff` — that is the sync's two-hour reach, and adjudication
      // takes a mean of 8.9 h to reach a verdict. See the constant.
      notifyCutoff: new Date(to.getTime() - ADJUDICATION_NOTIFY_AGE_MS),
    })
    out.adjudicated   = verdicts.examined
    out.redistributed = verdicts.redistribution
    out.published    += verdicts.published
    // It ran. Whatever was wrong before is not wrong now.
    adjudicationFailStreak = 0
  } catch (err) {
    // ERROR, not warn. This is the fuel detector not running, and it used to
    // be reported at the same level as a single vehicle's report failing —
    // which is how ten hours of it went unnoticed.
    adjudicationFailStreak += 1
    out.adjudicationFailed = true
    out.adjudicationFailStreak = adjudicationFailStreak
    logger.error(
      { err, streak: adjudicationFailStreak },
      'Fuel adjudication pass failed — no drains were judged this cycle',
    )
    // A streak is a different event from a failure, and it is the one worth
    // waking somebody for: nothing has been judged for the best part of an
    // hour, so no fuel finding can reach the feed no matter what the machines
    // are doing.
    if (adjudicationFailStreak >= ADJUDICATION_OUTAGE_STREAK) {
      logger.error(
        { streak: adjudicationFailStreak, cron: env.FUEL_SYNC_CRON },
        'FUEL DETECTOR DOWN — adjudication has failed every cycle in a row; nothing is being judged',
      )
    }
  }

  out.ms = Date.now() - startedAt
  const log = out.adjudicationFailed || out.published > 0 || out.adjudicated > 0 || out.fillingsJudged > 0
    ? logger.info.bind(logger) : logger.debug.bind(logger)
  log(out, 'Fuel adjudication cycle complete')
  return out
}

// ─── queue wiring ──────────────────────────────────────────────────────────

let queue:  Queue  | null = null
let worker: Worker | null = null
/** One cycle at a time — see the worker handler. */
let running = false

export interface FuelSyncHandle {
  stop: () => Promise<void>
}

let adjQueue:  Queue  | null = null
let adjWorker: Worker | null = null
/** One adjudication at a time — a tick that overruns must not stack. */
let adjudicating = false

/**
 * Schedule the verdict pass on its own clock.
 *
 * Independent of `startFuelSync` in every way that matters: its own queue, its
 * own worker, its own cadence, and no Wialon session. It is still gated by
 * FUEL_ADJUDICATION_ENABLED, which now means what it says rather than "and only
 * when the sync happens to run".
 */
export async function startFuelAdjudication(): Promise<FuelSyncHandle> {
  const noop: FuelSyncHandle = { stop: async () => {} }

  if (!env.FUEL_ADJUDICATION_ENABLED) {
    logger.warn('FUEL_ADJUDICATION_ENABLED=false — no drain or filling will be judged')
    return noop
  }
  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — fuel adjudication NOT scheduled; run `npm run fuel:adjudicate` by hand')
    return noop
  }

  adjQueue = new Queue(FUEL_ADJUDICATION_QUEUE, { connection })
  // Same reason as the sync queue: a changed cadence must not leave the old
  // scheduler firing alongside the new one.
  for (const r of await adjQueue.getRepeatableJobs()) {
    if (r.name === ADJUDICATE_JOB) await adjQueue.removeRepeatableByKey(r.key)
  }

  await adjQueue.add(ADJUDICATE_JOB, {}, {
    repeat:           { pattern: env.FUEL_ADJUDICATION_CRON },
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 50 },
    // One attempt: the next tick is a minute away and its query is the same.
    attempts:         1,
  })

  adjWorker = new Worker(FUEL_ADJUDICATION_QUEUE, async (job: Job) => {
    if (job.name !== ADJUDICATE_JOB) return
    if (adjudicating) {
      logger.warn({ jobId: job.id }, 'Fuel adjudication: previous pass still running — skipping this tick')
      return
    }
    adjudicating = true
    try { return await runAdjudication() } finally { adjudicating = false }
  }, { connection, concurrency: 1 })

  adjWorker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id }, 'Fuel adjudication job failed'))

  logger.info(
    { queue: FUEL_ADJUDICATION_QUEUE, cron: env.FUEL_ADJUDICATION_CRON },
    'Fuel adjudication scheduled',
  )

  return {
    async stop() {
      await adjWorker?.close()
      await adjQueue?.close()
      adjWorker = null
      adjQueue = null
    },
  }
}

export async function startFuelSync(): Promise<FuelSyncHandle> {
  const noop: FuelSyncHandle = { stop: async () => {} }

  if (!env.FUEL_SYNC_ENABLED) {
    logger.warn('FUEL_SYNC_ENABLED=false — fuel event sync NOT started')
    return noop
  }

  const connection = getQueueRedis()
  if (!connection) {
    logger.warn('No REDIS_URL — fuel event sync NOT started; fillings and drains reach the feed only via `npm run sync:fuel`')
    return noop
  }

  queue = new Queue(FUEL_QUEUE, { connection })

  // Repeatable jobs accumulate in Redis when their schedule changes, so old
  // schedulers are cleared first — otherwise changing the cadence leaves the
  // previous one firing forever alongside the new one.
  for (const r of await queue.getRepeatableJobs()) {
    if (r.name === SYNC_JOB) await queue.removeRepeatableByKey(r.key)
  }

  await queue.add(SYNC_JOB, {}, {
    repeat:           { pattern: env.FUEL_SYNC_CRON },
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 50 },
    // Deliberately few: a failed cycle is not worth hammering Wialon over,
    // because the next cycle's window overlaps and will pick the events up.
    attempts:         2,
    backoff:          { type: 'exponential', delay: 60_000 },
  })

  worker = new Worker(FUEL_QUEUE, async (job: Job) => {
    if (job.name !== SYNC_JOB) return
    // Concurrency 1 stops two cycles running at once, but it does not stop
    // ticks QUEUEING behind a slow one: a cycle that overran by an hour would
    // land, then immediately run the four ticks that piled up behind it, each
    // re-executing the same reports over an overlapping window. Skip instead —
    // the next scheduled tick's window covers anything this one missed.
    if (running) {
      logger.warn({ jobId: job.id }, 'Fuel sync: previous cycle still running — skipping this tick')
      return
    }
    running = true
    try { return await runFuelSync() } finally { running = false }
  }, {
    connection,
    // Strictly one at a time: two concurrent cycles would open two Wialon
    // sessions and duplicate every report execution for no benefit.
    concurrency: 1,
  })

  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id }, 'Fuel sync job failed'))

  logger.info({ queue: FUEL_QUEUE, cron: env.FUEL_SYNC_CRON, windowMs: WINDOW_MS }, 'Fuel event sync scheduled')

  return {
    async stop() {
      await worker?.close()
      await queue?.close()
      worker = null
      queue  = null
    },
  }
}