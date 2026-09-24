/**
 * The cause classifier.
 *
 * Two kinds of assertion here, and the second matters more than the first.
 * Ordinary branch coverage checks each gate does what it says. The tests headed
 * "the rules that must not be relaxed" pin the ones whose failure would be
 * silent and expensive: announcing on an untrustworthy probe, calling something
 * theft that was not proved, or letting a sensor artifact become the loudest
 * alert on the fleet.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyDrain, resolveBand, isAnnounced, announces, mayUseTheftWording,
  ANNOUNCED_CAUSES, ANNOUNCED_REASON_SLUGS,
  ANNOUNCE_MULTIPLE, MAX_PLAUSIBLE_REMOVAL_LPH, SIPHON_MIN_DROP_ML,
  DERIVED_BAND_SPREAD, MACHINE_CLASS, CLASS_BANDS, CLASS_CEILING_LPH, machinePrefix,
  resolveClass, CLASS_BY_TANK, TYPE_CLASS, resolveBasis, applicableBasis, OPEN_ROAD_MIN_KM,
  CAUSE_NO_FUEL_LEFT,
  type DropEvidence, type BurnBand, type DrainCause,
} from '../../src/modules/fuel/fuel-theft-classifier.js'
import { probeSwings, probeOverreads, MAX_FILL_RATIO, type ProbeProfile } from '../../src/modules/fuel/fuel-adjudication.js'

/** A band whose upper edge is exactly 10 L/h, so ratios read off directly. */
const BAND: BurnBand = { lowLph: 5, highLph: 10, source: 'operator' }

/** A probe with no history of moving on its own. */
const STEADY: ProbeProfile = { parkedWindows: 40, swingWindows: 0 }
/** ...and one that swings on a standing machine. */
const SWINGY: ProbeProfile = { parkedWindows: 40, swingWindows: 20 }

/**
 * A fall, described by what it implies. `lph` is the litres-per-engine-hour
 * the caller wants the evidence to imply; the drop and engine time are derived
 * from it so tests read as intent rather than arithmetic.
 */
function running(lph: number, hours = 1): DropEvidence {
  return {
    dropMl:         lph * hours * 1000,
    fallSeconds:    hours * 3600,
    engineSeconds:  hours * 3600,
    engineEvidence: 1,
    moved:          false,
    stepFraction:   0.2,
    // Null: no interval long enough to divide by, so the burst gate stays
    // silent unless a test sets it. See MAX_PLAUSIBLE_BURST_LPH.
    peakIntervalLph: null,
    kT:             0.1,
    decayResidual:  0.02,
    samples:        60,
    // Heavy machinery: engine hours are the basis, distance is noise.
    distanceKm:     null,
  }
}

/** A fall with the engine provably off for its whole span. */
function parked(dropL: number, minutes: number, over: Partial<DropEvidence> = {}): DropEvidence {
  return {
    dropMl:         dropL * 1000,
    fallSeconds:    minutes * 60,
    engineSeconds:  0,
    engineEvidence: 1,
    moved:          false,
    stepFraction:   0.2,
    peakIntervalLph: null,
    kT:             0.1,
    decayResidual:  0.02,
    samples:        40,
    distanceKm:     null,
    ...over,
  }
}

const causeOf = (ev: DropEvidence, band: BurnBand | null = BAND, p: ProbeProfile | null = STEADY): DrainCause =>
  classifyDrain(ev, band, p).cause

describe('the burn branch — the primary rule', () => {
  it('within the band is ordinary consumption', () => {
    expect(causeOf(running(8))).toBe('ENGINE_BURN')
  })

  it('above the band but below the multiple is HIGH_BURN, and stays silent', () => {
    const j = classifyDrain(running(20), BAND, STEADY)   // 2x
    expect(j.cause).toBe('HIGH_BURN')
    expect(isAnnounced(j.cause)).toBe(false)
  })

  it('far above the band is classified, but no longer announced', () => {
    // The tier is still computed — it is a real measurement and the fuel
    // tables show it. It simply says nothing to anyone until machines have
    // bands worth judging against. See ANNOUNCED.
    const j = classifyDrain(running(10 * ANNOUNCE_MULTIPLE), BAND, STEADY)
    expect(j.cause).toBe('UNEXPLAINED_BURN')
    expect(isAnnounced(j.cause)).toBe(false)
    expect(j.impliedLph).toBeCloseTo(10 * ANNOUNCE_MULTIPLE, 6)
  })

  it('grades confidence upward from the announcing edge', () => {
    const edge = classifyDrain(running(10 * ANNOUNCE_MULTIPLE), BAND, STEADY)
    const far  = classifyDrain(running(10 * ANNOUNCE_MULTIPLE * 4), BAND, STEADY)
    expect(far.confidence).toBeGreaterThan(edge.confidence)
  })
})

