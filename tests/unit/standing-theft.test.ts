import { describe, it, expect } from 'vitest'
import {
  standingTheft, standingTheftText, STANDING_FALL_MIN_ML, type StandingTheftInput,
} from '../../src/modules/fuel/standing-theft.js'
import type { FallReading } from '../../src/modules/fuel/parked-fall.js'

const eat = (hms: string) => Date.parse(`2026-09-27T${hms}+03:00`)

/**
 * KDE 585S at the Kabras factory pump, 27 Sep 2026, as stored: time (EAT),
 * litres, km/h, and the MEASURED ignition. Refuelled from empty to 105.7 L by
 * 06:46:38, standing with the engine off; 79.3 L at 06:50:22, still standing;
 * then driven off, the level sloshing 54–90 L. Wialon's drain began 06:46:29
 * and ran 1,045 s, and it went out as a FUEL DOWN warning.
 */
const KDE_585S: Array<[string, number, number, boolean]> = [
  ['06:28:25', 1.5, 0, false], ['06:29:11', 1.5, 0, false], ['06:32:23', 1.3, 0, false], ['06:34:07', 1.3, 0, false],
  ['06:35:19', 1.2, 0, true], ['06:35:44', 1.2, 6, true], ['06:36:03', 1.2, 9, true], ['06:36:29', 0, 9, false],
  ['06:36:56', 0, 10, false], ['06:37:31', 0, 7, false], ['06:37:33', 0, 0, false], ['06:37:49', 0, 5, false],
  ['06:37:57', 0, 4, false], ['06:38:05', 0, 0, false], ['06:38:23', 0, 0, false], ['06:38:33', 3.2, 0, false],
  ['06:39:07', 3.2, 0, false], ['06:43:07', 5.4, 0, false], ['06:43:29', 5.4, 0, false], ['06:43:47', 5.4, 6, false],
  ['06:43:55', 5.4, 5, false], ['06:44:05', 5.4, 0, false], ['06:44:21', 5.4, 0, false], ['06:44:28', 95.7, 0, true],
  ['06:44:49', 95.7, 0, true], ['06:45:13', 95.7, 0, true], ['06:45:37', 95.7, 0, true], ['06:46:07', 95.7, 0, true],
  ['06:46:19', 95.7, 4, true], ['06:46:32', 95.7, 4, true], ['06:46:38', 105.7, 0, false], ['06:46:46', 105.7, 0, false],
  ['06:47:16', 105.7, 0, false], ['06:47:48', 105.7, 0, false], ['06:50:22', 79.3, 0, false], ['06:50:24', 79.3, 0, false],
  ['06:50:30', 79.3, 7, false], ['06:50:44', 69.7, 8, false], ['06:50:52', 69.7, 0, false], ['06:51:10', 84.4, 0, true],
  ['06:51:41', 84.5, 0, true], ['06:52:12', 84.7, 0, true], ['06:52:32', 87.2, 5, true], ['06:52:56', 83.0, 11, true],
  ['06:53:35', 82.7, 12, true], ['06:54:04', 82.7, 0, true], ['06:55:21', 84.5, 0, false], ['06:57:31', 84.7, 0, false],
  ['06:57:49', 89.9, 14, false], ['06:58:20', 72.7, 20, false], ['07:00:05', 75.2, 19, false], ['07:01:53', 90.4, 24, true],
  ['07:03:09', 69.0, 16, false], ['07:03:38', 83.5, 18, false], ['07:05:13', 54.0, 23, false], ['07:08:14', 73.9, 0, false],
  ['07:09:06', 81.0, 0, false], ['07:10:58', 81.0, 0, true],
]

const kde = (over: Partial<FallReading> = {}): FallReading[] =>
  KDE_585S.map(([hms, L, kmh, on]) => ({
    t: eat(hms), fuelMl: Math.round(L * 1000), speedKmh: kmh, engineOn: on, ignitionKnown: true, meterH: null, ...over,
  }))

