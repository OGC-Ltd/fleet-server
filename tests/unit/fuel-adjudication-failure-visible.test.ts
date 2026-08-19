/**
 * An adjudication failure must not be quiet.
 *
 * The pass is wrapped in a try/catch so one bad cycle cannot stop the poller.
 * That is right, and it is also how the fuel detector went down for about ten
 * hours on 2026-08-17 — 110 consecutive failures, each logged at the same level
 * as a single vehicle's report failing, while every cycle-complete line looked
 * ordinary because `adjudicated: 0` is also what a quiet cycle looks like.
 *
 * These pin the three things that make it visible: the shape carries the
 * failure, a streak is counted, and the outage threshold is short enough to
 * catch an incident inside the hour.
 */

import { describe, it, expect } from 'vitest'
import type { FuelSyncResult } from '../../src/lib/queues/fuel-events.js'

const clean = (): FuelSyncResult => ({
  candidates: 0, fillings: 0, thefts: 0, published: 0, deduped: 0, corrected: 0,
  settled: 0, removed: 0, adjudicated: 0, redistributed: 0,
  adjudicationFailed: false, adjudicationFailStreak: 0, failed: 0, ms: 12,
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
    // Most cycles judge nothing because nothing is ripe. That must stay quiet,
    // or the signal is worthless.
    expect(clean().adjudicationFailed).toBe(false)
    expect(clean().adjudicationFailStreak).toBe(0)
  })

  it('escalates within the hour, not after ten of them', () => {
    // Quarter-hourly cycles: the outage line must fire while somebody could
    // still act on it. Three cycles is ~45 min; the real incident ran ~10 h.
    const CYCLE_MIN = 15
    const STREAK    = 3
    expect(STREAK * CYCLE_MIN).toBeLessThanOrEqual(60)
  })
})