describe('the parked branch — the only route to SIPHON', () => {
  it('a sustained steady fall on a stopped machine is a siphon', () => {
    expect(causeOf(parked(40, 60))).toBe('SIPHON')
  })

  it('a decaying fall is the tank settling', () => {
    expect(causeOf(parked(40, 60, { kT: 3, decayResidual: 0.01 }))).toBe('SETTLING')
  })

  it('too small or too slow is not judged at all', () => {
    expect(causeOf(parked(SIPHON_MIN_DROP_ML / 1000 - 1, 60))).toBe('INDETERMINATE')  // magnitude
    expect(causeOf(parked(20, 60 * 8))).toBe('INDETERMINATE')                          // ~2.5 L/h
  })

  it('a brief fall at a rate a pump could draw is a siphon, not a floor rejection', () => {
    // 16 L in 8 minutes = 120 L/h, engine measured off, probe trusted. Under
    // the old ten-minute floor this came back INDETERMINATE as "too brief";
    // that floor moved to 120 s on 2026-09-24 because it was refusing real
    // events — MTR 04 at 302 s, CTR 19 at 419 s, MTR 20 at 429 s, all on
    // 2026-09-23. See SIPHON_MIN_SECONDS for the sweep behind the number.
    expect(causeOf(parked(16, 8))).toBe('SIPHON')
  })

  it('the duration floor bites again now the rate ceiling is realistic', () => {
    // This test was the inverse a commit ago. While MAX_PLAUSIBLE_REMOVAL_LPH
    // sat at 300 L/h, anything short enough to fail a 120 s floor had already
    // been caught as SLOSH — 15 L in under two minutes is at least 450 L/h — so
    // `below-parked-floor` was unreachable for duration alone. At 3,000 L/h it
    // is reachable, which is precisely why the burst gate had to ship with the
    // raise. See MAX_PLAUSIBLE_BURST_LPH.
    expect(causeOf(parked(15, 1.9))).toBe('INDETERMINATE')   // 474 L/h, 114 s
    expect(causeOf(parked(20, 2.5))).toBe('SIPHON')          // 480 L/h, 150 s
  })

  it('the physical ceiling is checked before the duration floor', () => {
    // 40 L in 30 seconds is 4,800 L/h. Both gates would refuse it — the rate
    // ceiling and the 120 s floor — and the rate is checked first, so the row
    // is labelled for what is wrong with it rather than for being brief.
    // (40 L in 5 minutes is 480 L/h, which used to land here and is now an
    // ordinary pump; see MAX_PLAUSIBLE_REMOVAL_LPH.)
    expect(causeOf(parked(40, 0.5))).toBe('SLOSH')
  })

  it('a burst no pump could produce is the instrument, even inside a plausible average', () => {
    // The guard that made raising MAX_PLAUSIBLE_REMOVAL_LPH safe. A fall can
    // average an entirely credible rate and still contain one interval at
    // 40,000 L/h — that interval is the probe, and the average hides it.
    // 20 L over 5 minutes is 240 L/h, well inside the sustained ceiling.
    expect(causeOf(parked(20, 5))).toBe('SIPHON')
    expect(causeOf(parked(20, 5, { peakIntervalLph: 40_000 }))).toBe('SLOSH')
  })

  it('a burst a pump COULD produce is left alone', () => {
    // MUFINDI: CTR 19, 2026-09-23 — 14.95 L across 118 s is 456 L/h, an
    // ordinary transfer pump. The retired step test refused it for shape; the
    // rate test admits it, which is the whole reason for the swap.
    expect(causeOf(parked(20, 5, { peakIntervalLph: 456 }))).toBe('SIPHON')
    expect(causeOf(parked(20, 5, { peakIntervalLph: 4_999 }))).toBe('SIPHON')
  })

  it('an unmeasurable burst is not read as a slow one', () => {
    // Null means no interval in the fall was long enough to divide by — about a
    // third of drains — and that is an absence of evidence, not a finding. It
    // must not be treated as passing OR failing the ceiling.
    expect(causeOf(parked(20, 5, { peakIntervalLph: null }))).toBe('SIPHON')
  })

  it('a fall with no measured ignition can never be a siphon', () => {
    // Half the ledger. Accepted as a blind spot rather than guessed at: the
    // engine_on column degrades into "was it moving" on units without
    // ignition, so absent evidence must not read as a stopped engine.
    expect(causeOf(parked(40, 60, { engineEvidence: 0 }))).toBe('INDETERMINATE')
  })

  it('a machine that moved is not parked, whatever the ignition said', () => {
    expect(causeOf(parked(40, 60, { moved: true }))).toBe('INDETERMINATE')
  })
})

