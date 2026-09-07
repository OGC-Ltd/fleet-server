/**
 * Overspeeding episodes.
 *
 * The thing worth pinning is that the LEDGER and the FEED must count the same
 * events. `deriveAlertFlags` raises the flag only after OVERSPEED_MIN_FRAMES
 * consecutive frames, so an episode shorter than that raised no alert and must
 * not be written — otherwise a report shows incidents nobody was ever told
 * about, and the two numbers can never be reconciled.
 *
 * The second is that every timestamp is an OBSERVED fix. `startedAt` is the
 * first over-limit frame (not the third, which is only when we became
 * confident); `endedAt` is the last one (never "now"). Both ends being real
 * fixes is what makes durationSec a lower bound rather than a guess.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/event-bus.js', () => ({
  eventBus: { publish: vi.fn(), subscribe: vi.fn() },
}))

const { env } = await import('../../src/config/env.js')
env.INCIDENT_CAPTURE_ENABLED = true

const { eventBus } = await import('../../src/lib/event-bus.js')
const {
  noteSpeedFrame, sweepStaleEpisodes, flushEpisodes, resetEpisodeState, openEpisodeCount,
} = await import('../../src/lib/speeding-episodes.js')

const T0 = Date.UTC(2026, 8, 7, 6, 0, 0)
const ctx = {
  orgId: 'org1', vehicleId: 'veh1', vehicleType: 'TRUCK',
  driverId: 'drv1', driverName: 'Jared Moi',
}

/** A frame carrying just what the episode tracker reads. */
const frame = (speedKmh: number | null, atMs: number, lat: number | null = -0.82, lng: number | null = 34.38) =>
  ({ speedKmh, capturedAt: new Date(atMs), lat, lng } as never)

const SEC = 1000

beforeEach(() => {
  resetEpisodeState()
  vi.mocked(eventBus.publish).mockClear()
})

describe('an episode shorter than the debounce is not an incident', () => {
  it('writes nothing for two over-limit frames when the flag needs three', () => {
    noteSpeedFrame(frame(95, T0), ctx)
    noteSpeedFrame(frame(97, T0 + 30 * SEC), ctx)
    const closed = noteSpeedFrame(frame(40, T0 + 60 * SEC), ctx)

    expect(closed).toBeNull()
    expect(eventBus.publish).not.toHaveBeenCalled()
  })

  it('writes exactly one row once the run is long enough', () => {
    noteSpeedFrame(frame(95, T0), ctx)
    noteSpeedFrame(frame(110, T0 + 30 * SEC), ctx)
    noteSpeedFrame(frame(100, T0 + 60 * SEC), ctx)
    const closed = noteSpeedFrame(frame(40, T0 + 90 * SEC), ctx)

    expect(closed).not.toBeNull()
    expect(eventBus.publish).toHaveBeenCalledTimes(1)
    expect(closed!.frames).toBe(3)
    expect(closed!.peakKmh).toBe(110)
    // The FIRST over-limit frame, not the third.
    expect(closed!.startedAt.getTime()).toBe(T0)
    // The LAST over-limit frame, not the one that ended it.
    expect(closed!.endedAt.getTime()).toBe(T0 + 60 * SEC)
    expect(closed!.durationSec).toBe(60)
    expect(closed!.closedBy).toBe('falling-edge')
  })
})

describe('what the row says', () => {
  it('records the limit broken and how far over the peak went', () => {
    for (let i = 0; i < 3; i++) noteSpeedFrame(frame(92, T0 + i * 30 * SEC), ctx)
    const closed = noteSpeedFrame(frame(10, T0 + 200 * SEC), ctx)!

    expect(closed.limitKmh).toBe(80)
    expect(closed.limitSource).toBe('fleet')
    expect(closed.overByKmh).toBe(12)
    expect(closed.avgKmh).toBe(92)
  })

  it('measures distance along the over-limit fixes', () => {
    // ~0.01° of latitude ≈ 1.11 km, three fixes ≈ 2.2 km.
    noteSpeedFrame(frame(95, T0, -0.80, 34.38), ctx)
    noteSpeedFrame(frame(95, T0 + 30 * SEC, -0.81, 34.38), ctx)
    noteSpeedFrame(frame(95, T0 + 60 * SEC, -0.82, 34.38), ctx)
    const closed = noteSpeedFrame(frame(10, T0 + 90 * SEC), ctx)!

    expect(closed.distanceM).toBeGreaterThan(2000)
    expect(closed.distanceM).toBeLessThan(2400)
    expect(closed.gapped).toBe(false)
  })

  it('refuses to invent a distance across a fix with no coordinates', () => {
    noteSpeedFrame(frame(95, T0), ctx)
    noteSpeedFrame(frame(95, T0 + 30 * SEC, null, null), ctx)
    noteSpeedFrame(frame(95, T0 + 60 * SEC), ctx)
    const closed = noteSpeedFrame(frame(10, T0 + 90 * SEC), ctx)!

    // Null renders as "—". A plausible number would be a lie.
    expect(closed.distanceM).toBeNull()
    expect(closed.gapped).toBe(true)
  })

  it('refuses to invent a distance across a long silence', () => {
    noteSpeedFrame(frame(95, T0), ctx)
    noteSpeedFrame(frame(95, T0 + 30 * SEC), ctx)
    // Twenty minutes later, still speeding — the ground covered is unknowable.
    noteSpeedFrame(frame(95, T0 + 20 * 60 * SEC), ctx)
    const closed = noteSpeedFrame(frame(10, T0 + 21 * 60 * SEC), ctx)!

    expect(closed.distanceM).toBeNull()
    expect(closed.gapped).toBe(true)
  })
})

