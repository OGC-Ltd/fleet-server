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
  classifyDrain, resolveBand, isAnnounced, mayUseTheftWording,
  ANNOUNCE_MULTIPLE, MAX_PLAUSIBLE_REMOVAL_LPH, SIPHON_MIN_DROP_ML,
  DERIVED_BAND_SPREAD, MACHINE_CLASS, CLASS_BANDS, machinePrefix,
  type DropEvidence, type BurnBand, type DrainCause,
} from '../../src/modules/fuel/fuel-theft-classifier.js'
import type { ProbeProfile } from '../../src/modules/fuel/fuel-adjudication.js'

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
    kT:             0.1,
    decayResidual:  0.02,
    samples:        60,
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
    kT:             0.1,
    decayResidual:  0.02,
    samples:        40,
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

  it('far above the band is announced', () => {
    const j = classifyDrain(running(10 * ANNOUNCE_MULTIPLE), BAND, STEADY)
    expect(j.cause).toBe('UNEXPLAINED_BURN')
    expect(isAnnounced(j.cause)).toBe(true)
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

  it('too small, too slow or too brief is not judged at all', () => {
    expect(causeOf(parked(SIPHON_MIN_DROP_ML / 1000 - 1, 60))).toBe('INDETERMINATE')  // magnitude
    expect(causeOf(parked(20, 60 * 8))).toBe('INDETERMINATE')                          // ~2.5 L/h
    // Brief, but at a rate a hose could actually draw (16 L in 8 min = 120 L/h).
    // A steeper "brief" case would trip the physical ceiling first and come
    // back SLOSH — correctly, but it would not be testing this floor.
    expect(causeOf(parked(16, 8))).toBe('INDETERMINATE')
  })

  it('the physical ceiling is checked before the duration floor', () => {
    // 40 L in 5 minutes is 480 L/h. That is not a brief siphon, it is not a
    // siphon at all — no hose draws it — so the reading is what is wrong.
    expect(causeOf(parked(40, 5))).toBe('SLOSH')
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

describe('the rules that must not be relaxed', () => {
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

  it('a parked STEP is the instrument, not a hose', () => {
    // The inverse of the original hypothesis. Confirmed drains are the least
    // steppy population on the ledger; the distrusted-probe population is the
    // steppiest. A siphon takes minutes and does not empty a tank between two
    // consecutive pings.
    expect(causeOf(parked(40, 60, { stepFraction: 0.95 }))).toBe('INDETERMINATE')
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

  it('exactly two causes reach an operator', () => {
    const announced = (['ENGINE_BURN', 'HIGH_BURN', 'UNEXPLAINED_BURN', 'SIPHON', 'SLOSH', 'SETTLING', 'INDETERMINATE'] as const)
      .filter(isAnnounced)
    expect([...announced].sort()).toEqual(['SIPHON', 'UNEXPLAINED_BURN'])
  })
})

describe('resolveBand', () => {
  it('carries the operator bands verbatim', () => {
    // Their figures, not ours, and not adjusted to fit the fleet.
    expect(CLASS_BANDS.get('TRACTOR_SMALL')).toEqual({ lowLph: 2, highLph: 4 })
    expect(CLASS_BANDS.get('TRACTOR_LARGE')).toEqual({ lowLph: 18, highLph: 45 })
    expect(CLASS_BANDS.get('EXCAVATOR_LARGE')).toEqual({ lowLph: 15, highLph: 25 })
  })

  it('assigns no machine to a class until the operator confirms the mapping', () => {
    // A 10x decision on the denominator of a live alert. Empty is the correct
    // state, not an oversight — see MACHINE_CLASS.
    expect(MACHINE_CLASS.size).toBe(0)
  })

  it('reads the operator machine family off the plate', () => {
    expect(machinePrefix('MUFINDI - CTR 10')).toBe('CTR')
    expect(machinePrefix('MUFINDI: EX 26')).toBe('EX')
    expect(machinePrefix('MUFINDI - DZ 07')).toBe('DZ')
    // SUKARI plates are ordinary registrations with no family in them.
    expect(machinePrefix('KTCB 295U')).toBe('KTCB')
  })

  it('widens a derived point estimate into a band', () => {
    const b = resolveBand('KASULU', 'MUFINDI - CTR 10', { lPerHour: 10, basis: 'vehicle' })!
    expect(b.lowLph).toBe(10)
    expect(b.highLph).toBe(10 * DERIVED_BAND_SPREAD)
    expect(b.source).toBe('vehicle')
  })

  it('is null when nothing is known, so the caller must not judge', () => {
    expect(resolveBand('KASULU', 'MUFINDI - CTR 10', null)).toBeNull()
    expect(resolveBand('KASULU', 'MUFINDI - CTR 10', { lPerHour: 0, basis: 'type' })).toBeNull()
  })
})
