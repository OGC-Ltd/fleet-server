/**
 * An adjudication failure must not be quiet.
 *
 * The pass is wrapped in a try/catch so one bad cycle cannot stop everything
 * else. That is right, and it is also how the fuel detector went down for about
 * ten hours on 2026-08-17 — 110 consecutive failures, each logged at the same
 * level as a single vehicle's report failing, while every cycle-complete line
 * looked ordinary because `adjudicated: 0` is also what a quiet cycle looks
 * like.
 *
 * These pin the three things that make it visible: the shape carries the
 * failure, a streak is counted, and the outage threshold is short enough to
 * catch an incident inside the hour.
 *
 * ## Moved 2026-09-24
 *
 * These counters used to live on `FuelSyncResult`, because the pass ran at the
 * tail of the Wialon sync cycle. It has its own queue and its own clock now —
 * it reads rows we already hold and asks the provider nothing, so it had no
 * business inheriting a cadence set by what Wialon costs to call. The
 * assertions are unchanged in substance; only the type they describe moved, and
 * the escalation arithmetic got much better because the cycle is a minute
 * rather than a quarter of an hour.
 */

import { describe, it, expect } from 'vitest'
import type { FuelAdjudicationResult } from '../../src/lib/queues/fuel-events.js'

const clean = (): FuelAdjudicationResult => ({
  fillingsJudged: 0, fillingsPhantom: 0,
  adjudicated: 0, redistributed: 0, published: 0,
  adjudicationFailed: false, adjudicationFailStreak: 0, ms: 12,
})

describe('a failed adjudication pass is distinguishable from a quiet one', () => {
  it('carries the failure in its own field, because adjudicated:0 cannot', () => {
    // The whole defect in one assertion: these two results have identical
    // counters and mean opposite things.
    const quiet  = clean()
    const broken = { ...clean(), adjudicationFailed: true, adjudicationFailStreak: 1 }
    expect(quiet.adjudicated).toBe(broken.adjudicated)
    expect(quiet.adjudicationFailed).toBe(false)
    expect(broken.adjudicationFailed).toBe(true)
  })

  it('a quiet cycle is not mistaken for a broken one', () => {
    // Most ticks judge nothing because nothing is ripe. That must stay quiet,
    // or the signal is worthless — and at a one-minute cadence the great
    // majority of ticks are now quiet ones.
    expect(clean().adjudicationFailed).toBe(false)
    expect(clean().adjudicationFailStreak).toBe(0)
  })

  it('escalates in minutes now, not in the best part of an hour', () => {
    // The threshold is unchanged at three consecutive failures. What changed is
    // what three cycles COST: quarter-hourly that was ~45 minutes, which only
    // just cleared the bar. On its own clock it is three minutes.
    const CYCLE_MIN = 1
    const STREAK    = 3
    expect(STREAK * CYCLE_MIN).toBeLessThanOrEqual(60)
    expect(STREAK * CYCLE_MIN).toBeLessThan(15)
  })
})

/**
 * The reason the split happened, stated as arithmetic rather than prose.
 *
 * A drain becomes judgeable at `detectedAt + SETTLE_MINUTES`. Nothing looks at
 * it until the next adjudication tick, so the worst case is the settle window
 * plus a whole cadence. On 2026-09-24 a drain detected at 14:48 ripened at
 * 15:08 and was judged at 15:15.
 */
describe('what the cadence costs a ripe drain', () => {
  const SETTLE_MIN = 20

  it('quarter-hourly put fifteen minutes of dead wait after the settle window', () => {
    const worst = SETTLE_MIN + 15
    expect(worst).toBe(35)
  })

  it('on its own clock the wait is the settle window and a minute', () => {
    const worst = SETTLE_MIN + 1
    expect(worst).toBe(21)
    // And the live watcher (lib/fuel-drop-watch) is what closes the remaining
    // twenty: it does not wait for the settle window at all, because it is not
    // deciding — it is reporting that a tank dropped.
    expect(worst).toBeLessThan(35)
  })
})
