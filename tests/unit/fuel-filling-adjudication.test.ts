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

  it('judges a sparse reporter off the three readings it has', () => {
    // One reading every 8 minutes, all at the same level. The level at the
    // pump is the lowest level held for three readings (FILL_PUMP_LEVEL_RANK),
    // which three readings at one level give; the baseline is their median.
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

describe('adjudicateFilling: a probe frozen while the engine runs (KDX 130Y, 6 Nov 2026)', () => {
  const min = 60_000
  /** Every 2 min from 20 min before the claim; engine on throughout. */
  const run = (mls: number[]): LevelSample[] => mls.map((fuelLevelMl, i) => ({
    capturedAt: new Date(FILLED.getTime() - 20 * min + i * 2 * min), fuelLevelMl, engineOn: true,
  }))
  // Frozen at the pre-fill level for 2 h, then the fill shows and holds.
  const frozenThenRise = run([...Array<number>(70).fill(126_864), ...Array<number>(40).fill(139_000)])
  const late = new Date(FILLED.getTime() + 5 * 60 * min)

  it('reads the rise once the probe moves again', () => {
    const out = adjudicateFilling({ filledAt: FILLED, filledMl: 13_800 }, frozenThenRise, late)
    expect(out).toMatchObject({ verdict: 'REFILL', reason: 'level-rose-late', confirmed: true })
    expect(out.recoveredMl).toBe(12_136)
  })

  it('waits while the probe is still frozen', () => {
    const soon = new Date(FILLED.getTime() + 90 * min)
    const out = adjudicateFilling({ filledAt: FILLED, filledMl: 13_800 }, frozenThenRise.filter((s) => s.capturedAt <= soon), soon)
    expect(out).toMatchObject({ verdict: 'PENDING', reason: 'probe-frozen' })
  })

  it('still calls it undulation when the probe moves and the tank is no fuller', () => {
    const out = adjudicateFilling({ filledAt: FILLED, filledMl: 13_800 },
      run([...Array<number>(70).fill(126_864), ...Array<number>(40).fill(125_000)]), late)
    expect(out).toMatchObject({ verdict: 'REDISTRIBUTION', reason: 'no-rise-observed' })
  })

  it('keeps a parked flat tank as no rise', () => {
    const parked = run(Array<number>(110).fill(126_864)).map((s) => ({ ...s, engineOn: false }))
    expect(adjudicateFilling({ filledAt: FILLED, filledMl: 13_800 }, parked, late).verdict).toBe('REDISTRIBUTION')
  })
})

/**
 * A long delivery stamped partway up its ramp (MUFINDI - EX 21, 20 Nov 2026).
 * The real series, one reading every 30 s: the tank held 74.6 to 75.1 L, rose
 * from 04:48:45 UTC to 359.1 L at 05:06:15, and Wialon stamped the 284.3 L
 * filling at 05:02:45, at 300 L. The baseline used to be capped at the median
 * of the last three readings before the stamp (about 290 L), so it kept the
 * ramp and read 209.6 L "observed".
 */
describe('adjudicateFilling: a long delivery stamped partway up its ramp (EX 21, 20 Nov 2026)', () => {
  const FILLED_AT = new Date('2026-11-20T05:02:45Z')
  const RIPE = new Date('2026-11-20T06:10:00Z')
  const READINGS = `
    04:42:48 75043 04:43:18 75130 04:43:48 75130 04:44:15 75130 04:44:45 73652 04:45:15 73478 04:45:45 74348
    04:46:15 74609 04:46:45 74696 04:47:15 74609 04:47:45 74609 04:48:15 74609 04:48:45 79391 04:49:15 87652
    04:49:45 93826 04:50:15 102500 04:50:45 111416 04:51:15 123304 04:51:45 130450 04:52:15 139910 04:52:45 146460
    04:53:15 153805 04:53:45 162072 04:54:15 168378 04:54:45 175179 04:55:15 187589 04:55:45 192364 04:56:15 197091
    04:56:45 198455 04:57:15 205946 04:57:45 214685 04:58:15 224144 04:58:45 234128 04:59:15 245315 04:59:45 250991
    05:00:15 258198 05:00:45 266952 05:01:15 275596 05:01:45 284955 05:02:15 290280 05:02:45 300090 05:03:15 313304
    05:03:45 322056 05:04:15 330273 05:04:45 336909 05:05:15 343214 05:05:45 351091 05:06:15 359091 05:06:45 358909
    05:07:15 358909 05:07:45 359000 05:08:15 359000 05:08:45 355818 05:09:08 358545 05:09:44 358545 05:10:16 358727
    05:10:46 358727 05:11:08 358727 05:11:23 358727 05:11:59 358727 05:12:29 358818 05:12:40 358818 05:13:40 358818
    05:14:10 358727 05:14:40 358727 05:15:10 358818 05:15:40 358727 05:16:10 358727 05:16:40 358818 05:17:10 358818
    05:17:40 358727 05:18:10 358727 05:18:40 358818 05:19:10 358818 05:19:40 358727 05:20:10 358727 05:20:40 358727
    05:21:10 358727 05:21:40 358636 05:22:10 357091 05:22:40 359000 05:23:10 358455 05:23:40 358273 05:24:05 358273
    05:24:35 358455 05:25:05 358182 05:25:15 358545 05:25:45 357909 05:26:15 358273 05:26:45 358273 05:27:15 358000
    05:27:45 358455 05:28:15 356909 05:28:45 358182 05:29:15 357909 05:29:45 358182 05:30:15 357636 05:30:45 357909
    05:31:15 357455 05:31:45 358182 05:32:15 357818 05:32:45 357636 05:33:15 356545 05:33:45 357091 05:34:15 357909
    05:34:45 357364 05:35:15 356182 05:35:45 355273 05:36:15 354091 05:36:45 353636 05:37:15 353818 05:37:45 354273
    05:38:15 355455 05:38:45 354909 05:39:15 354818 05:39:45 354545 05:40:15 353455 05:40:45 354636 05:41:15 353727
    05:41:45 353091 05:42:15 352273 05:42:45 352182 05:43:15 352636 05:43:25 352636 05:43:55 352818 05:44:25 353000
    05:44:55 352818 05:45:25 352364 05:45:55 352182 05:46:25 352000 05:46:55 353000 05:47:25 352636 05:47:55 351818
    05:48:25 352000 05:48:55 352182 05:49:25 350182 05:49:55 350455 05:50:25 349554 05:50:55 348571 05:51:25 348929
    05:51:55 349286 05:52:25 349375 05:52:55 348750 05:53:25 348571 05:53:55 348571 05:54:25 347946 05:54:55 347768
    05:55:25 347857 05:55:55 347589 05:56:25 346964 05:56:55 347232 05:57:25 346696 05:57:55 347054 05:58:25 345893
    05:58:55 346071 05:59:25 345893 05:59:55 346250 06:00:25 346429 06:00:55 345536 06:01:25 346607 06:01:55 344643
    06:02:25 343929 06:02:55 345089 06:03:25 344732`
  const series: LevelSample[] = READINGS.trim().split(/\s+/).reduce<LevelSample[]>((out, v, i, all) => {
    if (i % 2 === 0) out.push({ capturedAt: new Date(`2026-11-20T${v}Z`), fuelLevelMl: Number(all[i + 1]), engineOn: true })
    return out
  }, [])

  it('measures the rise from the level before the ramp, not from partway up it', () => {
    const out = adjudicateFilling({ filledAt: FILLED_AT, filledMl: 284_300 }, series, RIPE)
    expect(out).toMatchObject({ verdict: 'REFILL', reason: 'level-rose', confirmed: true })
    // The 75 L plateau to the settled level while the excavator went back to
    // work: about 278 L, where the old cap read 209.6 L.
    expect(out.recoveredMl).toBeGreaterThan(270_000)
    expect(out.recoveredMl).toBeLessThanOrEqual(284_300)
  })

  it('is not set by the slosh as the nozzle goes in', () => {
    // Two readings 1.5 L under the plateau (04:44:45, 04:45:15) are in the
    // series above; deepen them to 10 L under and the plateau still stands.
    const sloshed = series.map(s => (s.capturedAt.getTime() === Date.parse('2026-11-20T04:44:45Z') || s.capturedAt.getTime() === Date.parse('2026-11-20T04:45:15Z'))
      ? { ...s, fuelLevelMl: 65_000 } : s)
    const out = adjudicateFilling({ filledAt: FILLED_AT, filledMl: 284_300 }, sloshed, RIPE)
    expect(out.recoveredMl).toBeGreaterThan(270_000)
  })
})

describe('adjudicateFilling: a dead gauge is not the level at the pump', () => {
  const FILLED_AT = new Date('2026-09-23T10:22:00Z')
  const RIPE = new Date('2026-09-23T12:00:00Z')
  it('leaves zero readings in the lookbehind out of the pump level', () => {
    const at = (m: number) => new Date(FILLED_AT.getTime() - m * 60_000)
    const s: LevelSample[] = []
    for (let m = 18; m >= 16; m--) s.push({ capturedAt: at(m), fuelLevelMl: 0 })
    for (let m = 15; m >= 0; m--) s.push({ capturedAt: at(m), fuelLevelMl: 30_000 })
    for (let m = 1; m <= FILL_SETTLE_MINUTES; m++) s.push({ capturedAt: at(-m), fuelLevelMl: 30_000 })
    for (let m = FILL_SETTLE_MINUTES + 1; m <= FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES; m++) s.push({ capturedAt: at(-m), fuelLevelMl: 80_000 })
    const out = adjudicateFilling({ filledAt: FILLED_AT, filledMl: 50_000 }, s, RIPE)
    expect(out).toMatchObject({ verdict: 'REFILL', reason: 'level-rose' })
    expect(out.recoveredMl).toBe(50_000)
  })
})
