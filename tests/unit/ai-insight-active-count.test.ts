/**
 * What "N/M active" on the Fleet AI Insight card actually counts.
 *
 * The snapshot takes each vehicle's newest ping with no recency bound, so
 * `engine_on` is whatever its last-ever frame said. Measured on SUKARI
 * (2026-08-05) the headline read "54/597 active" while only 20 of those 54 had
 * reported within the hour — nineteen had been silent over a week, and the
 * oldest had been stuck "active" for 566 days. Meanwhile 317 of the 597 had
 * never sent a byte, so they sat permanently in the denominator.
 *
 * Both ends are now bounded: running means heard from inside STALE_FIX_MS, and
 * the ratio is taken over the fleet that reports at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { collectLiveState } from '../../src/modules/dashboard/ai-insight.js'
import { STALE_FIX_MS } from '../../src/lib/movement-state.js'

const NOW = new Date('2026-08-05T09:00:00Z')
const agoMs = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

/** A vehicle: engine flag, and how long ago it last reported (null = never). */
const unit = (engineOn: boolean, reportedAgoMs: number | null) => ({
  engineOn,
  capturedAt: reportedAgoMs == null ? null : agoMs(reportedAgoMs),
})

describe('collectLiveState — the active ratio', () => {
  beforeEach(() => vi.setSystemTime(NOW))
  afterEach(() => vi.useRealTimers())

  it('counts a unit running only if it has been heard from within the hour', () => {
    const live = collectLiveState([
      unit(true, 5 * 60_000),              // 5 min ago — running
      unit(true, 59 * 60_000),             // 59 min ago — still running
      unit(true, STALE_FIX_MS + 60_000),   // just over the line — not running
      unit(true, 8 * 86_400_000),          // silent 8 days — not running
      unit(true, 566 * 86_400_000),        // the 566-day unit — not running
    ] as never)

    expect(live.enginesOn).toBe(2)
    expect(live.engineOnButStale).toBe(3)
  })

  it('takes the ratio over the fleet that reports, not the whole registry', () => {
    const live = collectLiveState([
      unit(true,  5 * 60_000),
      unit(false, 5 * 60_000),
      unit(false, 30 * 86_400_000),
      unit(false, null),                   // provisioned, never reported
      unit(false, null),
    ] as never)

    expect(live.vehicles).toBe(5)          // registry — kept for context only
    expect(live.reporting).toBe(3)         // the denominator
    expect(live.noTelemetryEver).toBe(2)
    expect(live.enginesOn).toBe(1)         // the numerator
  })

  it('never counts a vehicle that has never reported as running', () => {
    // engineOn true with no ping at all cannot happen through the snapshot, but
    // the guard is on the freshness check rather than on that assumption.
    const live = collectLiveState([unit(true, null)] as never)
    expect(live.enginesOn).toBe(0)
    expect(live.reporting).toBe(0)
  })

  it('reproduces the measured SUKARI shape: 54/597 becomes 20/280', () => {
    const fleet = [
      ...Array.from({ length: 20 }, () => unit(true, 30 * 60_000)),   // running
      ...Array.from({ length: 34 }, () => unit(true, 8 * 86_400_000)),// stale engine flag
      ...Array.from({ length: 226 }, () => unit(false, 2 * 86_400_000)),
      ...Array.from({ length: 317 }, () => unit(false, null)),        // no telemetry ever
    ]
    const live = collectLiveState(fleet as never)

    expect(live.vehicles).toBe(597)
    expect(live.reporting).toBe(280)
    expect(live.enginesOn).toBe(20)
    expect(live.engineOnButStale).toBe(34)
  })
})
