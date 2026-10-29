import { describe, it, expect } from 'vitest'
import {
  standingTheft, standingTheftText, STANDING_FALL_MIN_ML, STEADY_FALL_MIN_ML, type StandingTheftInput,
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
  spanFrom: eat('06:46:29'), spanTo: eat('06:46:29') + 1_045_000, tankCapacityL: 600,
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
    expect(standingTheft(kde(), KDE_SPAN)?.rule).toBe('fell-after-refuel')
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
const SPAN: StandingTheftInput = { spanFrom: T0 + 9 * MIN, spanTo: T0 + 20 * MIN, tankCapacityL: 400 }

/** An idling tracker: tiny wobble about a fixed pose. */
const idling = (k: number) => ({ x: 0.10 + ((k % 3) - 1) * 0.004, y: -0.02 + ((k % 2) ? 0.003 : -0.003), z: 0.98 })
/** A machine working in place: ten times that. */
const working = (k: number) => ({ x: 0.10 + ((k % 3) - 1) * 0.08, y: -0.02 + ((k % 2) ? 0.06 : -0.06), z: 0.98 })

describe('standingTheft — the rules', () => {
  it('calls a drain that fell standing, engine off, with no refuel, whatever the classifier made of it', () => {
    expect(standingTheft(stand(), SPAN)).toMatchObject({
      rule: 'fell-while-standing', engine: 'off', beforeMl: 200_000, afterMl: 180_000, fallMl: 20_000, refuel: null,
    })
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

  it('reads a step at a change of angle as the tilt, never as fuel', () => {
    // A jack, a load, a suspension settling: 0.05 g is about 3°, and on the
    // Mufindi plant ~0.06 g moved the reading ~30 L with the same fuel in it.
    // The gauge steps 20 L as the angle changes and is flat either side.
    const tilting = (_k: number, t: number) => ({ x: t < T0 + 11 * MIN ? 0.10 : 0.15, y: -0.02, z: 0.98 })
    const stepped = stand({ accel: tilting }).map(r => r.speedKmh ? r : { ...r, fuelMl: r.t < T0 + 11 * MIN ? 200_000 : 180_000 })
    expect(standingTheft(stepped, SPAN)).toBeNull()
  })

  it('measures a fall on each side of a change of angle, at that angle only', () => {
    // The angle changes at 11 min, part-way down: the 13 L that fell after it,
    // at the new angle, is still called; the tilt itself is not counted.
    const tilting = (_k: number, t: number) => ({ x: t < T0 + 11 * MIN ? 0.10 : 0.15, y: -0.02, z: 0.98 })
    const s = standingTheft(stand({ accel: tilting }), SPAN)
    expect(s).toMatchObject({ rule: 'fell-while-standing', engine: 'off' })
    expect(s!.fallMl).toBeLessThan(20_000)
  })

  it('ignores a fall under 5 L, a slow one, a fall that came back, and a trough at empty', () => {
    expect(STANDING_FALL_MIN_ML).toBe(10_000)
    expect(STEADY_FALL_MIN_ML).toBe(5_000)
    expect(standingTheft(stand({ to: 196 }), SPAN)).toBeNull()
    expect(standingTheft(stand({ to: 192 }), SPAN)).not.toBeNull()   // 8 L in 3 min
    // 6 L over three hours is an idling engine or cooling diesel, not a hose.
    const slow = Array.from({ length: 361 }, (_, k): FallReading => ({
      t: T0 + k * 30_000, fuelMl: 200_000 - Math.round(k / 360 * 6_000), speedKmh: 0, engineOn: false, ignitionKnown: true, meterH: null,
    }))
    expect(standingTheft(slow, { ...SPAN, spanTo: T0 + 180 * MIN })).toBeNull()
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
    expect(standingTheft(jumpy, SPAN)).toBeNull()
  })
})

// ── MUFINDI: FTT 05, 29 Oct 2026 ────────────────────────────────────────────

/**
 * As stored: time (EAT), litres, km/h, lat, lng, accelerometer x/y/z (g).
 * Ignition measured ON on every reading (the engine idled; external power held
 * ~27.7 V). Parked on the R324 from 09:16; shuffled ~40 m at 09:29 and ~10 m
 * at 09:34 (the tilt lifted the gauge to 303.4 L), then fell 303.4 → 294.5 L
 * at one angle by 09:43:10; a ~10 m shuffle at 09:43 tilted it back (291.1 L);
 * drove off at 09:50. Wialon filed 12.35 L from 09:36:33; the classifier
 * measured 20.5 L over 2,867 s that ran into 3.8 km of driving, and left it
 * INDETERMINATE.
 */
const FTT_05: Array<[string, number, number, number, number, number, number, number]> = [
  ['09:14:16', 302.8, 6, -3.82982, 30.60624, -0.077, 0.037, 0.032], ['09:14:31', 302.8, 8, -3.82958, 30.60632, -0.097, 0.09, -0.056],
  ['09:15:01', 309.3, 7, -3.82908, 30.60640, -0.137, 0.105, -0.01], ['09:15:31', 309.3, 8, -3.82852, 30.60646, -0.103, 0.15, -0.031],
  ['09:16:01', 300.5, 0, -3.82840, 30.60658, -0.034, -0.116, 0.019], ['09:16:30', 300.6, 0, -3.82833, 30.60644, 0.018, -0.063, 0.022],
  ['09:17:00', 300.2, 0, -3.82833, 30.60644, 0.009, -0.05, 0.021], ['09:17:41', 300.2, 0, -3.82833, 30.60644, 0.039, -0.06, 0.013],
  ['09:18:11', 300.1, 0, -3.82833, 30.60644, 0.027, -0.061, 0.021], ['09:18:41', 300.2, 0, -3.82833, 30.60644, 0.022, -0.052, 0.006],
  ['09:19:11', 300.2, 0, -3.82833, 30.60644, 0.03, -0.054, 0.02], ['09:19:41', 300.2, 0, -3.82833, 30.60644, 0.014, -0.058, 0.031],
  ['09:20:11', 300.2, 0, -3.82833, 30.60644, 0.023, -0.063, 0.017], ['09:20:41', 300.2, 0, -3.82833, 30.60644, 0.041, -0.062, 0.009],
  ['09:21:14', 300.1, 0, -3.82833, 30.60644, 0.036, -0.062, 0.017], ['09:21:44', 300.1, 0, -3.82833, 30.60644, 0.036, -0.057, 0.018],
  ['09:22:14', 300.3, 0, -3.82833, 30.60644, 0.028, -0.049, 0.017], ['09:22:44', 300.2, 0, -3.82833, 30.60644, 0.018, -0.064, 0.013],
  ['09:23:14', 300.2, 0, -3.82833, 30.60644, 0.019, -0.067, 0.008], ['09:23:44', 300.2, 0, -3.82833, 30.60644, 0.027, -0.063, 0.005],
  ['09:24:14', 300.1, 0, -3.82833, 30.60644, 0.029, -0.052, 0.023], ['09:24:44', 300.1, 0, -3.82833, 30.60644, 0.03, -0.054, 0.018],
  ['09:25:14', 300.1, 0, -3.82833, 30.60644, 0.036, -0.045, 0.014], ['09:25:44', 300.1, 0, -3.82833, 30.60644, 0.035, -0.067, 0.019],
  ['09:26:14', 300.2, 0, -3.82833, 30.60644, 0.018, -0.054, 0.016], ['09:26:44', 300.1, 0, -3.82833, 30.60644, 0.02, -0.056, 0.015],
  ['09:27:14', 300.1, 0, -3.82833, 30.60644, 0.035, -0.058, 0.013], ['09:27:44', 300.1, 0, -3.82833, 30.60644, 0.033, -0.044, 0.018],
  ['09:28:14', 299.8, 0, -3.82833, 30.60644, 0.022, -0.061, 0.022], ['09:28:44', 300.0, 0, -3.82833, 30.60644, 0.033, -0.053, 0.02],
  ['09:29:03', 300.0, 5, -3.82831, 30.60642, -0.042, -0.102, 0.011], ['09:29:38', 300.1, 0, -3.82830, 30.60640, -0.057, -0.085, 0.083],
  ['09:30:08', 299.4, 0, -3.82807, 30.60617, 0.043, -0.102, 0.061], ['09:30:39', 298.9, 0, -3.82799, 30.60607, 0.037, -0.114, 0.018],
  ['09:31:01', 298.8, 0, -3.82799, 30.60607, 0.067, -0.117, 0.014], ['09:31:21', 298.7, 0, -3.82799, 30.60607, 0.055, -0.134, 0.015],
  ['09:32:02', 298.7, 0, -3.82799, 30.60607, 0.062, -0.115, 0.014], ['09:32:32', 298.6, 0, -3.82799, 30.60607, 0.066, -0.11, 0.003],
  ['09:33:02', 298.5, 0, -3.82799, 30.60607, 0.076, -0.124, 0.003], ['09:33:32', 298.7, 0, -3.82799, 30.60607, 0.045, -0.132, 0.003],
  ['09:34:02', 298.6, 0, -3.82799, 30.60607, 0.04, -0.13, 0.004], ['09:34:14', 299.1, 7, -3.82803, 30.60610, 0.077, -0.11, 0.086],
  ['09:34:49', 300.1, 0, -3.82807, 30.60612, -0.183, -0.233, -0.028], ['09:35:04', 303.4, 0, -3.82807, 30.60612, -0.183, -0.21, -0.02],
  ['09:35:24', 303.4, 0, -3.82807, 30.60612, -0.184, -0.214, -0.024], ['09:35:54', 303.4, 0, -3.82807, 30.60612, -0.211, -0.222, -0.02],
  ['09:36:33', 303.4, 0, -3.82807, 30.60612, -0.182, -0.213, -0.019], ['09:37:08', 300.4, 0, -3.82807, 30.60612, -0.186, -0.203, -0.025],
  ['09:37:25', 300.0, 0, -3.82807, 30.60612, -0.179, -0.2, -0.033], ['09:38:02', 299.2, 0, -3.82807, 30.60612, -0.191, -0.208, -0.032],
  ['09:38:32', 298.9, 0, -3.82807, 30.60612, -0.163, -0.212, -0.021], ['09:39:14', 297.7, 0, -3.82807, 30.60612, -0.164, -0.221, -0.015],
  ['09:39:40', 297.4, 0, -3.82807, 30.60612, -0.149, -0.221, -0.018], ['09:40:10', 297.1, 0, -3.82807, 30.60612, -0.165, -0.221, -0.013],
  ['09:40:40', 296.4, 0, -3.82807, 30.60612, -0.163, -0.21, -0.014], ['09:41:10', 296.2, 0, -3.82807, 30.60612, -0.168, -0.212, -0.026],
  ['09:41:40', 295.6, 0, -3.82807, 30.60612, -0.156, -0.222, -0.018], ['09:41:55', 295.6, 0, -3.82807, 30.60612, -0.173, -0.225, -0.021],
  ['09:42:25', 295.0, 0, -3.82801, 30.60606, -0.167, -0.221, -0.011], ['09:43:10', 294.5, 3, -3.82808, 30.60609, -0.145, -0.216, -0.031],
  ['09:43:36', 291.1, 0, -3.82815, 30.60616, -0.019, -0.138, 0.003], ['09:44:06', 291.1, 0, -3.82815, 30.60616, -0.036, -0.148, 0.013],
  ['09:44:36', 291.1, 0, -3.82815, 30.60616, -0.023, -0.133, 0.022], ['09:45:06', 291.1, 0, -3.82815, 30.60616, -0.018, -0.143, 0.017],
  ['09:45:36', 291.1, 0, -3.82815, 30.60616, -0.015, -0.138, 0.012], ['09:46:06', 291.0, 0, -3.82815, 30.60616, -0.008, -0.143, 0.009],
  ['09:46:36', 291.0, 0, -3.82815, 30.60616, -0.019, -0.142, -0.001], ['09:47:06', 291.0, 0, -3.82815, 30.60616, -0.019, -0.137, 0],
  ['09:47:36', 290.9, 0, -3.82815, 30.60616, -0.025, -0.13, 0.009], ['09:48:01', 291.1, 0, -3.82815, 30.60616, -0.025, -0.111, -0.017],
  ['09:48:28', 291.2, 0, -3.82817, 30.60620, 0, -0.068, 0.02], ['09:48:44', 291.5, 0, -3.82817, 30.60620, -0.007, -0.063, 0.016],
  ['09:49:14', 291.5, 0, -3.82817, 30.60620, -0.024, -0.067, 0.009], ['09:49:44', 291.5, 0, -3.82817, 30.60620, -0.01, -0.048, 0.008],
  ['09:50:08', 291.4, 0, -3.82817, 30.60620, -0.004, -0.066, 0.016], ['09:50:32', 291.5, 0, -3.82817, 30.60620, -0.022, -0.051, 0.022],
  ['09:50:48', 291.5, 0, -3.82817, 30.60620, -0.012, -0.054, 0.015], ['09:50:54', 291.5, 8, -3.82818, 30.60623, 0.055, -0.022, 0.19],
  ['09:51:14', 291.0, 11, -3.82866, 30.60641, 0.167, -0.133, -0.017], ['09:51:44', 290.9, 0, -3.82921, 30.60638, 0.141, -0.15, 0.003],
  ['09:52:01', 290.6, 0, -3.82921, 30.60638, 0.159, -0.142, 0.016], ['09:52:23', 290.6, 0, -3.82921, 30.60638, 0.152, -0.153, -0.002],
  ['09:53:01', 290.6, 0, -3.82921, 30.60638, 0.143, -0.144, 0.001], ['09:53:31', 290.6, 0, -3.82921, 30.60638, 0.123, -0.138, 0],
  ['09:54:00', 290.7, 0, -3.82921, 30.60638, 0.152, -0.151, -0.003], ['09:54:15', 290.7, 0, -3.82921, 30.60638, 0.145, -0.142, 0.028],
  ['09:54:33', 290.6, 0, -3.82921, 30.60638, 0.129, -0.14, 0.004], ['09:54:38', 290.6, 8, -3.82923, 30.60638, 0.072, -0.06, 0.224],
  ['09:55:08', 290.6, 23, -3.83027, 30.60590, 0.064, -0.012, 0.107], ['09:55:28', 293.6, 16, -3.83066, 30.60513, 0.009, -0.085, 0.076],
  ['09:55:58', 291.7, 27, -3.83252, 30.60498, -0.151, -0.011, 0.501],
]
const ftt = (): FallReading[] => FTT_05.map(([hms, L, kmh, lat, lng, x, y, z]) => ({
  t: Date.parse(`2026-10-29T${hms}+03:00`), fuelMl: Math.round(L * 1000), speedKmh: kmh,
  engineOn: true, ignitionKnown: true, meterH: 73.57, lat, lng, accel: { x, y, z },
}))
const FTT_SPAN: StandingTheftInput = {
  spanFrom: Date.parse('2026-10-29T09:36:33+03:00'), spanTo: Date.parse('2026-10-29T09:36:33+03:00') + 2_867_000, tankCapacityL: 325,
}

describe('standingTheft — MUFINDI: FTT 05, 29 Oct', () => {
  it('calls the fall at one angle with the engine idling, shuffles and all', () => {
    const s = standingTheft(ftt(), FTT_SPAN)
    expect(s).toMatchObject({ rule: 'fell-while-standing', engine: 'idling-still', refuel: null })
    expect(s!.beforeMl).toBe(303_400)
    expect(s!.fallMl).toBeGreaterThan(7_500)
    expect(s!.fallMl).toBeLessThan(9_500)
    expect(s!.vibrationG).toBeLessThan(0.04)
  })

  it('makes no call when the same lorry is working in place rather than idling', () => {
    const shaken = ftt().map((r, k) => ({ ...r, accel: { x: r.accel!.x! + ((k % 2) ? 0.08 : -0.08), y: r.accel!.y, z: r.accel!.z } }))
    expect(standingTheft(shaken, FTT_SPAN)).toBeNull()
  })

  it('states what left the tank, less what the idling engine burnt', () => {
    const gross = standingTheft(ftt(), FTT_SPAN)!
    const clean = standingTheft(ftt(), { ...FTT_SPAN, idleLph: 3 })!
    expect(gross.burnMl).toBe(0)
    // 3 L/h across the fall's own minutes, and not a millilitre more.
    expect(clean.burnMl).toBe(Math.round(3_000 * (clean.toT - clean.fromT) / 3_600_000))
    expect(clean.fallMl).toBe(gross.fallMl - clean.burnMl)
    expect(standingTheftText('MUFINDI: FTT 05', clean, ''))
      .toMatch(/; \d+(\.\d)? L left the tank beyond the 0\.\d L the engine burnt idling$/)
  })

  it('takes nothing off a fall with the engine off', () => {
    const off = ftt().map(r => ({ ...r, engineOn: false }))
    const s = standingTheft(off, { ...FTT_SPAN, idleLph: 3 })
    if (s) expect(s.burnMl).toBe(0)
  })
})