const KDE_SPAN: StandingTheftInput = {
  spanFrom: eat('06:46:29'), spanTo: eat('06:46:29') + 1_045_000, fuelRateOrDown: true, tankCapacityL: 600,
}

describe('standingTheft — KDE 585S, 27 Sep', () => {
  it('finds the fall at the pump inside a drain that ran on into 3.2 km of driving', () => {
    const s = standingTheft(kde(), KDE_SPAN)
    expect(s).toMatchObject({
      rule: 'fell-after-refuel', engine: 'off',
      fromT: eat('06:47:48'), toT: eat('06:50:22'),
      beforeMl: 105_700, afterMl: 79_300, fallMl: 26_400,
      refuel: { fromMl: 0, toMl: 105_700, atT: eat('06:46:38') },
      tiltShiftG: null, vibrationG: null,
    })
    expect(s!.confidence).toBeCloseTo(0.85)
  })

  it('says what the gauge did, when, and where, with the word theft only as "possible theft"', () => {
    const text = standingTheftText('KDE 585S', standingTheft(kde(), KDE_SPAN)!, ' at D267, Malava')
    expect(text).toBe(
      'POSSIBLE THEFT: KDE 585S was refuelled to 105.7 L, then its tank fell to 79.3 L between 06:47 and 06:50 '
      + 'while it stood with its engine off at D267, Malava',
    )
  })

  it('is called after a refuel whatever the classifier made of the drain', () => {
    // Its 31 Aug, 10 Sep and 18 Sep falls were filed INDETERMINATE and never announced.
    expect(standingTheft(kde(), { ...KDE_SPAN, fuelRateOrDown: false })?.rule).toBe('fell-after-refuel')
  })

  it('makes no call where the engine cannot be shown off and there is no accelerometer', () => {
    // A unit with no ignition line: engine_on is only "was it moving".
    expect(standingTheft(kde({ ignitionKnown: false }), KDE_SPAN)).toBeNull()
    // Measured ON through the fall, and nothing to say it only idled.
    expect(standingTheft(kde({ engineOn: true }), KDE_SPAN)).toBeNull()
  })

  it('belongs to its own drain only — not a fall hours away in the same window', () => {
    const later = { ...KDE_SPAN, spanFrom: eat('09:00:00'), spanTo: eat('09:20:00') }
    expect(standingTheft(kde(), later)).toBeNull()
  })
})

// ── synthetic stands, for what KDE 585S cannot show ─────────────────────────

const T0 = eat('10:00:00')
const MIN = 60_000

/**
 * A vehicle standing still for 26 minutes, a reading every 30 s: 200 L for ten
 * minutes, then down to `to` L over three, then level — and then it drives off.
 * `accel(k)` gives the accelerometer at reading k, if the unit has one.
 */
function stand(opts: {
  to?: number; engineOn?: boolean; ignitionKnown?: boolean
  accel?: (k: number, t: number) => FallReading['accel']
  comesBack?: boolean
} = {}): FallReading[] {
  const to = opts.to ?? 180
  const out: FallReading[] = []
  for (let k = 0; k <= 52; k++) {
    const t = T0 + k * 30_000
    const min = (t - T0) / MIN
    let L = min < 10 ? 200 : min < 13 ? 200 - ((200 - to) * (min - 10)) / 3 : to
    if (opts.comesBack && min >= 20) L = 199
    out.push({
      t, fuelMl: Math.round(L * 1000), speedKmh: 0,
      engineOn: opts.engineOn ?? false, ignitionKnown: opts.ignitionKnown ?? true, meterH: null,
      accel: opts.accel?.(k, t) ?? null,
    })
  }
  for (let k = 1; k <= 6; k++) {
    out.push({ t: T0 + 26 * MIN + k * 30_000, fuelMl: to * 1000, speedKmh: 30, engineOn: true, ignitionKnown: true, meterH: null })
  }
  return out
}
const SPAN: StandingTheftInput = { spanFrom: T0 + 9 * MIN, spanTo: T0 + 20 * MIN, fuelRateOrDown: true, tankCapacityL: 400 }