describe('road vehicles — distance explains part of the drop', () => {
  /** A truck at 3 km/L, with no machine class: judged on distance. */
  const ROAD: BurnBand = { lowLph: 8, highLph: 12, source: 'type', kmPerL: 3 }

  /** A drop with no engine time, so only the distance rule can speak. */
  const drove = (dropL: number, km: number): DropEvidence => ({
    dropMl: dropL * 1000, fallSeconds: 3600, engineSeconds: 0, engineEvidence: 0,
    moved: km > 0, stepFraction: 0.2, peakIntervalLph: null,
    kT: 0.1, decayResidual: 0.02, samples: 40,
    distanceKm: km,
  })

  it('subtracts what the driving should have cost', () => {
    // 50 km at 3 km/L is 16.7 L. A 95 L drop leaves 78 L unexplained.
    const j = classifyDrain(drove(95, 50), ROAD, STEADY)
    expect(j.cause).toBe('UNEXPLAINED_BURN')
    expect(j.reason).toBe('drop-exceeds-distance')
  })

  it('clears a drop that the distance accounts for', () => {
    // 60 km at 3 km/L is 20 L; a 22 L drop leaves 2 L, under the 5 L floor.
    expect(classifyDrain(drove(22, 60), ROAD, STEADY).cause).toBe('ENGINE_BURN')
  })

  it('no longer calls a stationary drop wholly unexplained', () => {
    // CHANGED 2026-08-26. This used to be the operator's idling case: nothing
    // driven, so nothing explained, announce. Measured, that rule fired on four
    // fifths of all road drains — 0.000 km is the p10 THROUGH p80 of the
    // population — so it was not selecting idling theft, it was selecting
    // "parked", which is what nearly every drain is.
    //
    // A stationary truck now takes the hours denominator instead, per the
    // operator's own framing: trucks measure by distance on the open road and
    // switch to per-hour when idling. This fixture has no engine time and no
    // ignition evidence, so the honest answer is that we cannot say.
    const j = classifyDrain(drove(25.6, 0), ROAD, STEADY, 'DISTANCE')
    expect(j.reason).not.toBe('drop-while-stationary')
    expect(j.cause).toBe('INDETERMINATE')
  })

  it('ignores drops below the operator floor', () => {
    // 14 L parked would be 100% unexplained, but it is under ROAD_MIN_DROP_L.
    expect(classifyDrain(drove(14, 0), ROAD, STEADY).cause).not.toBe('UNEXPLAINED_BURN')
  })

  it('cannot announce a stationary drop on a probe that swings', () => {
    // The guard that makes the idling rule safe. Without gate 1 this rule
    // alone would call every parked probe swing a theft.
    expect(classifyDrain(drove(60, 0), ROAD, SWINGY).cause).toBe('INDETERMINATE')
  })

  it('does not apply to heavy machinery, which has no km baseline', () => {
    expect(BAND.kmPerL).toBeUndefined()
    expect(classifyDrain(running(8), BAND, STEADY).cause).toBe('ENGINE_BURN')
  })
})

describe("the operator's absolute class ceiling", () => {
  /** An excavator band with the operator's own 20 L/h alerting ceiling. */
  const EXC: BurnBand = { lowLph: 5, highLph: 12, source: 'operator', ceilingLph: 20 }

  it('announces above the ceiling, well before the multiple would', () => {
    // 4x a 5-12 band is 48 L/h. The operator's rule fires at 20, so this is a
    // markedly more sensitive instrument for the classes that have one.
    expect(classifyDrain(running(25), EXC, STEADY).cause).toBe('UNEXPLAINED_BURN')
    expect(classifyDrain(running(25), BAND, STEADY).cause).toBe('HIGH_BURN')
  })

  it('leaves an ordinary working day alone', () => {
    // DZ 14's own figure: 11.66 L/h. Inside the band, nowhere near the ceiling.
    expect(classifyDrain(running(11.66), EXC, STEADY).cause).toBe('ENGINE_BURN')
    // ...and just under the ceiling is still not an alert.
    expect(classifyDrain(running(19.9), EXC, STEADY).cause).toBe('HIGH_BURN')
  })

  it('raises the LARGE ceiling above the crawler rate that shares its band', () => {
    // CTR 23's own derived rate is 28.26 L/h over 15 runs. A 20 L/h ceiling on
    // the class it shares with the excavators flagged its ordinary day 76
    // times in 30 days.
    expect(CLASS_CEILING_LPH.get('EXCAVATOR_LARGE')).toBe(30)
  })

  it('carries the excavator ceiling the operator supplied, and no invented ones', () => {
    expect(CLASS_CEILING_LPH.get('EXCAVATOR_MEDIUM')).toBe(20)
    // Tractors and dozers were not given ceilings. A guessed one would decide
    // whether a machine is investigated, so they fall back to the multiple.
    expect(CLASS_CEILING_LPH.get('TRACTOR_LARGE')).toBeUndefined()
    expect(CLASS_CEILING_LPH.get('DOZER_CAT_D8T')).toBeUndefined()
  })

  it('still yields to the physical ceiling — a sensor fault is not a big burn', () => {
    expect(classifyDrain(running(MAX_PLAUSIBLE_REMOVAL_LPH * 2), EXC, STEADY).cause).toBe('SLOSH')
  })

  it('cannot fire on a probe the trust gate distrusts', () => {
    expect(classifyDrain(running(25), EXC, SWINGY).cause).toBe('INDETERMINATE')
  })
})

