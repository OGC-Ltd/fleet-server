import { describe, it, expect } from 'vitest'
import {
  adjudicateDrain, SETTLE_MINUTES, RECOVERY_THRESHOLD,
  type LevelSample,
} from '../../src/modules/fuel/fuel-adjudication.js'

const T = (iso: string) => new Date(iso)
const BEGAN    = T('2026-08-04T13:00:00Z')
const DETECTED = T('2026-08-04T13:05:00Z')
const RIPE     = T('2026-08-04T13:40:00Z')   // well past the settle window

/** Level series in millilitres at one-minute steps from `startIso`. */
const series = (startIso: string, mls: number[]): LevelSample[] =>
  mls.map((fuelLevelMl, i) => ({
    capturedAt: new Date(T(startIso).getTime() + i * 60_000),
    fuelLevelMl,
  }))

/**
 * A run spanning the whole event: six readings before it starts (12:55-13:00),
 * five across the drain (13:01-13:05), and five after detection (13:06-13:10).
 * The series MUST reach past `detectedAt` or there is nothing to judge a
 * recovery from — which is exactly what `insufficient-telemetry` reports.
 */
const window = (during: number[], after: number[]) =>
  series('2026-08-04T12:55:00Z', [200_000, 200_000, 200_000, 200_000, 200_000, 200_000, ...during, ...after])

const STEADY_DRAIN = [180_000, 170_000, 160_000, 160_000, 160_000]

const claim = { beganAt: BEGAN, detectedAt: DETECTED, stolenMl: 40_000 }