/** An idling tracker: tiny wobble about a fixed pose. */
const idling = (k: number) => ({ x: 0.10 + ((k % 3) - 1) * 0.004, y: -0.02 + ((k % 2) ? 0.003 : -0.003), z: 0.98 })
/** A machine working in place: ten times that. */
const working = (k: number) => ({ x: 0.10 + ((k % 3) - 1) * 0.08, y: -0.02 + ((k % 2) ? 0.06 : -0.06), z: 0.98 })

describe('standingTheft — the rules', () => {
  it('calls a FUEL RATE / FUEL DOWN finding that fell standing, engine off, with no refuel', () => {
    expect(standingTheft(stand(), SPAN)).toMatchObject({
      rule: 'fell-while-standing', engine: 'off', beforeMl: 200_000, afterMl: 180_000, fallMl: 20_000, refuel: null,
    })
  })

  it('does not call any other drain without a refuel before it', () => {
    expect(standingTheft(stand(), { ...SPAN, fuelRateOrDown: false })).toBeNull()
  })

  it('calls a drain with the engine RUNNING when the accelerometer shows it only idled and kept its angle', () => {
    const s = standingTheft(stand({ engineOn: true, accel: idling }), SPAN)
    expect(s).toMatchObject({ rule: 'fell-while-standing', engine: 'idling-still' })
    expect(s!.vibrationG).toBeLessThan(0.04)
    expect(s!.tiltShiftG).toBeLessThan(0.03)
    expect(standingTheftText('EX 04', s!, '')).toContain('while it stood with its engine idling, its accelerometer showing it still and level')
  })

  it('makes no call on a machine working in place, where the reading swings with the work', () => {
    expect(standingTheft(stand({ engineOn: true, accel: working }), SPAN)).toBeNull()
  })

  it('vetoes even an engine-off call when the machine changed its angle where it stood', () => {
    // A jack, a load, a suspension settling: 0.05 g is about 3°, and on the
    // Mufindi plant ~0.06 g moved the reading ~30 L with the same fuel in it.
    const tilting = (_k: number, t: number) => ({ x: t < T0 + 11 * MIN ? 0.10 : 0.15, y: -0.02, z: 0.98 })
    expect(standingTheft(stand({ accel: tilting }), SPAN)).toBeNull()
  })

  it('ignores a fall under 10 L, a fall that came back, and a trough at empty', () => {
    expect(STANDING_FALL_MIN_ML).toBe(10_000)
    expect(standingTheft(stand({ to: 192 }), SPAN)).toBeNull()
    expect(standingTheft(stand({ comesBack: true }), SPAN)).toBeNull()
    expect(standingTheft(stand({ to: 3 }), SPAN)).toBeNull()
  })

  it('asks more of a big tank: 1.5% of it, where that is more than 10 L', () => {
    // 20 L off a 1,200 L tractor tank is under 2% of the probe's range.
    expect(standingTheft(stand(), { ...SPAN, tankCapacityL: 1_200 })).not.toBeNull()   // floor 18 L
    expect(standingTheft(stand({ to: 185 }), { ...SPAN, tankCapacityL: 1_200 })).toBeNull()   // 15 L < 18 L
    expect(standingTheft(stand({ to: 185 }), { ...SPAN, tankCapacityL: 600 })).not.toBeNull()  // floor 10 L
  })

  it('makes no call on a fall while the vehicle moved', () => {
    const moving = stand().map(r => ({ ...r, speedKmh: 25 }))
    expect(standingTheft(moving, SPAN)).toBeNull()
  })

  it('does not take a probe that jumps up and straight back down for a refuel', () => {
    // KDE 868R reads 0 → 158 L → 0 several times a day: nothing went in.
    const jumpy = stand({ to: 20 }).map(r => r.t < T0 + 8 * MIN ? { ...r, fuelMl: 20_000 } : r)
    expect(standingTheft(jumpy, { ...SPAN, fuelRateOrDown: false })).toBeNull()
  })
})
