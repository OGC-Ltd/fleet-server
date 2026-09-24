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

/**
 * The baseline window, added 2026-09-24.
 *
 * The baseline used to be the median of the whole 20-minute lookbehind. When a
 * drain had just happened, that window straddled the fall and more than half
 * its readings were pre-drop, so the median sat at the OLD level and a refill
 * which merely restored what had been taken measured as a negative rise.
 *
 * Each case below is a real row from 2026-09-23 with its real levels; see
 * docs/fuel-theft-alerting-gaps.md §4.2.
 */
describe('adjudicateFilling — the baseline is the tank before the pump, not 20 min ago', () => {
  const FILLED_AT = new Date('2026-09-23T10:22:00Z')
  const RIPE      = new Date('2026-09-23T12:00:00Z')

  /**
   * A tank that sat at `high`, was drained to `low` partway through the
   * lookbehind, then refilled to `settled`. One reading a minute.
   */
  const drainThenFill = (high: number, low: number, settled: number): LevelSample[] => {
    const at = (minutesBefore: number) =>
      new Date(FILLED_AT.getTime() - minutesBefore * 60_000)
    const out: LevelSample[] = []
    // −20 → −9 min: the tank as it was before anything happened.
    for (let m = 20; m > 8; m--) out.push({ capturedAt: at(m), fuelLevelMl: high })
    // −8 → 0 min: drained, and sitting at the new low when the pump starts.
    for (let m = 8; m >= 0; m--) out.push({ capturedAt: at(m), fuelLevelMl: low })
    // the settle window, ignored, then the held new level.
    for (let m = 1; m <= FILL_SETTLE_MINUTES; m++) out.push({ capturedAt: at(-m), fuelLevelMl: low })
    for (let m = FILL_SETTLE_MINUTES + 1; m <= FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES; m++) {
      out.push({ capturedAt: at(-m), fuelLevelMl: settled })
    }
    return out
  }

  it('MTR 09 — 19.9 L into a tank that had just lost 20.7 L', () => {
    const out = adjudicateFilling(
      { filledAt: FILLED_AT, filledMl: 19_900 },
      drainThenFill(60_100, 39_400, 59_300), RIPE,
    )
    expect(out).toMatchObject({ verdict: 'REFILL', reason: 'level-rose', confirmed: true })
    expect(out.recoveredMl).toBe(19_900)
  })

  it('MTR 04 — 16.8 L restoring a tank drained from 60.1 to 40.7 L', () => {
    const out = adjudicateFilling(
      { filledAt: FILLED_AT, filledMl: 16_800 },
      drainThenFill(60_100, 40_700, 57_800), RIPE,
    )
    expect(out).toMatchObject({ verdict: 'REFILL', reason: 'level-rose' })
  })

  it('FT 13 — 20.0 L, part of which the vehicle then drove away and burned', () => {
    // Settles at 87.3 L rather than the 90.6 L peak: the truck left and was
    // consuming. 15.9 of 20.0 L is still well clear of FILL_OBSERVED_MIN_RATIO.
    const out = adjudicateFilling(
      { filledAt: FILLED_AT, filledMl: 20_000 },
      drainThenFill(91_000, 71_600, 87_300), RIPE,
    )
    expect(out).toMatchObject({ verdict: 'REFILL', reason: 'level-rose' })
  })

  it('CTR 14 — 25.6 L on a 385 L tank', () => {
    const out = adjudicateFilling(
      { filledAt: FILLED_AT, filledMl: 25_600 },
      drainThenFill(260_900, 238_100, 263_600), RIPE,
    )
    expect(out).toMatchObject({ verdict: 'REFILL', reason: 'level-rose' })
  })

  it('still calls undulation undulation — a tank no fuller after the claim', () => {
    // The guard that matters: shortening the baseline window must not turn the
    // up-swing of an oscillating probe into a corroborated delivery. Here the
    // tank ends where it started, so there is no rise to find however the
    // baseline is measured.
    const out = adjudicateFilling(
      { filledAt: FILLED_AT, filledMl: 44_800 },
      drainThenFill(91_700, 91_700, 91_400), RIPE,
    )
    expect(out).toMatchObject({ verdict: 'REDISTRIBUTION', reason: 'no-rise-observed' })
  })

  it('falls back to the whole window when a sparse reporter has too few readings', () => {
    // One reading every 8 minutes, all at the same level: capping leaves fewer
    // than MIN_SAMPLES readings to take a median over, so the whole window
    // stands rather than a baseline measured off one or two points.
    const at = (m: number) => new Date(FILLED_AT.getTime() - m * 60_000)
    const sparse: LevelSample[] = [
      { capturedAt: at(24), fuelLevelMl: 30_000 },
      { capturedAt: at(16), fuelLevelMl: 30_000 },
      { capturedAt: at(8),  fuelLevelMl: 30_000 },
      { capturedAt: at(-25), fuelLevelMl: 80_000 },
      { capturedAt: at(-35), fuelLevelMl: 80_000 },
      { capturedAt: at(-45), fuelLevelMl: 80_000 },
    ]
    const out = adjudicateFilling({ filledAt: FILLED_AT, filledMl: 50_000 }, sparse, RIPE)
    expect(out).toMatchObject({ verdict: 'REFILL', reason: 'level-rose' })
  })
})

