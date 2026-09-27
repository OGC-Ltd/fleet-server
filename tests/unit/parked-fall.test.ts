/**
 * Stage two of the parked-fall rule: what a fall on a parked machine turned out
 * to be, decided from where the machine was when the level next moved.
 *
 * Every verdict here is one an operator acts on differently, so each has a case,
 * and so does every wait — a verdict given before its evidence exists is the
 * failure that matters most (a CLEARED that should have been TOPPED_UP hides
 * exactly the theft CTR 12 was). The operator's rule of 2026-09-27 runs through
 * all of it: a theft followed by a refuel — at the spot, or at a pump after a
 * drive — must never come out as the gauge.
 */

import { describe, it, expect } from 'vitest'
import {
  judgeNextStart, counterTracksEngine, probeReadsEmpty, stillDown, probeFrozeWhileRunning, standsOf,
  attitudeOf, vibrationOf, WORK_WINDOW_MS, NEXT_START_HORIZON_MS,
  type FallReading, type PendingFall,
} from '../../src/modules/fuel/parked-fall.js'
import type { AccelAxes } from '../../src/providers/telemetry-provider.js'

const MIN = 60_000
const H = 60 * MIN
const S = Date.parse('2026-09-23T14:01:00Z')

/** As the job asks it: only the readings that exist by `now`. */
const judgeAt = (fall: PendingFall, rs: readonly FallReading[], fills: readonly number[], now: number) =>
  judgeNextStart(fall, rs.filter(r => r.t <= now), fills, now)

/** Baseline 60 L, down to 40 L, settled at S. Back is 54 L or more; still low is 46 L or less. */
const FALL: PendingFall = { settledAtMs: S, troughMl: 40_000, droppedMl: 20_000, engineEvidence: 'sensor' }

/** Readings every minute from `from` to `to`, shaped by `at`. */
function readings(from: number, to: number, at: (t: number) => Partial<FallReading>): FallReading[] {
  const out: FallReading[] = []
  for (let t = from; t <= to; t += MIN) {
    out.push({ t, fuelMl: 40_000, speedKmh: 0, engineOn: false, ignitionKnown: true, meterH: null, ...at(t) })
  }
  return out
}

/** Parked and down until `startAt`, then working: engine on, burning 5 L an hour. */
const workFrom = (startAt: number, extra: (t: number) => Partial<FallReading> = () => ({})) => (t: number) =>
  t < startAt ? extra(t) : { engineOn: true, fuelMl: Math.round(40_000 - ((t - startAt) / H) * 5_000), ...extra(t) }

// ── trips: stands at named spots, drives between them ─────────────────────
type Spot = { lat: number; lng: number }
const A: Spot = { lat: -4.50, lng: 30.10 }   // where it was drained
const B: Spot = { lat: -4.51, lng: 30.11 }   // ~1.6 km on: the pump, or a slope
const C: Spot = { lat: -4.52, lng: 30.12 }
const D: Spot = { lat: -4.53, lng: 30.13 }
type Leg =
  | { until: number; stand: Spot; engineOn?: boolean; accel?: AccelAxes | null }
  | { until: number; drive: [Spot, Spot] }
/** A timeline of legs, each running until its `until`; the level comes from `fuel`. */
const trip = (legs: Leg[], fuel: (t: number) => number) => (t: number): Partial<FallReading> => {
  let start = S - 10 * MIN
  for (const leg of legs) {
    if (t < leg.until) {
      if ('stand' in leg) {
        return { ...leg.stand, speedKmh: 0, engineOn: leg.engineOn ?? false, accel: leg.accel ?? null, fuelMl: fuel(t) }
      }
      const f = (t - start) / (leg.until - start)
      const [p, q] = leg.drive
      return { lat: p.lat + (q.lat - p.lat) * f, lng: p.lng + (q.lng - p.lng) * f, speedKmh: 40, engineOn: true, fuelMl: fuel(t) }
    }
    start = leg.until
  }
  return { speedKmh: 40, engineOn: true, fuelMl: fuel(t) }
}

