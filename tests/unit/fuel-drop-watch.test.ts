/**
 * The fast path, and the gates that stop it being a liar.
 *
 * `fuel-drop-watch` is stage one of the parked-fall rule: it raises within
 * minutes of a tank dropping on a machine standing still, and stage two
 * (`modules/fuel/parked-fall`) says what it was once the machine next starts.
 * Speed is only worth having if the thing it raises is worth reading, and the
 * entire safety argument is the disturbance rule: fuel does not reposition
 * itself inside a tank that is sitting still, so a fall on a motionless machine
 * cannot be redistribution.
 *
 * Every refusal below is that rule or a consequence of it.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  noteFuelFrame, resetFuelWatch, LIVE_DROP_MIN_ML, MAX_ENGINE_ON_MS, STILL_MIN_MS,
} from '../../src/lib/fuel-drop-watch.js'
import { STILL_DOWN_CONFIRM_MS } from '../../src/modules/fuel/parked-fall.js'
import type { AccelAxes, VehicleTelemetryFrame } from '../../src/providers/telemetry-provider.js'

const CTX = { orgId: 'org_1', vehicleId: 'veh_1', plate: 'MUFINDI: MTR 09' }
const T0 = Date.parse('2026-09-23T09:10:00Z')

type Over = Partial<{ speedKmh: number; engineOn: boolean; ignitionKnown: boolean; engineHoursMeter: number | null; accelG: AccelAxes | null }>

/** One frame. Parked with the engine MEASURED off unless a case says otherwise. */
const frame = (secs: number, ml: number | null, over: Over = {}): VehicleTelemetryFrame => ({
  capturedAt:       new Date(T0 + secs * 1000),
  fuelLevelMl:      ml,
  speedKmh:         over.speedKmh ?? 0,
  engineOn:         over.engineOn ?? false,
  ignitionKnown:    over.ignitionKnown ?? true,
  engineHoursMeter: over.engineHoursMeter ?? null,
  accelG:           over.accelG ?? null,
} as VehicleTelemetryFrame)

/** A series, then the last level held for as many minutes again — long enough to be confirmed. */
const held = (mls: (number | null)[], minutes = 6): (number | null)[] => {
  const last = [...mls].reverse().find(v => v != null) ?? null
  return [...mls, ...Array(minutes).fill(last)]
}

/**
 * Feed a series at 60 s steps and return the drop raised, if any.
 *
 * `over` applies to EVERY frame, which is what the disturbance cases want: the
 * rule is about the whole window, so one moving frame anywhere in it is enough
 * to refuse and the fixtures should not have to say where. A function gets the
 * frame's index, for cases where it matters.
 */
const run = (mls: (number | null)[], over: Over | ((i: number) => Over) = {}) => {
  let raised: ReturnType<typeof noteFuelFrame> = null
  for (const [i, ml] of mls.entries()) {
    const out = noteFuelFrame(frame(i * 60, ml, typeof over === 'function' ? over(i) : over), CTX)
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
  it('sees a real drop on a machine standing still, once it is still down five minutes on', () => {
    const out = run(held(REAL_DROP))
    expect(out).not.toBeNull()
    expect(out!.baselineMl).toBe(60_100)
    expect(out!.troughMl).toBe(39_400)
    expect(out!.droppedMl).toBe(20_700)
    expect(out!.vehicleId).toBe('veh_1')
    expect(out!.engineEvidence).toBe('sensor')
    expect(out!.confirmedAt.getTime() - out!.settledAt.getTime()).toBeGreaterThanOrEqual(STILL_DOWN_CONFIRM_MS)
  })

  it('raises once per fall, not once per frame after it', () => {
    let count = 0
    for (const [i, ml] of held(REAL_DROP, 20).entries()) {
      if (noteFuelFrame(frame(i * 60, ml), CTX)) count++
    }
    expect(count).toBe(1)
  })

  it('catches the band the adjudicator refuses — 10 to 15 L', () => {
    // SIPHON_MIN_DROP_ML is 15 L, and 176 drains over 30 days sit below it.
    // MUFINDI - EX 16's 11 L on 2026-09-24 is one of them.
    const out = run(held([
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
      49_000, 49_000, 49_000,
    ]))
    expect(out).not.toBeNull()
    expect(out!.droppedMl).toBe(11_000)
    expect(LIVE_DROP_MIN_ML).toBeLessThan(15_000)
  })
})