describe('the rules that must not be relaxed', () => {
  it('a probe reading above its own tank ends the enquiry too', () => {
    // A DIFFERENT fault from swing, and the reason both gates exist. KTCB 295U
    // is steady parked — 23 windows, 0 swinging — and reads a p99 of 404 L on
    // a declared 160 L tank. It passed the swing gate cleanly and produced 95
    // drains in thirty days.
    const OVERREADS: ProbeProfile = { parkedWindows: 23, swingWindows: 0, fillRatio: 2.52 }
    expect(probeSwings(OVERREADS)).toBe(false)          // swing cannot see it
    expect(probeOverreads(OVERREADS)).toBe(true)        // this can
    expect(causeOf(running(400), BAND, OVERREADS)).toBe('INDETERMINATE')
    expect(causeOf(parked(40, 60), BAND, OVERREADS)).toBe('INDETERMINATE')
  })

  it('leaves a probe reading inside its tank alone', () => {
    // The median unit sustains 0.64 of declared capacity and 120 of 299 never
    // read above half, so under-reading is the NORMAL direction and must not
    // be touched. Only reading above the vessel is a calibration claim.
    for (const fillRatio of [0.31, 0.64, 1.0, 1.3]) {
      expect(probeOverreads({ parkedWindows: 40, swingWindows: 0, fillRatio })).toBe(false)
    }
    // ...and an unknown ratio is not evidence of a fault.
    expect(probeOverreads({ parkedWindows: 40, swingWindows: 0, fillRatio: null })).toBe(false)
    expect(probeOverreads({ parkedWindows: 40, swingWindows: 0 })).toBe(false)
  })

  it('an untrusted probe ends the enquiry — including the reassuring answers', () => {
    // Not ENGINE_BURN either. A probe that swings 25 L on a standing machine
    // cannot support ANY statement about why the level fell.
    expect(causeOf(running(8), BAND, SWINGY)).toBe('INDETERMINATE')
    expect(causeOf(running(400), BAND, SWINGY)).toBe('INDETERMINATE')
    expect(causeOf(parked(40, 60), BAND, SWINGY)).toBe('INDETERMINATE')
  })

  it('a machine with no expected rate is never announced', () => {
    expect(causeOf(running(400), null)).toBe('INDETERMINATE')
  })

  it('a rate no pump could produce is the sensor, not a theft', () => {
    // The guard that stops the most extreme probe faults becoming the loudest
    // alerts. It must sit ABOVE the announcing multiple, not below it.
    const absurd = running(MAX_PLAUSIBLE_REMOVAL_LPH * 2)
    expect(causeOf(absurd)).toBe('SLOSH')
    expect(isAnnounced('SLOSH')).toBe(false)
  })

  it('a parked step is no longer refused on its shape alone', () => {
    // RETIRED 2026-09-24, and this assertion is inverted rather than deleted so
    // the change is visible to whoever reads the suite next.
    //
    // The rule was calibrated on "confirmed drains p50 0.25, distrusted probes
    // p50 0.42" — measured across the whole ledger, while `probeSwings` returns
    // INDETERMINATE at gate 1 and keeps the distrusted population away from
    // this test entirely. Re-measured over the rows it actually sees, confirmed
    // drains sit at p50 0.522 and the 0.6 threshold refused 109 of 258 of them.
    //
    // The quantity cannot answer the question either way: it discards the
    // LENGTH of the interval it measures, and these probes report on change at
    // a 30 s median gap. MTR 09 moved 14.18 L across 6 seconds (8,500 L/h, not
    // fuel); CTR 19 moved 14.95 L across two minutes (450 L/h, a pump).
    // Identical step fractions, opposite causes. See
    // prisma/measure-step-fraction.ts and SIPHON_MAX_STEP_FRACTION.
    expect(causeOf(parked(40, 60, { stepFraction: 0.95 }))).toBe('SIPHON')
  })

  it('the extreme fall is still caught — by rate, which is the physical test', () => {
    // What retiring the step test leans on. A drop steep enough to be a dead
    // probe rather than a pump is refused by gate 3 on its RATE, and that guard
    // is unchanged. This is why the two must move together: raising
    // MAX_PLAUSIBLE_REMOVAL_LPH without adding a per-interval rate test would
    // leave nothing catching a probe that drops out in one reading.
    const absurd = running(MAX_PLAUSIBLE_REMOVAL_LPH * 2)
    expect(causeOf(absurd)).toBe('SLOSH')
  })

  it('ONLY a siphon may be described with the word theft', () => {
    // The operator's rule: "when we have determined that truly it was a theft
    // then we need to use the word possible theft". UNEXPLAINED_BURN is a real
    // finding but a different one — a leak, a bad probe and a wrong expected
    // rate all produce it.
    expect(mayUseTheftWording('SIPHON')).toBe(true)
    for (const c of ['UNEXPLAINED_BURN', 'HIGH_BURN', 'ENGINE_BURN', 'SLOSH', 'SETTLING', 'INDETERMINATE'] as const) {
      expect(mayUseTheftWording(c)).toBe(false)
    }
  })

  it('exactly ONE cause reaches an operator', () => {
    // Withdrawn 2026-08-17: a burn "far above expected" is a claim about our
    // reference data on a fleet where most machines have no band. MUFINDI - DG
    // 13, a generator burning a legitimate 40-50 L/h against a 13.23 L/h rate
    // derived from two runs, is the case that settled it.
    const announced = (['ENGINE_BURN', 'HIGH_BURN', 'UNEXPLAINED_BURN', 'SIPHON', 'SLOSH', 'SETTLING', 'INDETERMINATE'] as const)
      .filter(isAnnounced)
    expect(announced).toEqual(['SIPHON'])
  })

  it('the announced set and the query list cannot drift apart', () => {
    // The snapshot's red-vehicle lookup selects on ANNOUNCED_CAUSES. If that
    // ever disagreed with isAnnounced, a vehicle would go red for something we
    // had decided not to say.
    expect([...ANNOUNCED_CAUSES].sort()).toEqual(
      (['ENGINE_BURN', 'HIGH_BURN', 'UNEXPLAINED_BURN', 'SIPHON', 'SLOSH', 'SETTLING', 'INDETERMINATE'] as const)
        .filter(isAnnounced).sort())
  })
})