describe('parked-fall — stage two verdicts', () => {
  it('waits while the machine has not started', () => {
    const j = judgeAt(FALL, readings(S - 10 * MIN, S + 2 * H, () => ({})), [], S + 2 * H)
    expect(j.verdict).toBe('PENDING')
  })

  it('CONFIRMED: still gone once it started, and through two hours of work', () => {
    const start = S + 3 * H
    const rs = readings(S - 10 * MIN, start + WORK_WINDOW_MS + 5 * MIN, workFrom(start))
    // Not before the working window has been watched…
    expect(judgeAt(FALL, rs, [], start + H).verdict).toBe('PENDING')
    // …and then confirmed.
    const j = judgeAt(FALL, rs, [], start + WORK_WINDOW_MS + 5 * MIN)
    expect(j.verdict).toBe('CONFIRMED')
    expect(j.nextStartBy).toBe('engine')
    expect(j.nextStartAt).toBe(start)
  })

  it('REFUELLED: it rose well past the old level while it stood', () => {
    const rs = readings(S - 10 * MIN, S + 3 * H, t => (t >= S + H ? { fuelMl: 95_000 } : {}))
    const j = judgeAt(FALL, rs, [], S + H + 5 * MIN)
    expect(j.verdict).toBe('REFUELLED')
    expect(j.reason).toMatch(/unexplained/)
  })

  it('UNRESOLVED: no start within a day, still down', () => {
    const rs = readings(S - 10 * MIN, S + 25 * H, () => ({}))
    expect(judgeAt(FALL, rs, [], S + 23 * H).verdict).toBe('PENDING')
    expect(judgeAt(FALL, rs, [], S + NEXT_START_HORIZON_MS + MIN).verdict).toBe('UNRESOLVED')
  })

  it('names movement as the next start when the machine drove off', () => {
    const start = S + 2 * H
    const rs = readings(S - 10 * MIN, start + WORK_WINDOW_MS + 5 * MIN, t => (t < start ? {} : { speedKmh: 18 }))
    const j = judgeAt(FALL, rs, [], start + WORK_WINDOW_MS + 5 * MIN)
    expect(j.verdict).toBe('CONFIRMED')
    expect(j.nextStartBy).toBe('moved')
  })
})

describe('parked-fall — the level jumps back as the engine starts, standing', () => {
  const start = S + 3 * H
  const jump = (accel: (t: number) => AccelAxes | null) =>
    readings(S - 10 * MIN, start + 40 * MIN, t => (t < start ? { accel: accel(t) } : { engineOn: true, fuelMl: 58_500, accel: accel(t) }))

  it('stays open without an accelerometer — a pump with the engine idling is possible — and is never retracted', () => {
    const j = judgeAt(FALL, jump(() => null), [], start + 30 * MIN)
    expect(j.verdict).toBe('UNRESOLVED')
    expect(j.reason).toMatch(/no accelerometer/)
  })

  it('stays open when the accelerometer shows the angle changing with it — a suspension rising', () => {
    const j = judgeAt(FALL, jump(t => ({ x: 0.05, y: t < start ? 0.0 : 0.04, z: 0.01 })), [], start + 30 * MIN)
    expect(j.verdict).toBe('UNRESOLVED')
    expect(j.reason).toMatch(/angle of the machine changed/)
  })

  it('TOPPED_UP when the accelerometer shows the same angle and an idling engine — fuel went in', () => {
    const j = judgeAt(FALL, jump(() => ({ x: 0.05, y: 0.0, z: 0.01 })), [], start + 30 * MIN)
    expect(j.verdict).toBe('TOPPED_UP')
    expect(j.reason).toMatch(/idling/)
  })
})

