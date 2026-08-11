import { describe, it, expect } from 'vitest'
import {
  adjudicateFilling, FILL_SETTLE_MINUTES, FILL_HOLD_MINUTES,
} from '../../src/modules/fuel/fuel-filling-adjudication.js'
import type { LevelSample } from '../../src/modules/fuel/fuel-adjudication.js'

const FILLED = new Date('2026-08-10T04:51:00Z')
/** Past the settle AND hold windows, so a claim is ripe to judge. */
const NOW    = new Date('2026-08-10T06:30:00Z')

/** Readings every 2 minutes from 20 min before the filling. */
const series = (mls: number[]): LevelSample[] =>
  mls.map((fuelLevelMl, i) => ({
    capturedAt: new Date(FILLED.getTime() - 20 * 60_000 + i * 2 * 60_000),
    fuelLevelMl,
  }))

/** 10 readings before the claim, then the pump window, then the new level. */
const fill = (before: number, after: number): LevelSample[] =>
  series([
    ...Array<number>(10).fill(before),           // −20 min → the claim
    ...Array<number>(10).fill(before),           // the settle window, ignored
    ...Array<number>(20).fill(after),            // settled, and holding
  ])

describe('adjudicateFilling', () => {
  it('holds its judgement until the tank has settled', () => {
    const tooSoon = new Date(FILLED.getTime() + (FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES - 5) * 60_000)
    const out = adjudicateFilling({ filledAt: FILLED, filledMl: 54_000 }, fill(26_500, 81_000), tooSoon)
    expect(out).toMatchObject({ verdict: 'PENDING', reason: 'settling' })
  })

  it('confirms a filling our own level series watched arrive', () => {
    // The typical row: p50 of observed-over-claimed across the ledger is 0.96.
    const out = adjudicateFilling({ filledAt: FILLED, filledMl: 54_000 }, fill(26_500, 81_000), NOW)
    expect(out).toMatchObject({ verdict: 'REFILL', reason: 'level-rose', confirmed: true })
    expect(out.recoveredMl).toBe(54_500)
  })

  it('calls it undulation when the tank is no fuller for it', () => {
    // 210 of 1,865 decidable fillings show no rise at all. These are the
    // up-swings of oscillating probes — the same machines whose down-swings
    // arrive as "thefts".
    const out = adjudicateFilling({ filledAt: FILLED, filledMl: 144_300 }, fill(60_000, 58_000), NOW)
    expect(out).toMatchObject({ verdict: 'REDISTRIBUTION', reason: 'no-rise-observed', confirmed: true })
  })

  it('rejects a rise far too small to be the delivery claimed', () => {
    // MUFINDI: LMV 03 — 288.7 L logged across three rows into a 180 L tank,
    // against an observed rise of about 54 L. A claim of 144 L that moves the
    // tank 12 L is not that delivery.
    const out = adjudicateFilling({ filledAt: FILLED, filledMl: 144_300 }, fill(26_500, 38_500), NOW)
    expect(out.verdict).toBe('REDISTRIBUTION')
  })

  it('takes the claim on trust when there is nothing to check it against', () => {
    // 3,929 of 5,794 fillings. The provider saw fuel go in and our telemetry
    // cannot speak to it, so we relay rather than contradict — but we do not
    // claim to have confirmed it.
    const out = adjudicateFilling({ filledAt: FILLED, filledMl: 54_000 }, series([26_500, 81_000]), NOW)
    expect(out).toMatchObject({ verdict: 'REFILL', reason: 'insufficient-telemetry', confirmed: false })
  })

  it('is not fooled by a single spike either side', () => {
    // Medians, not extrema, and the series is median-filtered first. A probe
    // that swings 25 L while parked would otherwise invent or erase a delivery
    // on one bad reading.
    const spiky = series([
      26_500, 26_500, 26_500, 99_000, 26_500, 26_500, 26_500, 26_500, 26_500, 26_500,
      26_500, 26_500, 26_500, 26_500, 26_500, 26_500, 26_500, 26_500, 26_500, 26_500,
      81_000, 81_000, 81_000, 5_000, 81_000, 81_000, 81_000, 81_000, 81_000, 81_000,
      81_000, 81_000, 81_000, 81_000, 81_000, 81_000, 81_000, 81_000, 81_000, 81_000,
    ])
    const out = adjudicateFilling({ filledAt: FILLED, filledMl: 54_000 }, spiky, NOW)
    expect(out).toMatchObject({ verdict: 'REFILL', confirmed: true })
    expect(out.recoveredMl).toBe(54_500)
  })
})
