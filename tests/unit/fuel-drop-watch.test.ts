/**
 * The fast path, and the gates that stop it being a liar.
 *
 * `fuel-drop-watch` raises within minutes of a tank dropping, against an
 * adjudicator that takes a mean of 8.9 hours. Speed is only worth having if the
 * thing it raises is worth reading, and the entire safety argument is the
 * disturbance rule: fuel does not reposition itself inside a tank that is
 * sitting still, so a fall on a motionless machine cannot be redistribution.
 *
 * Every refusal below is that rule or a consequence of it.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  noteFuelFrame, resetFuelWatch, LIVE_DROP_MIN_ML,
} from '../../src/lib/fuel-drop-watch.js'
import type { VehicleTelemetryFrame } from '../../src/providers/telemetry-provider.js'

const CTX = { orgId: 'org_1', vehicleId: 'veh_1', plate: 'MUFINDI: MTR 09' }
const T0 = Date.parse('2026-09-23T09:10:00Z')

/** One frame. Parked with the engine MEASURED off unless a case says otherwise. */
const frame = (
  secs: number, ml: number | null,
  over: Partial<{ speedKmh: number; engineOn: boolean; ignitionKnown: boolean }> = {},
): VehicleTelemetryFrame => ({
  capturedAt:    new Date(T0 + secs * 1000),
  fuelLevelMl:   ml,
  speedKmh:      over.speedKmh ?? 0,
  engineOn:      over.engineOn ?? false,
  ignitionKnown: over.ignitionKnown ?? true,
} as VehicleTelemetryFrame)

/**
 * Feed a series at 60 s steps and return the drop raised, if any.
 *
 * `over` applies to EVERY frame, which is what the disturbance cases want: the
 * rule is about the whole window, so one moving frame anywhere in it is enough
 * to refuse and the fixtures should not have to say where.
 */
const run = (
  mls: (number | null)[],
  over: Partial<{ speedKmh: number; engineOn: boolean; ignitionKnown: boolean }> = {},
) => {
  let raised: ReturnType<typeof noteFuelFrame> = null
  for (const [i, ml] of mls.entries()) {
    const out = noteFuelFrame(frame(i * 60, ml, over), CTX)
    if (out) raised = out
  }
  return raised
}

/** MTR 09's real shape: 60.1 L for a while, down to 39.4 L, held. */
const REAL_DROP = [
  60_100, 60_100, 60_100, 60_100, 60_100, 60_100,
  59_400, 45_200,
  39_500, 39_400, 39_400, 39_400,
]

beforeEach(() => resetFuelWatch())

describe('fuel-drop-watch — what it raises', () => {
  it('sees a real drop on a machine standing still', () => {
    const out = run(REAL_DROP)
    expect(out).not.toBeNull()
    expect(out!.baselineMl).toBe(60_100)
    expect(out!.troughMl).toBe(39_400)
    expect(out!.droppedMl).toBe(20_700)
    expect(out!.vehicleId).toBe('veh_1')
  })

  it('raises once per fall, not once per frame after it', () => {
    let count = 0
    for (const [i, ml] of [...REAL_DROP, 39_400, 39_400, 39_400, 39_400].entries()) {
      if (noteFuelFrame(frame(i * 60, ml), CTX)) count++
    }
    expect(count).toBe(1)
  })

  it('catches the band the adjudicator refuses — 10 to 15 L', () => {
    // SIPHON_MIN_DROP_ML is 15 L, and 176 drains over 30 days sit below it.
    // MUFINDI - EX 16's 11 L on 2026-09-24 is one of them.
    const out = run([
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
      49_000, 49_000, 49_000,
    ])
    expect(out).not.toBeNull()
    expect(out!.droppedMl).toBe(11_000)
    expect(LIVE_DROP_MIN_ML).toBeLessThan(15_000)
  })
})

describe('fuel-drop-watch — the disturbance rule', () => {
  it('refuses when the machine moved at any point in the window', () => {
    // A tank that is tilting, braking or being driven can redistribute, and
    // this module has no way to tell that from fuel leaving. The adjudicator,
    // which has the burn bands, is the one that should judge it.
    const out = run(REAL_DROP, { speedKmh: 12 })
    expect(out).toBeNull()
  })

  it('refuses when the engine was running', () => {
    const out = run(REAL_DROP, { engineOn: true })
    expect(out).toBeNull()
  })

  it('refuses when the engine state was never MEASURED', () => {
    // 54 of 147 reporting units never report a usable ignition. "We do not know
    // whether the engine was off" is not "the engine was off", and this module
    // must stay silent on them rather than assume.
    const out = run(REAL_DROP, { ignitionKnown: false })
    expect(out).toBeNull()
  })
})

describe('fuel-drop-watch — what it refuses on shape', () => {
  it('refuses a drop too small to be anything but probe noise', () => {
    // p99 of the level move between two consecutive readings is 2.9 L.
    const out = run([
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
      57_000, 57_000, 57_000,
    ])
    expect(out).toBeNull()
  })

  it('refuses while the level is still falling — a trough must have settled', () => {
    const out = run([
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
      50_000, 45_000, 40_000,
    ])
    expect(out).toBeNull()
  })

  it('refuses a slow slope, which is consumption and not an event', () => {
    // No plateau anywhere: each reading differs from the last by more than the
    // tolerance, so there is no settled baseline to measure a fall against.
    const out = run([
      60_000, 57_000, 54_000, 51_000, 48_000, 45_000,
      42_000, 39_000, 36_000,
    ])
    expect(out).toBeNull()
  })

  it('is not fooled by a single spike into inventing a baseline', () => {
    // One absurd reading must not become the level the fall is measured from.
    const out = run([
      45_000, 45_000, 99_000, 45_000, 45_000, 45_000,
      44_800, 44_800, 44_800,
    ])
    expect(out).toBeNull()
  })

  it('ignores frames with no reading rather than treating them as a change', () => {
    const out = run([
      60_100, 60_100, null, 60_100, 60_100, 60_100, null,
      39_400, 39_400, 39_400,
    ])
    expect(out).not.toBeNull()
    expect(out!.droppedMl).toBe(20_700)
  })
})

describe('fuel-drop-watch — state', () => {
  it('keeps vehicles apart', () => {
    const other = { ...CTX, vehicleId: 'veh_2', plate: 'MUFINDI: MTR 04' }
    for (const [i, ml] of REAL_DROP.entries()) noteFuelFrame(frame(i * 60, ml), CTX)
    // veh_2 has seen nothing, so its own first frames cannot inherit a baseline.
    expect(noteFuelFrame(frame(0, 39_400), other)).toBeNull()
  })

  it('forgets a vehicle on demand, so a replayed backlog cannot invent a fall', () => {
    for (const [i, ml] of REAL_DROP.slice(0, 6).entries()) noteFuelFrame(frame(i * 60, ml), CTX)
    resetFuelWatch('veh_1')
    // Yesterday's 60 L against today's 39 L is not a drop anybody watched.
    for (const [i, ml] of [39_400, 39_400, 39_400].entries()) {
      expect(noteFuelFrame(frame(1000 + i * 60, ml), CTX)).toBeNull()
    }
  })
})