describe('fuel-drop-watch — the five-minute confirmation', () => {
  it('holds a fall until it has been down five minutes, and raises it then', () => {
    const series = held(REAL_DROP)
    const raised: { i: number; settledIdx: number }[] = []
    for (const [i, ml] of series.entries()) {
      const out = noteFuelFrame(frame(i * 60, ml), CTX)
      if (out) raised.push({ i, settledIdx: (out.settledAt.getTime() - T0) / 60_000 })
    }
    // Settled on the first of the three agreeing lows (39.5 L, index 8); raised at
    // the first reading five minutes after it — not a frame sooner.
    expect(raised).toEqual([{ i: 8 + STILL_DOWN_CONFIRM_MS / 60_000, settledIdx: 8 }])
  })

  it('drops a fall that comes back inside five minutes, without raising it', () => {
    const out = run([...REAL_DROP, 60_000, 60_100, 60_100, 60_100, 60_100, 60_100, 60_100])
    expect(out).toBeNull()
  })

  it('leaves a vehicle free to be judged again once a held fall came back', () => {
    // A swing that came back must not buy an hour's silence for a real fall after it.
    const swing = [...REAL_DROP, 60_100, 60_100, 60_100, 60_100]
    const real = held([60_100, 60_100, 60_100, 60_100, 60_100, 60_100, 48_000, 48_000, 48_000])
    expect(run([...swing, ...real])).not.toBeNull()
  })
})

/**
 * MUFINDI: CTR 12, 2026-09-25, as stored (EAT clock, litres). Parked all day;
 * the engine ran for about two minutes at 15:08, then the tank fell 6 L over
 * twenty minutes with it off. The 10 L floor, the 15-minute window and the
 * engine-off-throughout rule each missed it on their own.
 */
const CTR12: [string, number, boolean?][] = [
  ['14:56:00', 214.9], ['14:57:03', 214.9], ['14:58:02', 214.9], ['14:59:50', 214.9],
  ['15:00:02', 214.9], ['15:01:02', 214.8], ['15:02:02', 214.8], ['15:03:03', 214.9],
  ['15:04:03', 214.9], ['15:05:03', 214.9], ['15:06:03', 214.9], ['15:06:39', 214.9],
  ['15:07:11', 214.9], ['15:07:39', 214.9], ['15:08:09', 214.9],
  ['15:08:35', 215.3, true], ['15:09:35', 215.3, true],
  ['15:10:33', 214.7], ['15:11:33', 214.7], ['15:12:33', 213.8], ['15:13:33', 213.8],
  ['15:15:10', 213.0], ['15:15:33', 213.0], ['15:16:33', 212.5], ['15:17:33', 212.5],
  ['15:18:33', 211.9], ['15:19:33', 211.9], ['15:20:35', 211.5], ['15:21:33', 211.5],
  ['15:22:31', 210.5], ['15:22:37', 210.5], ['15:23:33', 210.5], ['15:24:33', 210.5],
  ['15:25:34', 210.0], ['15:26:34', 210.0], ['15:27:35', 209.4], ['15:28:33', 209.4],
  ['15:30:33', 209.0], ['15:31:33', 208.9],
]
const eat = (hms: string) => Date.parse(`2026-09-25T${hms}+03:00`)