describe('generators — the class that can never be engine-off', () => {
  const GEN = resolveBand('KASULU', 'MUFINDI - DG 13', null)!

  it('is mapped, banded and given a ceiling', () => {
    expect(MACHINE_CLASS.get('KASULU:DG')).toBe('GENERATOR')
    expect(GEN.lowLph).toBe(35)
    expect(GEN.highLph).toBe(95)
    expect(GEN.ceilingLph).toBe(120)
  })

  it('leaves every hour these machines have actually worked alone', () => {
    // Measured p50s: DG 13 49.5, KHMA 449U 45.2, DG 12 71.3. The worst single
    // observed hour is DG 12's p90 at 94.6.
    for (const lph of [45, 49.5, 71.3, 94.6]) {
      expect(announces(classifyDrain(running(lph), GEN, STEADY))).toBe(false)
    }
  })

  it('announces an excursion above the operator ceiling', () => {
    // A theft adding ~60 L/h on top of a 70 L/h burn.
    const j = classifyDrain(running(130), GEN, STEADY)
    expect(j.cause).toBe('UNEXPLAINED_BURN')
    expect(j.reason).toBe('burn-above-class-ceiling')
    expect(announces(j)).toBe(true)
  })

  it('still yields to the physical ceiling', () => {
    // Beyond what any pump draws, so the reading is what is wrong.
    expect(classifyDrain(running(4_000), GEN, STEADY).cause).toBe('SLOSH')
  })

  it('a MULTIPLE can reach this class again, now the ceiling is realistic', () => {
    // Inverted on 2026-09-24, and the inversion is the point.
    //
    // 4x the band's upper edge is 380 L/h. While MAX_PLAUSIBLE_REMOVAL_LPH sat
    // at 300, every such excursion was dismissed as a sensor artifact BEFORE it
    // was ever compared to the band, so the multiple rule was dead for
    // generators and only the operator-set CLASS_CEILING_LPH kept the class
    // reachable at all. At 3,000 the comparison happens.
    //
    // This is the one consequence of the raise that lands outside the parked
    // branch: a generator burning several hundred litres an hour is now a
    // finding rather than a discarded reading.
    expect(GEN.highLph * ANNOUNCE_MULTIPLE).toBeLessThan(MAX_PLAUSIBLE_REMOVAL_LPH)
    expect(classifyDrain(running(400), GEN, STEADY).cause).toBe('UNEXPLAINED_BURN')
  })
})

describe('what reaches an operator', () => {
  it('a burn finding on a DERIVED band is reported too', () => {
    // Withdrawn on 2026-08-17 and restored the same day once every category
    // needed covering. The original objection — that "above expected" named
    // our missing reference data — is answered by classing the machines that
    // produced nonsense bands and by wording that states the measured rate
    // rather than claiming the drop is unexplained.
    //
    // The derived band is the rate widened by DERIVED_BAND_SPREAD, so its
    // upper edge is 15 and the announcing multiple sits at 60 L/h.
    const derived = resolveBand('KASULU', 'MUFINDI: DZ 14', { lPerHour: 10, basis: 'type' })!
    const j = classifyDrain(running(70), derived, STEADY)
    expect(j.reason).toBe('burn-far-above-band')
    expect(announces(j)).toBe(true)
    // ...but it is still not theft, and may never be worded as such.
    expect(mayUseTheftWording(j.cause)).toBe(false)
  })

  it('covers regular vehicles on their own measured km/L', () => {
    const road: BurnBand = { lowLph: 8, highLph: 12, source: 'vehicle', kmPerL: 3 }
    const ev = (dropL: number, km: number): DropEvidence => ({
      dropMl: dropL * 1000, fallSeconds: 3600, engineSeconds: 0, engineEvidence: 0,
      moved: km > 0, stepFraction: 0.2, peakIntervalLph: null,
      kT: 0.1, decayResidual: 0.02, samples: 40, distanceKm: km,
    })
    expect(announces(classifyDrain(ev(95, 50), road, STEADY))).toBe(true)   // beyond the distance
    // CHANGED 2026-08-26: a stationary drop is no longer announced on the
    // distance rule. It has no distance to be unexplained by, and saying so was
    // 7.7 alerts a day against a fleet total of ~5. It falls to the burn rule,
    // which this fixture gives no engine time to answer with.
    expect(announces(classifyDrain(ev(25.6, 0), road, STEADY))).toBe(false) // stationary
    expect(announces(classifyDrain(ev(22, 60), road, STEADY))).toBe(false)  // explained
  })

  it('the same finding on an OPERATOR ceiling is announced', () => {
    const gen = resolveBand('KASULU', 'MUFINDI - DG 13', null)!
    expect(announces(classifyDrain(running(130), gen, STEADY))).toBe(true)
  })

  it('announces() and the query lists cannot drift apart', () => {
    // The snapshot's red-vehicle lookup matches on BOTH exported lists. If
    // either disagreed with announces(), a vehicle would go red for something
    // we had decided not to say — or stay grey for something we had.
    const causes = (['ENGINE_BURN','HIGH_BURN','UNEXPLAINED_BURN','SIPHON','SLOSH','SETTLING','INDETERMINATE'] as const)
    for (const c of causes) {
      expect(announces({ cause: c, reason: 'whatever' })).toBe(ANNOUNCED_CAUSES.includes(c))
    }
    for (const r of ANNOUNCED_REASON_SLUGS) {
      expect(announces({ cause: 'UNEXPLAINED_BURN', reason: r })).toBe(true)
    }
  })
})

describe('the overread threshold', () => {
  it('sits above the observed population, not inside it', () => {
    // Measured 2026-08-17 over 339 reporting units: seven exceed 1.5x, and the
    // next one down is 1.30x — a plausible overfill or a slightly wrong
    // capacity rather than a broken scale.
    expect(MAX_FILL_RATIO).toBe(1.5)
    expect(probeOverreads({ parkedWindows: 10, swingWindows: 0, fillRatio: 1.30 })).toBe(false)
    expect(probeOverreads({ parkedWindows: 10, swingWindows: 0, fillRatio: 1.59 })).toBe(true)
  })
})