describe('parked-fall — theft, then a refuel after a drive (the operator, 2026-09-27)', () => {
  // Drained at A. Starts an hour later, drives 20 minutes to a pump at B, is
  // topped back up there, drives on to C and D.
  const legs = (pump: { engineOn?: boolean; accel?: AccelAxes | null } = {}): Leg[] => [
    { until: S + 60 * MIN, stand: A },
    { until: S + 80 * MIN, drive: [A, B] },
    { until: S + 95 * MIN, stand: B, ...pump },
    { until: S + 105 * MIN, drive: [B, C] },
    { until: S + 120 * MIN, stand: C },
    { until: S + 130 * MIN, drive: [C, D] },
    { until: S + 145 * MIN, stand: D },
  ]
  const refill = (at: number, to = 59_000) => (t: number) => (t < at ? 40_000 : t < S + 95 * MIN ? to : to - 500)
  const run = (ls: Leg[], fuel: (t: number) => number, now: number) =>
    judgeAt(FALL, readings(S - 10 * MIN, S + 150 * MIN, trip(ls, fuel)), [], now)

  it('engine off at the pump: CONFIRMED — the loss stood while it drove, until fuel went in', () => {
    const j = run(legs(), refill(S + 87 * MIN), S + 100 * MIN)
    expect(j.verdict).toBe('CONFIRMED')
    expect(j.reason).toMatch(/stayed down while the machine ran, until fuel went in while the machine stood/)
  })

  it('engine idling at the pump, no accelerometer: the call stands, never retracted', () => {
    const j = run(legs({ engineOn: true }), refill(S + 87 * MIN), S + 100 * MIN)
    expect(j.verdict).toBe('UNRESOLVED')
    expect(j.verdict).not.toBe('CLEARED')
  })

  it('engine idling at the pump, accelerometer quiet: fuel went in', () => {
    const j = run(legs({ engineOn: true, accel: { x: 0.02, y: -0.01, z: 0.03 } }), refill(S + 87 * MIN), S + 100 * MIN)
    expect(j.verdict).toBe('CONFIRMED')
    expect(j.reason).toMatch(/idling/)
  })

  it('topped up two minutes after arriving — too quick to see settle — is still fuel going in', () => {
    // The first settled reading at the pump is already back. The pump stand
    // itself is where a refuel fits, so this is fuel in, confirmed at C.
    const j = run(legs(), refill(S + 82 * MIN), S + 125 * MIN)
    expect(j.verdict).toBe('CONFIRMED')
    expect(j.reason).toMatch(/until fuel went in/)
  })

  it('a pump five minutes away: TOPPED_UP — it had hardly run with the tank down', () => {
    const near: Leg[] = [
      { until: S + 60 * MIN, stand: A },
      { until: S + 65 * MIN, drive: [A, B] },
      { until: S + 80 * MIN, stand: B },
      { until: S + 90 * MIN, drive: [B, C] },
      { until: S + 110 * MIN, stand: C },
    ]
    const j = judgeAt(FALL, readings(S - 10 * MIN, S + 115 * MIN, trip(near, t => (t < S + 71 * MIN ? 40_000 : 59_000))), [], S + 80 * MIN)
    expect(j.verdict).toBe('TOPPED_UP')
    expect(j.reason).toMatch(/while the machine stood with the engine off/)
  })

  it('a full tank at the pump: still the loss first — never the gauge', () => {
    const j = run(legs(), refill(S + 87 * MIN, 95_000), S + 100 * MIN)
    expect(j.verdict).toBe('CONFIRMED')
    expect(j.reason).toMatch(/until fuel went in/)
  })
})