describe('fuel-drop-watch — small, slow drains on a parked machine', () => {
  it('sees CTR 12: 6 L over twenty minutes, after a two-minute engine run', () => {
    let raised: ReturnType<typeof noteFuelFrame> = null
    for (const [hms, l, engineOn] of CTR12) {
      const out = noteFuelFrame({
        capturedAt: new Date(eat(hms)), fuelLevelMl: Math.round(l * 1000),
        speedKmh: 0, engineOn: engineOn ?? false, ignitionKnown: true, engineHoursMeter: null,
      } as VehicleTelemetryFrame, { ...CTX, plate: 'MUFINDI: CTR 12' })
      if (out) raised = out
    }
    expect(raised).not.toBeNull()
    expect(raised!.droppedMl).toBeGreaterThanOrEqual(LIVE_DROP_MIN_ML)
    expect(raised!.engineOnMs).toBeGreaterThan(0)
    expect(raised!.engineOnMs).toBeLessThanOrEqual(MAX_ENGINE_ON_MS)
  })

  it('catches 5 to 10 L', () => {
    const out = run(held([
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
      54_000, 54_000, 54_000,
    ]))
    expect(out).not.toBeNull()
    expect(out!.droppedMl).toBe(6_000)
  })

  it('refuses when the engine ran longer than a brief start', () => {
    // Six minutes on, then the fall: longer than MAX_ENGINE_ON_MS.
    const mls = held([60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 49_000, 49_000, 49_000])
    expect(run(mls, i => ({ engineOn: i >= 1 && i <= 6 }))).toBeNull()
  })

  it('refuses when the engine is running at the trough', () => {
    const mls = held([60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 49_000, 49_000, 49_000])
    expect(run(mls, i => ({ engineOn: i >= 7 }))).toBeNull()
  })

  it('judges from when the machine parked, once it has been still five minutes', () => {
    // Drove until minute 5, then stood seven minutes before the fall.
    expect(STILL_MIN_MS).toBe(5 * 60_000)
    const mls = held([...Array(12).fill(60_000), 49_000, 49_000, 49_000])
    const out = run(mls, i => ({ speedKmh: i <= 5 ? 20 : 0 }))
    expect(out).not.toBeNull()
    expect(out!.droppedMl).toBe(11_000)
  })

  it('refuses a fall within five minutes of the machine moving', () => {
    const mls = held([...Array(4).fill(60_000), 49_000, 49_000, 49_000])
    // Moving until minute 1: the fall lands inside the next five minutes.
    expect(run(mls, i => ({ speedKmh: i <= 1 ? 20 : 0 }))).toBeNull()
  })

  it('counts the five minutes to the start of the fall, not to the reading that found it', () => {
    // Stopped at minute 5, fell at minute 9: found at minute 11, six minutes
    // after the stop — but the fall began three minutes after it, which is the
    // probe settling or catching up with the drive, not a parked machine losing fuel.
    const mls = held([...Array(9).fill(60_000), 49_000, 49_000, 49_000])
    expect(run(mls, i => ({ speedKmh: i <= 5 ? 20 : 0 }))).toBeNull()
    resetFuelWatch()
    // Two minutes more of standing, and it is a parked machine's fall.
    const later = held([...Array(11).fill(60_000), 49_000, 49_000, 49_000])
    const out = run(later, i => ({ speedKmh: i <= 5 ? 20 : 0 }))
    expect(out).not.toBeNull()
    expect(out!.stillBeforeFallMs).toBeGreaterThanOrEqual(STILL_MIN_MS)
  })
})

/**
 * MUFINDI - FT 13, 23 Sep, as stored (EAT, litres, km/h, engine-hours) — no
 * ignition line on the unit that day, so the counter speaks for the engine.
 * Stopped 12:40:53, engine off 12:42:22 (by Wialon), 19.4 L drained at 12:49,
 * poured back at 13:01, drove off 13:04. The counter logged the drive's last
 * 4.9 minutes at 12:44:40, inside the parked window.
 */
