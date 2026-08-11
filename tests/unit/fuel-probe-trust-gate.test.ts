import { describe, it, expect } from 'vitest'
import {
  applyProbeTrustGate, probeSwings, MIN_SWING_WINDOWS,
  type Adjudication, type ProbeProfile,
} from '../../src/modules/fuel/fuel-adjudication.js'

const DRAIN:  Adjudication = { verdict: 'DRAIN',          recoveredMl: 1_200,  reason: 'level-stayed-down', confirmed: true }
const REDIS:  Adjudication = { verdict: 'REDISTRIBUTION', recoveredMl: 40_000, reason: 'level-recovered',   confirmed: true }
const UNSURE: Adjudication = { verdict: 'DRAIN',          recoveredMl: null,   reason: 'drop-not-observed', confirmed: false }
const REFILL: Adjudication = { verdict: 'REFILL',         recoveredMl: null,   reason: 'filling-in-window', confirmed: false }
const FAULT:  Adjudication = { verdict: 'SENSOR_FAULT',   recoveredMl: null,   reason: 'fsl-dead',          confirmed: true }

/** MUFINDI: DZ 07 — 9 of its 12 parked half-hours swing, worst 116 L. */
const DZ_07:  ProbeProfile = { parkedWindows: 12, swingWindows: 9 }
/** A machine that stands still more often and swings just as freely. */
const SWINGY: ProbeProfile = { parkedWindows: 40, swingWindows: 30 }
/** 97 of 139 units look like this. */
const STEADY: ProbeProfile = { parkedWindows: 200, swingWindows: 0 }
/** MUFINDI - DZ 20 — one swing in twenty parked windows. */
const THIN:   ProbeProfile = { parkedWindows: 20, swingWindows: 1 }

describe('probeSwings', () => {
  it('catches the case the operator raised', () => {
    // A dozer spends its day working, so it accrues few parked windows — but 9
    // of its 12 swing. Counting parked windows rather than swinging ones
    // excluded the single strongest case on the fleet. See MIN_SWING_WINDOWS.
    expect(probeSwings(DZ_07)).toBe(true)
  })

  it('needs the swings themselves, not merely the chance to swing', () => {
    expect(probeSwings({ parkedWindows: 6, swingWindows: MIN_SWING_WINDOWS })).toBe(true)
    expect(probeSwings({ parkedWindows: 6, swingWindows: MIN_SWING_WINDOWS - 1 })).toBe(false)
  })

  it('ignores a probe that swung once and settled', () => {
    // 1 in 20 is under the share, and it is the thin evidence a parked-window
    // minimum was reaching for without catching.
    expect(probeSwings(THIN)).toBe(false)
  })

  it('is quiet about a machine it has no profile for', () => {
    expect(probeSwings(null)).toBe(false)
    expect(probeSwings({ parkedWindows: 0, swingWindows: 0 })).toBe(false)
  })

  it('leaves a steady probe alone', () => {
    expect(probeSwings(STEADY)).toBe(false)
  })
})

describe('applyProbeTrustGate', () => {
  it('withdraws the confirmation but still calls it a drain', () => {
    // The whole point of separating verdict from confidence. The level did fall
    // and did not come back, so it is still a DRAIN; what we withdraw is the
    // claim that our own telemetry settles it.
    const out = applyProbeTrustGate(DRAIN, SWINGY)
    expect(out).toMatchObject({ verdict: 'DRAIN', confirmed: false, reason: 'probe-swings' })
    // The measured recovery survives — still the best figure we have.
    expect(out.recoveredMl).toBe(1_200)
  })

  it('leaves a drain confirmed on a probe that does hold still', () => {
    expect(applyProbeTrustGate(DRAIN, STEADY)).toBe(DRAIN)
  })

  it('never touches REDISTRIBUTION, however suspect the probe', () => {
    // Withdrawing it would push the volume back toward being reported as gone —
    // the opposite of what the operator wants on DZ 07, whose recovered drains
    // are the ones they agree with.
    expect(applyProbeTrustGate(REDIS, SWINGY)).toBe(REDIS)
  })

  it('never touches a verdict that was not confirmed to begin with', () => {
    expect(applyProbeTrustGate(UNSURE, SWINGY)).toBe(UNSURE)
    expect(applyProbeTrustGate(REFILL, SWINGY)).toBe(REFILL)
    expect(applyProbeTrustGate(FAULT, SWINGY)).toBe(FAULT)
  })

  it('moves no volume in either direction', () => {
    // A DRAIN counts whether or not it is confirmed, so unlike the old
    // LOSS -> UNVERIFIED move this cannot shift a single litre. What changes is
    // only whether it is announced as critical against whoever was driving.
    for (const before of [DRAIN, REDIS, UNSURE, REFILL, FAULT]) {
      expect(applyProbeTrustGate(before, SWINGY).verdict).toBe(before.verdict)
    }
  })

  it('passes everything through when there is no profile', () => {
    for (const a of [DRAIN, REDIS, UNSURE, REFILL, FAULT]) expect(applyProbeTrustGate(a, null)).toBe(a)
  })
})