describe('parked-fall — the reading, not the fuel', () => {
  // Drained at A; drives off an hour later and the level is back within
  // minutes, on the road — before it stands anywhere.
  const legs: Leg[] = [
    { until: S + 60 * MIN, stand: A },
    { until: S + 80 * MIN, drive: [A, B] },
    { until: S + 95 * MIN, stand: B },
    { until: S + 105 * MIN, drive: [B, C] },
    { until: S + 120 * MIN, stand: C },
    { until: S + 400 * MIN, drive: [C, D] },
  ]
  const backOnTheRoad = (t: number) => (t < S + 65 * MIN ? 40_000 : 59_000)

  it('CLEARED: back on the move, and back at two places it stood since', () => {
    const rs = readings(S - 10 * MIN, S + 125 * MIN, trip(legs, backOnTheRoad))
    expect(judgeAt(FALL, rs, [], S + 90 * MIN).verdict).toBe('PENDING')   // one place is not enough
    const j = judgeAt(FALL, rs, [], S + 125 * MIN)
    expect(j.verdict).toBe('CLEARED')
    expect(j.reason).toMatch(/no fuel can go in/)
  })

  it('CLEARED at the first stop with an accelerometer, standing at the angle it was drained at', () => {
    const angle = { x: 0.10, y: -0.05, z: 0.02 }
    const withAxes: Leg[] = legs.map(l => ('stand' in l ? { ...l, accel: l.stand === C ? { x: 0.3, y: 0.1, z: 0.0 } : angle } : l))
    const j = judgeAt(FALL, readings(S - 10 * MIN, S + 100 * MIN, trip(withAxes, backOnTheRoad)), [], S + 100 * MIN)
    expect(j.verdict).toBe('CLEARED')
  })

  it('high at one stop only — a slope — is not a return: the call stands', () => {
    const slope = (t: number) => (t >= S + 80 * MIN && t < S + 95 * MIN ? 59_000 : 40_000)
    const rs = readings(S - 10 * MIN, S + 60 * MIN + WORK_WINDOW_MS + 5 * MIN, trip(legs, slope))
    for (const now of [S + 100 * MIN, S + 125 * MIN, S + 150 * MIN]) {
      expect(judgeAt(FALL, rs, [], now).verdict).toBe('PENDING')
    }
    expect(judgeAt(FALL, rs, [], S + 60 * MIN + WORK_WINDOW_MS + 5 * MIN).verdict).toBe('CONFIRMED')
  })

  it('back on the move with nowhere to stand soon after: open, not retracted', () => {
    const road: Leg[] = [{ until: S + 60 * MIN, stand: A }, { until: S + 400 * MIN, drive: [A, D] }]
    const rs = readings(S - 10 * MIN, S + 200 * MIN, trip(road, backOnTheRoad))
    expect(judgeAt(FALL, rs, [], S + 80 * MIN).verdict).toBe('PENDING')
    expect(judgeAt(FALL, rs, [], S + 110 * MIN).verdict).toBe('UNRESOLVED')
  })

  it('a filling on the ledger while it stood outweighs a return on the move', () => {
    const rs = readings(S - 10 * MIN, S + 125 * MIN, trip(legs, backOnTheRoad))
    const j = judgeAt(FALL, rs, [S + 58 * MIN], S + 125 * MIN)
    expect(j.verdict).not.toBe('CLEARED')
  })
})

describe('parked-fall — the pour (CTR 12, 25 Sep)', () => {
  // As stored, EAT: settled 210.0 L at 15:24:33 after falling from 215.3 L; the
  // engine idled 15:33-15:42 without moving; the level came back to 215.7 L at
  // 15:59 with the engine off; no filling was ever recorded.
  const eat = (hm: string) => Date.parse(`2026-09-25T${hm}:00+03:00`)
  const CTR12: PendingFall = { settledAtMs: eat('15:24'), troughMl: 210_000, droppedMl: 5_300, engineEvidence: 'sensor' }
  const rs = readings(eat('15:20'), eat('21:30'), t => ({
    fuelMl: t < eat('15:57') ? 209_200 : t < eat('15:59') ? 211_500 : 215_700,
    engineOn: t >= eat('15:33') && t < eat('15:43'),
  }))

  it('keeps watching while the level is still down after the idle', () => {
    expect(judgeAt(CTR12, rs, [], eat('15:50')).verdict).toBe('PENDING')
  })

  it('TOPPED_UP once the rise has finished — no wait for the ledger', () => {
    expect(judgeAt(CTR12, rs, [], eat('16:01')).verdict).toBe('PENDING')   // still rising
    const j = judgeAt(CTR12, rs, [], eat('16:03'))
    expect(j.verdict).toBe('TOPPED_UP')
    expect(j.reason).toMatch(/engine off/)
    expect(j.backAt).toBeGreaterThanOrEqual(eat('15:59'))
    expect(judgeAt(CTR12, rs, [], eat('20:10')).verdict).toBe('TOPPED_UP')
  })

  it('stays TOPPED_UP whatever the ledger holds', () => {
    // Wialon calls any rise a filling; back to the old level and no further is
    // the fuel put back, recorded or not (MUFINDI - FT 13, 23 Sep, 13:01).
    expect(judgeAt(CTR12, rs, [eat('15:58')], eat('16:03')).verdict).toBe('TOPPED_UP')
    expect(judgeAt(CTR12, rs, [eat('15:30')], eat('20:10')).verdict).toBe('TOPPED_UP')
  })
})