describe('resolveBand', () => {
  it('gives a classified machine its class band, not a derived one', () => {
    // The whole point: an EX unit is judged on the operator's excavator band
    // even where a derived rate exists, because the derived rates are
    // measurably biased low.
    const b = resolveBand('KASULU', 'MUFINDI: EX 17', { lPerHour: 4.3, basis: 'type' })!
    expect(b.source).toBe('operator')
    expect(b.lowLph).toBe(15)
    expect(b.highLph).toBe(25)
    expect(b.ceilingLph).toBe(30)
  })

  it('attaches a km/L baseline only to unclassified (road) units', () => {
    const road = resolveBand('SUKARI', 'KDL 208X', { lPerHour: 9, basis: 'vehicle', lPerKm: 0.25 })!
    expect(road.kmPerL).toBeCloseTo(4, 6)
    // Heavy machinery gets none: distance is noise on a machine that works
    // without travelling.
    const plant = resolveBand('KASULU', 'MUFINDI: EX 17', { lPerHour: 9, basis: 'vehicle', lPerKm: 0.25 })!
    expect(plant.kmPerL).toBeUndefined()
  })

  it('withholds the distance basis from a machine that barely travels', () => {
    // KTCB 295U is a 160 L SUKARI tractor with no class — its plate carries no
    // family — and a measured 0.31 km/L. Judged on distance, a 40 L drop over
    // 0.7 km scores 36 L "unexplained" by construction. It keeps the L/h
    // comparison instead.
    const plant = resolveBand('SUKARI', 'KTCB 295U', { lPerHour: 13, basis: 'vehicle', lPerKm: 1 / 0.31 })!
    expect(plant.kmPerL).toBeUndefined()
    expect(plant.lowLph).toBe(13)

    // ...and a genuine road vehicle keeps it.
    const road = resolveBand('SUKARI', 'KCX 802S', { lPerHour: 9, basis: 'vehicle', lPerKm: 1 / 3.38 })!
    expect(road.kmPerL).toBeCloseTo(3.38, 4)
  })

  it('carries the operator bands verbatim', () => {
    // Their figures, not ours, and not adjusted to fit the fleet.
    expect(CLASS_BANDS.get('TRACTOR_SMALL')).toEqual({ lowLph: 2, highLph: 4 })
    expect(CLASS_BANDS.get('TRACTOR_LARGE')).toEqual({ lowLph: 18, highLph: 45 })
    expect(CLASS_BANDS.get('EXCAVATOR_LARGE')).toEqual({ lowLph: 15, highLph: 25 })
  })

  it('bands the CTR crawlers well above the excavators', () => {
    // They were briefly given the same band. Per machine they are not alike:
    // an EX drain implies 17-30 L/h and a CTR drain 46-111, and on the
    // excavator band three crawlers produced 76% of every alert raised.
    expect(MACHINE_CLASS.get('KASULU:EX')).toBe('EXCAVATOR_LARGE')
    expect(MACHINE_CLASS.get('KASULU:CTR')).toBe('DOZER_CAT_D10')
    const ex  = CLASS_BANDS.get(MACHINE_CLASS.get('KASULU:EX')!)!
    const ctr = CLASS_BANDS.get(MACHINE_CLASS.get('KASULU:CTR')!)!
    expect(ctr.lowLph).toBeGreaterThan(ex.highLph)
  })

  it('leaves the machines nobody has classified unmapped', () => {
    // Dozers need a MODEL, not a size class, and SUKARI's plates carry no
    // family at all. Both fall back to a derived rate rather than a guess.
    expect(MACHINE_CLASS.get('KASULU:DZ')).toBeUndefined()
    expect(MACHINE_CLASS.get('KASULU:WL')).toBeUndefined()
    expect(MACHINE_CLASS.get('SUKARI:KTCB')).toBeUndefined()
  })

  it('reads the operator machine family off the plate', () => {
    expect(machinePrefix('MUFINDI - CTR 10')).toBe('CTR')
    expect(machinePrefix('MUFINDI: EX 26')).toBe('EX')
    expect(machinePrefix('MUFINDI - DZ 07')).toBe('DZ')
    // SUKARI plates are ordinary registrations with no family in them.
    expect(machinePrefix('KTCB 295U')).toBe('KTCB')
  })

  it('splits one prefix into two classes on tank size', () => {
    // KASULU: DZ is two different machines. The 640 L group burns three times
    // what the 450 L pair does, and one band across both would hold the small
    // ones to a ceiling they never approach.
    const big   = resolveClass('KASULU', { plate: 'MUFINDI: DZ 14', tankCapacityLitres: 640 })
    const small = resolveClass('KASULU', { plate: 'MUFINDI - DZ 02', tankCapacityLitres: 450 })
    expect(big).toBe('DOZER_CAT_D8T')
    expect(small).toBe('DOZER_SMALL')
    expect(CLASS_BANDS.get(small!)!.highLph).toBeLessThan(CLASS_BANDS.get(big!)!.lowLph)
  })

  it('classes on vehicle type when the plate carries no family', () => {
    // SUKARI's 482 tractors are on ordinary registrations. Type is the only
    // thing that groups them.
    expect(resolveClass('SUKARI', { plate: 'KTCC 100G', vehicleType: 'TRACTOR' })).toBe('TRACTOR_MEDIUM')
    expect(TYPE_CLASS.get('SUKARI:TRACTOR')).toBe('TRACTOR_MEDIUM')
    // A road vehicle in the same fleet must NOT pick up a burn band — it is
    // judged on km/L, and a tractor's litres-per-hour would be meaningless.
    expect(resolveClass('SUKARI', { plate: 'KCX 802S', vehicleType: 'TRUCK' })).toBeNull()
  })

  it('falls through to the derived rate when the tank is unknown', () => {
    // The size split needs a capacity. Without one the machine is unclassed and
    // gets its own measured rate, widened — never a guessed band.
    expect(resolveClass('KASULU', { plate: 'MUFINDI: DZ 14' })).toBeNull()
    expect(CLASS_BY_TANK.has('KASULU:DZ')).toBe(true)
    const b = resolveBand('KASULU', 'MUFINDI: DZ 14', { lPerHour: 10, basis: 'vehicle' })!
    expect(b.lowLph).toBe(10)
    expect(b.highLph).toBe(10 * DERIVED_BAND_SPREAD)
    expect(b.source).toBe('vehicle')
  })

  it('is null when nothing is known, so the caller must not judge', () => {
    expect(resolveBand('KASULU', 'MUFINDI: DZ 14', null)).toBeNull()
    expect(resolveBand('KASULU', 'MUFINDI: DZ 14', { lPerHour: 0, basis: 'type' })).toBeNull()
  })
})

