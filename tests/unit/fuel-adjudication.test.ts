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

  it('calls it a loss when the level stays down', () => {
    // gone, and staying gone
    const samples = window(STEADY_DRAIN, [160_000, 159_000, 158_000, 158_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('LOSS')
    expect(out.reason).toBe('level-stayed-down')
  })

  it('does not credit a partial rise below the threshold', () => {
    // Only ~25% back — consumption noise, not the tank refilling itself.
    const samples = window(STEADY_DRAIN, [170_000, 170_000, 170_000, 170_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('LOSS')
    expect((out.recoveredMl ?? 0) / 40_000).toBeLessThan(RECOVERY_THRESHOLD)
  })

  it('will not judge a drain a filling could explain', () => {
    // A rise after a real refuel proves nothing either way, so the claim
    // stands — labelled unchecked rather than silently confirmed.
    // The filling lands at 13:06, one minute after detection, so nothing after
    // it can speak to a recovery and there is too little before it.
    const samples = window(STEADY_DRAIN, [200_000, 200_000, 200_000, 200_000])
    const out = adjudicateDrain(claim, samples, T('2026-08-04T13:06:00Z'), RIPE)
    expect(out.verdict).toBe('UNVERIFIED')
    expect(out.reason).toBe('filling-too-soon')
  })

  it('says unverified rather than guessing when telemetry is sparse', () => {
    // 38% of KASULU's and 57% of SUKARI's claimed loss volume lands here.
    const samples = series('2026-08-04T12:59:00Z', [200_000, 160_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('UNVERIFIED')
    expect(out.reason).toBe('insufficient-telemetry')
  })

  it('says unverified when our own series never saw the level fall', () => {
    // The two sources disagree about what happened. That is not evidence of a
    // recovery — it is a reason not to claim one.
    const samples = window([200_000, 200_000, 200_000, 200_000, 200_000], [200_000, 200_000, 200_000, 200_000])
    const out = adjudicateDrain(claim, samples, null, RIPE)
    expect(out.verdict).toBe('UNVERIFIED')
    expect(out.reason).toBe('no-drop-observed')
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