describe('parked-fall — the pour the provider called a filling (MUFINDI - FT 13, 23 Sep)', () => {
  // As stored: settled 71.4 L at 12:52:42 after 92.6 L; the rise shows in our
  // readings only as the truck drives off at 13:04, because they trail the
  // tracker — Wialon, reading its own messages, timed the "filling" of 20.0 L at
  // 13:01:38, with the truck still parked and the engine off.
  const eat23 = (hms: string) => Date.parse(`2026-09-23T${hms}+03:00`)
  const FT13: PendingFall = { settledAtMs: eat23('12:52:42'), troughMl: 71_400, droppedMl: 21_200, engineEvidence: 'counter' }
  const rows: [string, number, number][] = [
    ['12:48:40', 91.0, 0], ['12:49:40', 91.0, 0], ['12:50:40', 88.9, 0], ['12:51:41', 88.9, 0], ['12:52:42', 71.4, 0],
    ['12:53:42', 71.4, 0], ['12:54:40', 71.7, 0], ['12:55:42', 71.7, 0], ['12:56:40', 71.6, 0], ['12:57:42', 71.6, 0],
    ['12:58:41', 71.6, 0], ['12:59:41', 71.6, 0], ['13:00:41', 71.6, 0], ['13:01:41', 71.6, 0], ['13:02:41', 76.9, 0],
    ['13:03:41', 76.9, 0], ['13:04:09', 76.9, 0], ['13:04:24', 90.6, 7], ['13:04:33', 90.6, 7], ['13:04:39', 90.6, 17],
    ['13:05:09', 90.6, 14], ['13:05:13', 90.6, 10], ['13:05:23', 90.6, 23], ['13:06:15', 90.6, 20], ['13:06:45', 90.7, 17],
    ['13:07:27', 90.7, 16], ['13:09:36', 86.6, 0], ['13:10:50', 89.6, 8], ['13:13:26', 91.3, 27], ['13:15:54', 89.4, 38],
  ]
  const rs: FallReading[] = rows.map(([hms, l, kmh]) => ({
    t: eat23(hms), fuelMl: Math.round(l * 1000), speedKmh: kmh, engineOn: kmh > 0, ignitionKnown: false, meterH: 1468.85667,
  }))

  it('is not taken for the gauge although our rows show the rise ending as it drove off', () => {
    // Our fuel trails the tracker by a sweep, so the stand just before it drove
    // off still counts as where a refuel fits (FUEL_LAG_MS).
    const j = judgeAt(FT13, rs, [], eat23('13:20'))
    expect(j.verdict).toBe('PENDING')
    expect(j.nextStartBy).toBe('moved')
  })

  it('TOPPED_UP at once with the ledger\'s "filling", timed while it stood', () => {
    const j = judgeAt(FT13, rs, [eat23('13:01:38')], eat23('13:20'))
    expect(j.verdict).toBe('TOPPED_UP')
    expect(j.reason).toMatch(/recorded by the provider as a filling/)
  })
})