const FT13: [string, number, number, number][] = [
  ['12:38:03', 92.9, 0, 1468.77556], ['12:38:33', 92.9, 0, 1468.77556], ['12:39:03', 92.9, 4, 1468.77556],
  ['12:39:33', 92.9, 4, 1468.77556], ['12:40:00', 92.6, 10, 1468.77556], ['12:40:33', 92.6, 10, 1468.77556],
  ['12:40:53', 92.6, 6, 1468.77556], ['12:41:25', 92.6, 0, 1468.77556], ['12:41:55', 92.6, 0, 1468.77556],
  ['12:42:25', 91.4, 0, 1468.77556], ['12:42:43', 91.4, 0, 1468.77556], ['12:43:43', 91.4, 0, 1468.77556],
  ['12:44:40', 91.2, 0, 1468.85667], ['12:45:41', 91.2, 0, 1468.85667], ['12:46:40', 91.4, 0, 1468.85667],
  ['12:47:42', 91.4, 0, 1468.85667], ['12:48:40', 91.0, 0, 1468.85667], ['12:49:40', 91.0, 0, 1468.85667],
  ['12:50:40', 88.9, 0, 1468.85667], ['12:51:41', 88.9, 0, 1468.85667], ['12:52:42', 71.4, 0, 1468.85667],
  ['12:53:42', 71.4, 0, 1468.85667], ['12:54:40', 71.7, 0, 1468.85667], ['12:55:42', 71.7, 0, 1468.85667],
  ['12:56:40', 71.6, 0, 1468.85667], ['12:57:42', 71.6, 0, 1468.85667], ['12:58:41', 71.6, 0, 1468.85667],
  ['12:59:41', 71.6, 0, 1468.85667], ['13:00:41', 71.6, 0, 1468.85667], ['13:01:41', 71.6, 0, 1468.85667],
  ['13:02:41', 76.9, 0, 1468.85667], ['13:03:41', 76.9, 0, 1468.85667], ['13:04:09', 76.9, 0, 1468.85667],
  ['13:04:24', 90.6, 7, 1468.85667], ['13:04:39', 90.6, 17, 1468.85667], ['13:05:09', 90.6, 14, 1468.85667],
]
const eat23 = (hms: string) => Date.parse(`2026-09-23T${hms}+03:00`)
const feedFt13 = (meterAt: (hms: string, m: number) => number = (_h, m) => m) => {
  let raised: ReturnType<typeof noteFuelFrame> = null
  for (const [hms, l, kmh, meter] of FT13) {
    const out = noteFuelFrame({
      capturedAt: new Date(eat23(hms)), fuelLevelMl: Math.round(l * 1000), speedKmh: kmh,
      engineOn: kmh > 0, ignitionKnown: false, engineHoursMeter: meterAt(hms, meter),
    } as VehicleTelemetryFrame, { ...CTX, plate: 'MUFINDI - FT 13' })
    if (out && !raised) raised = out
  }
  return raised
}

describe('fuel-drop-watch — MUFINDI - FT 13, 23 Sep (the counter reports late)', () => {
  it('raises the 19.4 L drain five minutes after it settled, within ten of it starting', () => {
    const out = feedFt13()
    expect(out).not.toBeNull()
    expect(out!.engineEvidence).toBe('counter')
    expect(out!.engineOnMs).toBe(0)
    expect(out!.droppedMl).toBeGreaterThan(19_000)
    expect(out!.settledAt.getTime()).toBe(eat23('12:52:42'))
    expect(out!.confirmedAt.getTime()).toBe(eat23('12:57:42'))
    expect(out!.stillBeforeFallMs).toBeGreaterThanOrEqual(STILL_MIN_MS)
  })

  it('still counts a counter tick that lands later than the drive could explain', () => {
    // The same 4.9 minutes logged at 12:48:40 — eight minutes after the stop — is
    // running inside the parked window.
    const out = feedFt13((hms, m) => (hms < '12:48:40' ? 1468.77556 : m))
    expect(out).toBeNull()
  })

  it('drops a held fall when the counter ticks before it is confirmed', () => {
    // On a unit with no ignition line, a tick after the fall may be the engine
    // having run through it.
    const out = feedFt13((hms, m) => (hms >= '12:55:42' ? m + 0.08 : m))
    expect(out).toBeNull()
  })
})

describe('fuel-drop-watch — the engine-hours counter, where there is no ignition line', () => {
  it('judges a unit with no ignition line by its counter', () => {
    // 189 of 267 units without a line have a counter that tracks the engine
    // (measured 2026-09-26); whether THIS one does is the worker's question.
    const out = run(held(REAL_DROP), { ignitionKnown: false, engineHoursMeter: 1234.5 })
    expect(out).not.toBeNull()
    expect(out!.engineEvidence).toBe('counter')
    expect(out!.engineOnMs).toBe(0)
  })

  it('refuses when the counter ran for more than a brief start', () => {
    // Six minutes of running in the window: the counter moved 0.1 h.
    const out = run(held(REAL_DROP), i => ({ ignitionKnown: false, engineHoursMeter: 1234.5 + Math.min(i, 6) / 60 }))
    expect(out).toBeNull()
  })

  it('refuses when the counter shows the engine running at the trough', () => {
    // Started as the level fell and kept running: the same refusal the line gets.
    const out = run(held(REAL_DROP), i => ({ ignitionKnown: false, engineHoursMeter: 1234.5 + Math.max(0, i - 7) / 60 }))
    expect(out).toBeNull()
  })

  it('allows a brief counter tick and judges the trough once it is off again', () => {
    // The counter moved 0.02 h (72 s) around the trough and then stopped — a
    // start, not work, exactly as a brief engine run on the line is tolerated.
    const out = run(held(REAL_DROP, 10), i => ({ ignitionKnown: false, engineHoursMeter: 1234.5 + (i >= 10 ? 0.02 : 0) }))
    expect(out).not.toBeNull()
    expect(out!.engineOnMs).toBeLessThanOrEqual(MAX_ENGINE_ON_MS)
  })

  it('refuses when the ignition line says off but the counter says it ran', () => {
    // MUFINDI: DZ 13 on 22 Sep — the line read off while the counter logged half
    // an hour in thirty minutes. The line was wrong.
    const out = run(held(REAL_DROP), i => ({ engineHoursMeter: 500 + i * 0.02 }))
    expect(out).toBeNull()
  })

  it('refuses when there is neither a line nor a counter', () => {
    // "We do not know whether the engine was off" is not "the engine was off".
    expect(run(held(REAL_DROP), { ignitionKnown: false, engineHoursMeter: null })).toBeNull()
  })
})

