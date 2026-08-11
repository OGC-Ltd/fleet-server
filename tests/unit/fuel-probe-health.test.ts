import { describe, it, expect } from 'vitest'
import {
  classifyProbe, isFaulty, ALIVE_ML, MIN_PINGS, MIN_RECENT_PINGS,
  type ProbeWindow,
} from '../../src/modules/fuel/fuel-probe-health.js'

const AUG_07 = new Date('2026-08-07T23:33:00Z')

/** A probe reporting normally. Cases below change only what they are about. */
const OK: ProbeWindow = {
  pings: 6_930, levelPings: 6_930, peakMl: 357_906,
  lastAliveAt: new Date('2026-08-11T02:00:00Z'),
  recentPings: 300, recentPeakMl: 340_000, recentMoving: 120,
}

const w = (over: Partial<ProbeWindow>): ProbeWindow => ({ ...OK, ...over })

describe('classifyProbe', () => {
  it('leaves a reporting probe alone', () => {
    expect(classifyProbe(OK)).toMatchObject({ state: 'OK' })
    expect(isFaulty(classifyProbe(OK))).toBe(false)
  })

  it('calls a probe dead once it reads nothing after reading something', () => {
    // MUFINDI: FT 11 — 358 L on 2026-08-07, silent since, and one of the five
    // units the operator independently sent for a workshop visit.
    const v = classifyProbe(w({ lastAliveAt: AUG_07, recentPeakMl: 0 }))
    expect(v).toMatchObject({ state: 'DIED', reason: 'stopped-reporting' })
    expect(isFaulty(v)).toBe(true)
  })

  it('flags a dead probe with no engine evidence at all', () => {
    // The reason this rule does not gate on engineOn. MUFINDI: EX 07 reports it
    // on 0 of 11,965 readings and KTCC 856B on 0 of 780 — an engine-gated rule
    // misses two of the operator's five.
    const v = classifyProbe(w({
      pings: 11_965, levelPings: 11_965, peakMl: 257_500,
      lastAliveAt: AUG_07, recentPeakMl: 0, recentMoving: 0,
    }))
    expect(v.state).toBe('DIED')
  })

  it('flags a probe that has never reported anything', () => {
    // 32 of these, 29 with neither a drain nor a filling. They read as
    // monitored vehicles with clean records.
    const v = classifyProbe(w({ peakMl: 0, recentPeakMl: 0, lastAliveAt: null }))
    expect(v).toMatchObject({ state: 'SILENT', reason: 'never-reported' })
    expect(isFaulty(v)).toBe(true)
  })

  it('does not call an unprobed vehicle broken', () => {
    // 25 units report telemetry with no fuel channel. Nothing is fitted, so
    // nothing is faulty, and mixing them in would bury the ones that are.
    const v = classifyProbe(w({ levelPings: 0, peakMl: null, recentPeakMl: null, lastAliveAt: null }))
    expect(v).toMatchObject({ state: 'NOT_FITTED' })
    expect(isFaulty(v)).toBe(false)
  })

  it('says nothing about a vehicle it has barely heard from', () => {
    const v = classifyProbe(w({ pings: MIN_PINGS - 1 }))
    expect(v).toMatchObject({ state: 'UNKNOWN' })
    expect(isFaulty(v)).toBe(false)
  })

  it('will not condemn a probe on a handful of recent readings', () => {
    // Silence needs to be established. A unit that has sent four pings since
    // yesterday has not demonstrated anything.
    const v = classifyProbe(w({ lastAliveAt: AUG_07, recentPings: MIN_RECENT_PINGS - 1, recentPeakMl: 0 }))
    expect(v.state).toBe('OK')
  })

  it('does not condemn a probe that never had much to lose', () => {
    // A tank that reads 8 L and then zero may simply be empty. The observed
    // failures fell from 28, 38, 111, 258 and 358 L.
    const v = classifyProbe(w({ peakMl: ALIVE_ML - 1, lastAliveAt: AUG_07, recentPeakMl: 0 }))
    expect(v.state).toBe('OK')
  })

  it('still condemns a probe on a machine that has not moved', () => {
    // Movement is corroboration, not a requirement — KTCC 811D and KTCC 856B
    // are both dark and both stationary, and both are on the operator's list.
    const v = classifyProbe(w({ lastAliveAt: AUG_07, recentPeakMl: 0, recentMoving: 0 }))
    expect(v.state).toBe('DIED')
  })
})