describe('parked-fall — came back before any start', () => {
  it('TOPPED_UP as soon as it rose quickly back to the old level while standing', () => {
    const pour = S + 90 * MIN
    const rs = readings(S - 10 * MIN, S + 8 * H, t => (t >= pour ? { fuelMl: 59_000 } : {}))
    expect(judgeAt(FALL, rs, [], pour - MIN).verdict).toBe('PENDING')
    expect(judgeAt(FALL, rs, [], pour + 3 * MIN).verdict).toBe('TOPPED_UP')
  })

  it('REFUELLED when it rose well past the old level — a refuel, not the fuel coming back', () => {
    const fill = S + 90 * MIN
    const rs = readings(S - 10 * MIN, S + 8 * H, t => (t >= fill ? { fuelMl: 95_000 } : {}))
    const j = judgeAt(FALL, rs, [], fill + 3 * MIN)
    expect(j.verdict).toBe('REFUELLED')
    expect(j.reason).toMatch(/unexplained/)
  })

  it('CLEARED as settling when the dip is back within three minutes', () => {
    // The watch never raises these (it waits five minutes); the follow-up must
    // not call one a pour either.
    const rs = readings(S - 10 * MIN, S + H, t => (t >= S + 2 * MIN ? { fuelMl: 59_500 } : {}))
    const j = judgeAt(FALL, rs, [], S + 10 * MIN)
    expect(j.verdict).toBe('CLEARED')
    expect(j.reason).toMatch(/settling/)
  })

  it('a slow creep back is left open — too slow for a pour, and not proof of the gauge', () => {
    const rs = readings(S - 10 * MIN, S + 8 * H, t => ({
      fuelMl: Math.min(60_000, Math.round(40_000 + Math.max(0, t - S - 30 * MIN) / (3 * H) * 20_000)),
    }))
    const j = judgeAt(FALL, rs, [], S + 8 * H)
    expect(j.verdict).toBe('UNRESOLVED')
    expect(j.reason).toMatch(/crept back slowly/)
  })
})

describe('parked-fall — a unit judged on its engine-hours counter', () => {
  it('back-dates the start by what the counter advanced', () => {
    const fall: PendingFall = { ...FALL, engineEvidence: 'counter' }
    const start = S + 3 * H
    // The counter only shows the run five minutes in, having advanced 0.08 h.
    const rs = readings(S - 10 * MIN, start + WORK_WINDOW_MS + 10 * MIN, t => ({
      ignitionKnown: false,
      meterH: t < start + 5 * MIN ? 100 : 100 + (t - start) / H,
      fuelMl: t < start ? 40_000 : Math.round(40_000 - ((t - start) / H) * 5_000),
    }))
    const j = judgeAt(fall, rs, [], start + WORK_WINDOW_MS + 10 * MIN)
    expect(j.verdict).toBe('CONFIRMED')
    expect(j.nextStartBy).toBe('engine')
    expect(j.nextStartAt).toBe(start + 5 * MIN)
  })
})

describe('parked-fall — the frozen probe (MUFINDI : MTR 18, 26 Sep)', () => {
  const at = (h: number) => S + h * H
  const hourly = (from: number, to: number, f: (t: number) => Partial<FallReading>) =>
    readings(at(from), at(to), f).filter((_, i) => i % 5 === 0)

  it('flags a level that held to the millilitre through hours of work', () => {
    // Frozen at 46.3 L from 04:56 to 11:10 while the tractor worked ~2.5 h.
    const rows = hourly(0, 6, t => ({ fuelMl: 46_300, engineOn: t < at(4), speedKmh: t < at(4) ? 12 : 0 }))
    const r = probeFrozeWhileRunning(rows)
    expect(r.frozen).toBe(true)
    expect(r.heldMl).toBe(46_300)
  })

  it('does not flag a level that falls as the machine works', () => {
    const rows = hourly(0, 4, t => ({ engineOn: true, fuelMl: Math.round(80_000 - ((t - S) / H) * 8_000) }))
    expect(probeFrozeWhileRunning(rows).frozen).toBe(false)
  })

  it('does not flag a steady level on a parked machine', () => {
    expect(probeFrozeWhileRunning(hourly(0, 6, () => ({ fuelMl: 46_300 }))).frozen).toBe(false)
  })

  it('reads the engine-hours counter where the unit has no ignition line', () => {
    const rows = hourly(0, 3, t => ({ fuelMl: 46_300, ignitionKnown: false, meterH: 900 + (t - S) / H }))
    expect(probeFrozeWhileRunning(rows).frozen).toBe(true)
  })
})