describe('the consumption basis — which denominator judges this machine', () => {
  // DISTANCE is the default (operator, 2026-08-26). HOURS is the exception,
  // for machines that work without travelling.
  it('sends road vehicles to distance', () => {
    for (const t of ['TRUCK', 'LORRY', 'SALOON', 'BUS', 'COMPANY_VEHICLE']) {
      expect(resolveBasis('SUKARI', { plate: 'KDL 207X', vehicleType: t })).toBe('DISTANCE')
    }
  })

  it('sends plant and generators to hours', () => {
    expect(resolveBasis('KASULU', { plate: 'MUFINDI: GR 04', vehicleType: 'PLANT' })).toBe('HOURS')
    expect(resolveBasis('KASULU', { plate: 'MUFINDI: GEN 01', vehicleType: 'GENERATOR' })).toBe('HOURS')
  })

  it('sends EVERY tractor to hours, because their work is done standing still', () => {
    // Measured 2026-08-26: of 339 tractor drains over 15 L, 273 (80.5%) covered
    // less than 0.5 km during the fall. On a distance basis each scores ~100%
    // unexplained and announces — about nine a day against ~5/day fleet-wide.
    // KTCB 295U is four of the top eight, and is the vehicle ROAD_MIN_KM_PER_L
    // was written to protect.
    expect(resolveBasis('SUKARI', { plate: 'KTCC 117D', vehicleType: 'TRACTOR' })).toBe('HOURS')
    expect(resolveBasis('KASULU', { plate: 'MUFINDI: CTR 02', vehicleType: 'TRACTOR' })).toBe('HOURS')
    expect(resolveBasis('SUKARI', { plate: 'KTCB 295U', vehicleType: 'TRACTOR' })).toBe('HOURS')
  })

  it('the rule is not "it travels" but "its work IS travelling"', () => {
    // A tractor travels between jobs and works stationary; a truck's work is the
    // kilometres. Median km per engine-hour is 6.08 for tractors against 7.81
    // for lorries — close enough that travel alone cannot separate them, which
    // is why the type decides.
    expect(resolveBasis('SUKARI', { plate: 'KTCC 117D', vehicleType: 'TRACTOR' })).toBe('HOURS')
    expect(resolveBasis('KASULU', { plate: 'MUFINDI - FTT 01', vehicleType: 'LORRY' })).toBe('DISTANCE')
  })

  it('lets the machine CLASS override a type that would mislead', () => {
    // A generator reaches its class through MACHINE_CLASS while carrying
    // vehicleType UNSPECIFIED. Without the class check it would take the
    // default and be judged on kilometres it never covers.
    expect(resolveClass('KASULU', { plate: 'MUFINDI - DG 13' })).toBe('GENERATOR')
    expect(resolveBasis('KASULU', { plate: 'MUFINDI - DG 13', vehicleType: 'UNSPECIFIED' })).toBe('HOURS')
  })

  it('an excavator is hours whatever its type says', () => {
    expect(resolveBasis('KASULU', { plate: 'MUFINDI: EX 20', vehicleType: 'UNSPECIFIED' })).toBe('HOURS')
  })

  it('defaults to distance when nothing is known', () => {
    expect(resolveBasis('SUKARI', { plate: 'KTCC 999Z' })).toBe('DISTANCE')
  })

  it('answers for the four cases the retired prefix list got wrong', () => {
    // `fleet-state` kept its own list of "categories whose work IS travel" —
    // LMV, FT, FTT, MTR, BUS, TRK — and asked it instead of asking here. It was
    // wrong in both directions at once, so this pins each case rather than the
    // deletion.
    //
    // IN the list and shouldn't have been. A motor tractor works a field
    // standing still; twenty of KASULU's read Idling for every hour of it.
    expect(resolveBasis('KASULU', { plate: 'MUFINDI: MTR 07', vehicleType: 'TRACTOR' })).toBe('HOURS')
    // OUT of it and shouldn't have been. 24.1 km per engine hour — the most
    // road-going code in the fleet after the buses — and no idle figure at all.
    expect(resolveBasis('KASULU', { plate: 'MUFINDI - HFT 02', vehicleType: 'LORRY' })).toBe('DISTANCE')
    // Out of it BY CONSTRUCTION. SUKARI plates carry no equipment code, so a
    // list of KASULU prefixes could never match that organisation's 110 road
    // vehicles. The stated type matches them all.
    expect(resolveBasis('SUKARI', { plate: 'KDL 431T', vehicleType: 'TRUCK' })).toBe('DISTANCE')
    // The prefix is not even reliably the machine: `OPTIM` is a SITE, and those
    // 24 units split once their type is read instead of their plate.
    expect(resolveBasis('KASULU', { plate: 'MUFINDI: OPTIM - CM 01', vehicleType: 'PLANT' })).toBe('HOURS')
    expect(resolveBasis('KASULU', { plate: 'MUFINDI: OPTIM - FT 09', vehicleType: 'TRUCK' })).toBe('DISTANCE')
  })
})