describe('fuel-drop-watch — the accelerometer', () => {
  // GPS cannot see a machine tilt where it stands — a truck loaded, or jacked —
  // and a tilted tank reads a different level with the same fuel in it.
  const LEVEL = { x: 0.05, y: 0.0, z: 0.01 }

  it('refuses a fall that comes with the machine tilting — the fuel moving in the tank', () => {
    const out = run(held(REAL_DROP), i => ({ accelG: i < 7 ? LEVEL : { ...LEVEL, y: 0.06 } }))
    expect(out).toBeNull()
  })

  it('raises it when the angle held, and records how little it moved', () => {
    const out = run(held(REAL_DROP), () => ({ accelG: LEVEL }))
    expect(out).not.toBeNull()
    expect(out!.attitudeShiftG).toBe(0)
  })

  it('raises as before on a unit with no accelerometer, with no tilt recorded', () => {
    const out = run(held(REAL_DROP))
    expect(out).not.toBeNull()
    expect(out!.attitudeShiftG).toBeNull()
  })
})

describe('fuel-drop-watch — the disturbance rule', () => {
  it('refuses when the machine moved at any point in the window', () => {
    // A tank that is tilting, braking or being driven can redistribute, and
    // this module has no way to tell that from fuel leaving. The adjudicator,
    // which has the burn bands, is the one that should judge it.
    expect(run(held(REAL_DROP), { speedKmh: 12 })).toBeNull()
  })

  it('refuses when the engine was running', () => {
    expect(run(held(REAL_DROP), { engineOn: true })).toBeNull()
  })
})

describe('fuel-drop-watch — what it refuses on shape', () => {
  it('refuses a drop too small to be anything but probe noise', () => {
    // p99 of the level move between two consecutive readings is 2.9 L; the
    // floor is 5 L.
    const out = run(held([
      60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
      57_000, 57_000, 57_000,
    ]))
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
      42_000, 39_000, 36_000, 33_000, 30_000, 27_000, 24_000, 21_000, 18_000,
    ])
    expect(out).toBeNull()
  })

  it('is not fooled by a single spike into inventing a baseline', () => {
    // One absurd reading must not become the level the fall is measured from.
    const out = run(held([
      45_000, 45_000, 99_000, 45_000, 45_000, 45_000,
      44_800, 44_800, 44_800,
    ]))
    expect(out).toBeNull()
  })

  it('ignores frames with no reading rather than treating them as a change', () => {
    const out = run(held([
      60_100, 60_100, null, 60_100, 60_100, 60_100, null,
      39_400, 39_400, 39_400,
    ]))
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
    for (const [i, ml] of held([39_400, 39_400, 39_400]).entries()) {
      expect(noteFuelFrame(frame(1000 + i * 60, ml), CTX)).toBeNull()
    }
  })

  it('forgets a held fall too', () => {
    for (const [i, ml] of REAL_DROP.entries()) noteFuelFrame(frame(i * 60, ml), CTX)
    resetFuelWatch('veh_1')
    for (let i = 0; i < 8; i++) expect(noteFuelFrame(frame(REAL_DROP.length * 60 + i * 60, 39_400), CTX)).toBeNull()
  })
})