describe('parked-fall — stands and the accelerometer', () => {
  it('ends a stand on movement and on a new spot', () => {
    const rs = readings(S, S + 40 * MIN, t => (t < S + 10 * MIN ? { ...A } : t < S + 20 * MIN ? { ...B, speedKmh: 30 } : t < S + 30 * MIN ? { ...B } : { ...C }))
    expect(standsOf(rs).map(s => [s.from, s.to])).toEqual([
      [S, S + 9 * MIN], [S + 20 * MIN, S + 29 * MIN], [S + 30 * MIN, S + 40 * MIN],
    ])
  })

  it('ends a stand on a long silence when there is no position to vouch for it', () => {
    const rs = [...readings(S, S + 5 * MIN, () => ({})), ...readings(S + 40 * MIN, S + 45 * MIN, () => ({}))]
    expect(standsOf(rs)).toHaveLength(2)
  })

  it('reads the angle as the median of each axis, and work as the spread', () => {
    const still = readings(S, S + 5 * MIN, () => ({ accel: { x: 0.1, y: -0.05, z: 0.02 } }))
    expect(attitudeOf(still)).toEqual([0.1, -0.05, 0.02])
    expect(vibrationOf(still)).toBe(0)
    const digging = readings(S, S + 5 * MIN, t => ({ accel: { x: (t / MIN) % 2 ? 0.3 : -0.3, y: 0, z: 0 } }))
    expect(vibrationOf(digging)!).toBeGreaterThan(0.2)
    expect(attitudeOf(readings(S, S + 5 * MIN, () => ({ accel: null })))).toBeNull()
  })
})

describe('parked-fall — stage one helpers', () => {
  it('counts a counter as tracking the engine when it runs while the machine stands', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ t: S + i * MIN, speedKmh: 0, meterH: 500 + i / 60 }))
    expect(counterTracksEngine(rows).trusted).toBe(true)
  })

  it('does not trust a counter that only moves with the wheels', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ t: S + i * MIN, speedKmh: i % 2 ? 20 : 0, meterH: 500 + Math.floor(i / 2) / 60 }))
    // Every advance lands on an interval with a moving end.
    expect(counterTracksEngine(rows).trusted).toBe(false)
  })

  it('does not trust a counter that never moves', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ t: S + i * MIN, speedKmh: 0, meterH: 500 }))
    expect(counterTracksEngine(rows).trusted).toBe(false)
  })

  it('ignores a counter stepping further than the elapsed time allows', () => {
    const rows = [{ t: S, speedKmh: 0, meterH: 500 }, { t: S + MIN, speedKmh: 0, meterH: 510 }]
    expect(counterTracksEngine(rows).advancedH).toBe(0)
  })

  it('reads a trough at or near empty as the probe dropping out', () => {
    expect(probeReadsEmpty(0, 350)).toBe(true)          // MUFINDI: EX 07, 281 L → 0 L
    expect(probeReadsEmpty(4_000, null)).toBe(true)
    expect(probeReadsEmpty(40_000, 1_631)).toBe(true)   // under 3% of a 1,631 L tank
    expect(probeReadsEmpty(210_000, 385)).toBe(false)   // CTR 12's trough
  })

  it('stays down until the level is back within 30% of the drop', () => {
    expect(stillDown(40_000, 20_000, [40_100, 40_000, 40_200])).toBe(true)
    expect(stillDown(40_000, 20_000, [55_000, 56_000, 55_500])).toBe(false)
    expect(stillDown(40_000, 20_000, [])).toBe(true)
  })
})