describe('a frame with no speed decides nothing', () => {
  it('neither extends nor ends an open episode', () => {
    noteSpeedFrame(frame(95, T0), ctx)
    noteSpeedFrame(frame(95, T0 + 30 * SEC), ctx)
    const onNull = noteSpeedFrame(frame(null, T0 + 45 * SEC), ctx)
    expect(onNull).toBeNull()
    expect(openEpisodeCount()).toBe(1)

    noteSpeedFrame(frame(95, T0 + 60 * SEC), ctx)
    const closed = noteSpeedFrame(frame(10, T0 + 90 * SEC), ctx)!
    // The null frame was not counted as evidence of speeding.
    expect(closed.frames).toBe(3)
  })
})

describe('an episode that never ends normally', () => {
  it('is closed by the stale sweep at its last over-limit frame', () => {
    for (let i = 0; i < 3; i++) noteSpeedFrame(frame(95, T0 + i * 30 * SEC), ctx)
    expect(openEpisodeCount()).toBe(1)

    // Eleven minutes of silence, past EPISODE_MAX_GAP_MS.
    const closed = sweepStaleEpisodes(T0 + 60 * SEC + 11 * 60 * SEC)
    expect(closed).toHaveLength(1)
    expect(closed[0]!.closedBy).toBe('timeout')
    // Ends where the evidence ends, not where the sweep ran.
    expect(closed[0]!.endedAt.getTime()).toBe(T0 + 60 * SEC)
    expect(openEpisodeCount()).toBe(0)
  })

  it('is left alone while the unit is merely between fixes', () => {
    for (let i = 0; i < 3; i++) noteSpeedFrame(frame(95, T0 + i * 30 * SEC), ctx)
    expect(sweepStaleEpisodes(T0 + 60 * SEC + 60 * SEC)).toHaveLength(0)
    expect(openEpisodeCount()).toBe(1)
  })

  it('is closed by shutdown at its last over-limit frame, never at "now"', () => {
    for (let i = 0; i < 3; i++) noteSpeedFrame(frame(95, T0 + i * 30 * SEC), ctx)
    const closed = flushEpisodes()

    expect(closed).toHaveLength(1)
    expect(closed[0]!.closedBy).toBe('shutdown')
    // Claiming the driver was speeding until the process died would be a lie.
    expect(closed[0]!.endedAt.getTime()).toBe(T0 + 60 * SEC)
  })

  it('drops a too-short episode on shutdown rather than writing it', () => {
    noteSpeedFrame(frame(95, T0), ctx)
    expect(flushEpisodes()).toHaveLength(0)
    expect(eventBus.publish).not.toHaveBeenCalled()
  })
})

describe('episodes are per vehicle', () => {
  it('does not let one unit close another unit\'s episode', () => {
    const other = { ...ctx, vehicleId: 'veh2' }
    for (let i = 0; i < 3; i++) noteSpeedFrame(frame(95, T0 + i * 30 * SEC), ctx)
    for (let i = 0; i < 3; i++) noteSpeedFrame(frame(99, T0 + i * 30 * SEC), other)
    expect(openEpisodeCount()).toBe(2)

    const closed = noteSpeedFrame(frame(10, T0 + 90 * SEC), ctx)!
    expect(closed.vehicleId).toBe('veh1')
    expect(openEpisodeCount()).toBe(1)
  })
})

describe('the capture flag', () => {
  it('records nothing at all while INCIDENT_CAPTURE_ENABLED is false', () => {
    env.INCIDENT_CAPTURE_ENABLED = false
    try {
      for (let i = 0; i < 4; i++) noteSpeedFrame(frame(120, T0 + i * 30 * SEC), ctx)
      noteSpeedFrame(frame(10, T0 + 200 * SEC), ctx)
      expect(openEpisodeCount()).toBe(0)
      expect(eventBus.publish).not.toHaveBeenCalled()
    } finally {
      env.INCIDENT_CAPTURE_ENABLED = true
    }
  })
})