/**
 * The trust gate on the baseline, added 2026-09-24 alongside it.
 *
 * Capping the baseline at the pre-fill level flips 66 rows to REFILL across 12
 * days, and 54 of those sit on probes the trust gate distrusts — where the
 * "level before the fill" is just the trough of a swing. Those units keep the
 * old wide-window behaviour, so the up-swings this module exists to catch are
 * not re-admitted as deliveries.
 */
describe('adjudicateFilling — the capped baseline applies only to a trusted probe', () => {
  const FILLED_AT = new Date('2026-09-23T10:22:00Z')
  const RIPE      = new Date('2026-09-23T12:00:00Z')

  /** A tank at `high`, dropped to `low`, then reading `settled` afterwards. */
  const drainThenFill = (high: number, low: number, settled: number): LevelSample[] => {
    const at = (m: number) => new Date(FILLED_AT.getTime() - m * 60_000)
    const out: LevelSample[] = []
    for (let m = 20; m > 8; m--) out.push({ capturedAt: at(m), fuelLevelMl: high })
    for (let m = 8; m >= 0; m--) out.push({ capturedAt: at(m), fuelLevelMl: low })
    for (let m = 1; m <= FILL_SETTLE_MINUTES; m++) out.push({ capturedAt: at(-m), fuelLevelMl: low })
    for (let m = FILL_SETTLE_MINUTES + 1; m <= FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES; m++) {
      out.push({ capturedAt: at(-m), fuelLevelMl: settled })
    }
    return out
  }

  /** Distrusted: >= MIN_SWING_WINDOWS swinging AND >= SWING_SHARE of them. */
  const wanders = { parkedWindows: 20, swingWindows: 6, sustainedShare: null }
  const steady  = { parkedWindows: 20, swingWindows: 0, sustainedShare: null }

  const claim = { filledAt: FILLED_AT, filledMl: 19_900 }
  const series = drainThenFill(60_100, 39_400, 59_300)

  it('corroborates the delivery when the probe holds still', () => {
    expect(adjudicateFilling(claim, series, RIPE, steady))
      .toMatchObject({ verdict: 'REFILL', reason: 'level-rose' })
  })

  it('keeps the old reading on a probe that swings', () => {
    // Same series, same claim — only the instrument's reputation differs.
    expect(adjudicateFilling(claim, series, RIPE, wanders))
      .toMatchObject({ verdict: 'REDISTRIBUTION', reason: 'no-rise-observed' })
  })

  it('assumes a trustworthy probe when no profile is supplied', () => {
    // Every pre-existing caller omits the argument; none of them should change
    // behaviour because this parameter was added.
    expect(adjudicateFilling(claim, series, RIPE))
      .toMatchObject({ verdict: 'REFILL', reason: 'level-rose' })
    expect(adjudicateFilling(claim, series, RIPE, null))
      .toMatchObject({ verdict: 'REFILL', reason: 'level-rose' })
  })
})