describe('adjudicateDrain', () => {
  it('holds its judgement until the settle window has passed', () => {
    // Judging early is how a loss gets confirmed that was about to come back.
    const tooSoon = new Date(DETECTED.getTime() + (SETTLE_MINUTES - 1) * 60_000)
    const out = adjudicateDrain(claim, window(STEADY_DRAIN, [200_000, 200_000, 200_000, 200_000]), null, tooSoon)
    expect(out.verdict).toBe('PENDING')
    expect(out.reason).toBe('settling')
  })

  it('calls it redistribution when the level comes back', () => {
    // The operator's case: parked on a slope, fuel moves off the probe, the
    // level reads low, then returns. 40 L "lost", all of it back.
    // before: steady at 200 L · the "drain" · and back again
    const samples = window(STEADY_DRAIN, [190_000, 198_000, 200_000, 200_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('REDISTRIBUTION')
    expect(out.reason).toBe('level-recovered')
    expect(out.recoveredMl).toBe(40_000)
  })

  it('calls it a drain when the level stays down', () => {
    // gone, and staying gone
    const samples = window(STEADY_DRAIN, [160_000, 159_000, 158_000, 158_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('DRAIN')
    expect(out.reason).toBe('level-stayed-down')
  })

  it('does not credit a partial rise below the threshold', () => {
    // Only ~25% back — consumption noise, not the tank refilling itself.
    const samples = window(STEADY_DRAIN, [170_000, 170_000, 170_000, 170_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('DRAIN')
    expect((out.recoveredMl ?? 0) / 40_000).toBeLessThan(RECOVERY_THRESHOLD)
  })

  it('does not call a drop a refill just because a filling closed the window', () => {
    // A rise after a real refuel proves nothing either way, so the claim
    // stands — labelled unchecked rather than silently confirmed.
    // The filling lands at 13:06, one minute after detection, so nothing after
    // it can speak to a recovery and there is too little before it.
    const samples = window(STEADY_DRAIN, [200_000, 200_000, 200_000, 200_000])
    const out = adjudicateDrain(claim, samples, T('2026-08-04T13:06:00Z'), RIPE)
    // Never REFILL. This is an ABSENCE of evidence — we cannot tell "the drop
    // was spurious and they refuelled" from "fuel was taken and then they
    // refuelled" — and on an oscillating probe the filling that closed the
    // window is itself noise. MUFINDI - EX 22 ran -21.7, +29.1, +24.8, -27.7,
    // +28.2 L inside four minutes and the -27.7 came out a REFILL, drawn green
    // on the dashboard against a negative volume.
    expect(out.verdict).toBe('DRAIN')
    expect(out.confirmed).toBe(false)
    expect(out.reason).toBe('filling-too-soon')
  })

  it('does not claim confirmation when telemetry is sparse', () => {
    // 38% of KASULU's and 57% of SUKARI's claimed loss volume lands here.
    const samples = series('2026-08-04T12:59:00Z', [200_000, 160_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('DRAIN')
    expect(out.confirmed).toBe(false)
    expect(out.reason).toBe('insufficient-telemetry')
  })

  it('does not confirm when a few millilitres of noise stand in for a 40 L claim', () => {
    // The KTCC 850B case of 2026-08-07: ruled REDISTRIBUTION on 19 ml recovered
    // against a 25.8 L claim, because the recovery ratio was measured against a
    // drop our series barely saw. A wobble that settles is not proof that
    // 40 litres came back — it is proof we never saw 40 litres leave.
    const samples = window(
      [199_970, 199_970, 199_970, 199_970, 199_970],   // a 30 ml dip
      [200_000, 200_000, 200_000, 200_000],            // fully "recovered"
    )
    const out = adjudicateDrain(claim, samples, null, RIPE)   // claim is 40 L
    expect(out.verdict).toBe('DRAIN')
    expect(out.confirmed).toBe(false)
    expect(out.reason).toBe('drop-not-observed')
    // Nothing is written off on evidence this thin.
    expect(out.recoveredMl).toBeNull()
  })

  it('still judges a drop that is merely smaller than claimed, not absent', () => {
    // The guard must not swallow the ordinary case. Wialon and our own series
    // measure over different windows, so they disagree by degrees all the time;
    // 30 L observed against a 40 L claim is the same event, not a different one.
    const samples = window(
      [185_000, 175_000, 170_000, 170_000, 170_000],   // 30 L down, over half the claim
      [200_000, 200_000, 200_000, 200_000],            // and back
    )
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('REDISTRIBUTION')
    expect(out.reason).toBe('level-recovered')
  })

  it('does not confirm when our own series never saw the level fall', () => {
    // The two sources disagree about what happened. That is not evidence of a
    // recovery — it is a reason not to claim one.
    const samples = window([200_000, 200_000, 200_000, 200_000, 200_000], [200_000, 200_000, 200_000, 200_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('DRAIN')
    expect(out.confirmed).toBe(false)
    expect(out.reason).toBe('no-drop-observed')
  })

  // ── single-sample noise ───────────────────────────────────────────────────
  //
  // Every quantity the verdict rests on is an extremum, so one bad reading used
  // to set it. Live telemetry makes ~5 L single-ping jumps at the 99th
  // percentile on a probe whose median step is 0 ml, so this is the ordinary
  // case and not a contrived one.

  it('does not write off a drain on one spuriously high reading afterwards', () => {
    // The expensive direction, and the reason this filter exists. The level
    // stays down — a real loss — but one glitch reads full. Ungated, that sets
    // `peakAfter`, the recovery ratio clears the threshold, and the drain is
    // reclassified REDISTRIBUTION: the ONE verdict that leaves the loss figures.
    const samples = window(STEADY_DRAIN, [160_000, 200_000, 160_000, 159_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('DRAIN')
    expect(out.reason).toBe('level-stayed-down')
  })

  it('does not invent a drop from one spuriously low reading', () => {
    // The mirror image: nothing happened, but a single dropout reads near-empty
    // during the window. That fabricates a 160 L drop out of a steady tank.
    const samples = window([200_000, 40_000, 200_000, 200_000, 200_000],
                           [200_000, 200_000, 200_000, 200_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('DRAIN')
    expect(out.confirmed).toBe(false)
    expect(out.reason).toBe('no-drop-observed')
  })

  it('does not inflate the baseline from one spike before the drain', () => {
    // A high spike in the before-window exaggerates the drop, which flatters
    // the observed-vs-claimed ratio and shrinks the measured recovery.
    const before = series('2026-08-04T12:55:00Z',
      [200_000, 260_000, 200_000, 200_000, 200_000, 200_000])
    const samples = [...before, ...series('2026-08-04T13:01:00Z',
      [...STEADY_DRAIN, 200_000, 200_000, 200_000, 200_000])]
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('REDISTRIBUTION')
    expect(out.recoveredMl).toBe(40_000)   // the real 40 L, not 100 L
  })

  it('still sees a drop that lasts two readings', () => {
    // The filter must not be so wide that it erases short drains. SUKARI's
    // median drain is 2.3 minutes at a ~30 s ping, so anything sustained for
    // two readings has to survive intact.
    const samples = window([200_000, 200_000, 200_000, 160_000, 160_000],
                           [160_000, 160_000, 159_000, 158_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('DRAIN')
    expect(out.reason).toBe('level-stayed-down')
  })

  // ── a dead fuel probe ─────────────────────────────────────────────────────
  //
  // 37 of 298 probes sit at exactly zero, and five fell to zero inside one day
  // from as high as 256 L. One reached the ledger: KDL 182X, 55 L "stolen",
  // 55 L -> 0 L on 2026-08-07. Confirmed as a DRAIN it would have named a driver
  // for a theft that never happened.

  const running  = (s: LevelSample): LevelSample => ({ ...s, engineOn: true })
  const stopped  = (s: LevelSample): LevelSample => ({ ...s, engineOn: false })

  it('ignores a probe that reads zero for the whole window', () => {
    // The window opens 30 min BEFORE the drain, so zero throughout means the
    // tank read empty before the "theft" began — there was nothing to take.
    // No engine evidence needed: this is not a claim about the machine.
    const samples = window([0, 0, 0, 0, 0], [0, 0, 0, 0])
      .map(s => ({ ...s, fuelLevelMl: 0 }))
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('SENSOR_FAULT')
    expect(out.reason).toBe('fsl-dead')
  })

  it('ignores a probe stuck on one value while the engine runs', () => {
    // A working machine burns fuel. A gauge that never moves is not reading it.
    const samples = window([200_000, 200_000, 200_000, 200_000, 200_000],
                           [200_000, 200_000, 200_000, 200_000]).map(running)
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('SENSOR_FAULT')
    expect(out.reason).toBe('fsl-dead')
  })

  it('does not call a parked vehicle a dead probe', () => {
    // A steady level with the engine OFF is the normal case, not a fault — it
    // must still come back as "we never saw the level fall".
    const samples = window([200_000, 200_000, 200_000, 200_000, 200_000],
                           [200_000, 200_000, 200_000, 200_000]).map(stopped)
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('DRAIN')
    expect(out.confirmed).toBe(false)
    expect(out.reason).toBe('no-drop-observed')
  })

  it('blames the probe, not the driver, when the level flatlines at zero with the engine running', () => {
    // An engine cannot run on an empty tank. If the readings are zero while the
    // machine is still turning, the probe is what failed.
    const samples = window([200_000, 0, 0, 0, 0], [0, 0, 0, 0]).map(running)
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('SENSOR_FAULT')
    expect(out.reason).toBe('fsl-dropout')
    expect(out.recoveredMl).toBeNull()
  })

  it('does NOT excuse a tank genuinely drained to empty', () => {
    // The most serious theft there is looks identical in the level series. What
    // separates it is that the engine stops — so with no engine running at
    // zero, this must still be judged on the level alone.
    const samples = window([200_000, 0, 0, 0, 0], [0, 0, 0, 0]).map(stopped)
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).not.toBe('SENSOR_FAULT')
    expect(out.verdict).toBe('DRAIN')
  })

  it('stays silent when the provider sent no engine state at all', () => {
    // Conservative on purpose: with no evidence either way it risks calling a
    // sensor fault a loss, not a loss a sensor fault.
    const samples = window([200_000, 0, 0, 0, 0], [0, 0, 0, 0])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).not.toBe('SENSOR_FAULT')
  })

  it('does not call a partial drop a dropout', () => {
    // The rule is for readings pinned at ZERO. A tank that fell to 160 L is a
    // drain to be judged normally, engine running or not.
    const samples = window(STEADY_DRAIN, [160_000, 159_000, 158_000, 158_000]).map(running)
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('DRAIN')
    expect(out.reason).toBe('level-stayed-down')
  })

  it('never reports more recovered than was lost', () => {
    // MUFINDI: DZ 13 measured 134% back — the level overshot its own baseline.
    // The excess is not recovered fuel and must not be recorded as such.
    const samples = window(STEADY_DRAIN, [215_000, 215_000, 215_000, 215_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('REDISTRIBUTION')
    expect(out.recoveredMl).toBe(40_000)   // the drop, not the overshoot
  })
})

describe('adjudicateDrain — the trough is the lowest point AFTER the drain, not just during it', () => {
  const BEGAN = new Date('2026-08-10T14:37:00Z')
  const DET   = new Date('2026-08-10T14:50:00Z')
  const NOW   = new Date('2026-08-10T16:00:00Z')
  /** Readings every 3 minutes from 14:10. */
  const at = (i: number) => new Date(Date.parse('2026-08-10T14:10:00Z') + i * 180_000)
  const series = (mls: number[]) => mls.map((fuelLevelMl, i) => ({ capturedAt: at(i), fuelLevelMl }))

  it('confirms a drain whose fall starts after the provider closed its window', () => {
    // MUFINDI - EX 09, 2026-08-10. Wialon claimed 220 -> 199 L between 14:37
    // and 14:50; the level had barely moved by 14:50 and then fell 21 L and
    // stayed down for half an hour, parked with the engine off. Measuring the
    // trough inside the claim's own window scored that as a 1 L drop and threw
    // the whole thing out as `drop-not-observed`.
    const out = adjudicateDrain(
      { beganAt: BEGAN, detectedAt: DET, stolenMl: 21_400 },
      series([
        213_500, 211_000, 218_200, 220_700, 221_700, 220_500,   // 14:10–14:25, baseline
        220_100, 219_400,                                        // through the claim window
        212_700, 203_700, 199_100, 199_100, 199_100, 198_900,    // the real fall, after it
        198_800, 198_800, 198_700,
      ]),
      null, NOW,
    )
    expect(out).toMatchObject({ verdict: 'DRAIN', reason: 'level-stayed-down', confirmed: true })
  })

  it('does not read a late fall as a recovery', () => {
    // The trap the wider search opens: peak 200 before the fall, trough 150
    // after it, and a recovery ratio of 1.0 off a level that never came back.
    // The peak must be measured from the low point onward.
    const out = adjudicateDrain(
      { beganAt: BEGAN, detectedAt: DET, stolenMl: 50_000 },
      series([
        200_000, 200_000, 200_000, 200_000, 200_000, 200_000,
        200_000, 200_000,
        200_000, 200_000, 190_000, 170_000, 150_000, 150_000,
        150_000, 150_000, 150_000,
      ]),
      null, NOW,
    )
    expect(out.verdict).toBe('DRAIN')
    expect(out.confirmed).toBe(true)
  })
})