describe('a truck switches denominator with what it is DOING', () => {
  // Operator, 2026-08-26: "Commercial trucks measure fuel consumption by
  // distance when traveling on the open road, but switch to time (per hour)
  // when idling or operating specialized equipment."
  it('judges a travelling road vehicle on distance', () => {
    expect(applicableBasis('DISTANCE', 12)).toBe('DISTANCE')
    expect(applicableBasis('DISTANCE', OPEN_ROAD_MIN_KM)).toBe('DISTANCE')
  })

  it('judges the same vehicle on hours once it stops', () => {
    // 4/5 of distance-basis drains carry 0.000 km. Judged on distance each one
    // scores ~100% unexplained by construction; judged on hours it is asked the
    // question that fits — is this more than it burns while idling.
    expect(applicableBasis('DISTANCE', 0)).toBe('HOURS')
    expect(applicableBasis('DISTANCE', 0.014)).toBe('HOURS')
  })

  it('treats no speed reading as unknown, not as standing still', () => {
    // Null is not zero. Asserting a distance of 0 would call the whole drop
    // unexplained on the strength of having measured nothing.
    expect(applicableBasis('DISTANCE', null)).toBe('HOURS')
  })

  it('never switches an hours machine, however far it tracks', () => {
    // An excavator that tracks 2 km across a site has not become a haulier.
    expect(applicableBasis('HOURS', 2)).toBe('HOURS')
    expect(applicableBasis('HOURS', 50)).toBe('HOURS')
  })

  it('a stationary road drain reaches the burn rule, not the distance rule', () => {
    const band: BurnBand = { lowLph: 5, highLph: 10, source: 'vehicle', kmPerL: 3 }
    // 40 L over 2 engine-hours = 20 L/h, twice the band's upper edge, no travel.
    const ev: DropEvidence = { ...running(20, 2), distanceKm: 0 }
    const j = classifyDrain(ev, band, STEADY, 'DISTANCE')
    expect(j.reason).not.toBe('drop-while-stationary')
    expect(j.reason).toMatch(/^burn-/)
  })

  it('...and a travelling one still reaches the distance rule', () => {
    const band: BurnBand = { lowLph: 5, highLph: 10, source: 'vehicle', kmPerL: 3 }
    const ev: DropEvidence = { ...running(20, 2), distanceKm: 12 }
    const j = classifyDrain(ev, band, STEADY, 'DISTANCE')
    expect(j.reason).toBe('drop-exceeds-distance')
  })
})

describe('which causes mean the fuel never left', () => {
  // The verdict answers "was this a real drop"; the CAUSE answers "was it fuel".
  // A row can be judged DRAIN — the level fell and stayed down — and still be a
  // reading rather than a loss once the shape of the fall is examined.
  it('excludes the two where the tank is unchanged afterwards', () => {
    expect([...CAUSE_NO_FUEL_LEFT].sort()).toEqual(['SETTLING', 'SLOSH'])
  })

  it('does NOT exclude engine burn — operator, 2026-08-28', () => {
    // "Do not remove engine burn, it is part of fuel drain." The figure counts
    // fuel that LEFT THE TANK, not fuel that was taken, and the engine burning
    // it is still it leaving. 17,104 L over 30 days — five times the slosh this
    // list does remove, which is why it was asked rather than assumed.
    expect(CAUSE_NO_FUEL_LEFT).not.toContain('ENGINE_BURN')
  })

  it('does NOT exclude what it merely could not explain', () => {
    // The governing rule of the whole module: remove what you can DISPROVE, not
    // what you doubt. Together these are 88% of the litres, and dropping them
    // because nobody could attribute them would be inventing an answer.
    expect(CAUSE_NO_FUEL_LEFT).not.toContain('INDETERMINATE')
    expect(CAUSE_NO_FUEL_LEFT).not.toContain('SIPHON')
    expect(CAUSE_NO_FUEL_LEFT).not.toContain('UNEXPLAINED_BURN')
    expect(CAUSE_NO_FUEL_LEFT).not.toContain('HIGH_BURN')
  })

  it('names causes the classifier can actually produce', () => {
    // A typo here removes nothing and reports success. Both must be reachable
    // outputs of classifyDrain, not strings that merely look like causes.
    expect(causeOf(parked(40, 0.5))).toBe('SLOSH')                                // 4,800 L/h
    expect(causeOf(parked(40, 60, { kT: 3, decayResidual: 0.01 }))).toBe('SETTLING')
  })
})
