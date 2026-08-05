/**
 * The anti-fabrication guard on the Fleet AI Insight brief.
 *
 * The card's whole value is that a fleet manager can act on it, so a
 * plausible-looking figure nobody measured is the worst thing it can produce —
 * worse than a dull brief, because it is indistinguishable from a real one. The
 * prompt asks the model not to invent; this is what ENFORCES it.
 *
 * The check is deliberately syntactic: every digit-run in the reply must appear
 * somewhere in the facts. It cannot catch a real number taken from the wrong
 * field, and does not claim to — it makes invention out of whole cloth
 * impossible, which a written instruction never can.
 */

import { describe, it, expect } from 'vitest'
import { fabricatedFigures, leakedFieldNames, buildFleetFallback } from '../../src/modules/dashboard/ai-insight.js'

const facts = {
  fleetNow: {
    vehicles: 597, connectionKnown: true, online: 80, offline: 200, connectionUnknown: 317,
    enginesOn: 53, inTransit: 5, idling: 11, parked: 264, lowFuel: 173,
    inMaintenance: 0, insideKeepOutZone: 0, onRunByLeg: {},
  },
  working: {
    positioned: 80,
    byArea: [{ area: 'FARM#212', category: 'farm', units: 22 }],
    areasNotShown: 0, outsideAnyEstateFeature: 58,
  },
  today: {
    asOfLocal: '09:24', sinceLabel: 'this morning', quiet: false,
    dispatchesRaised: 74, leftGate: 70, stillInYard: 4, returned: 12,
    outNow: 67, outNowOverdue: 24,
    byDestination: [
      { destination: 'WEIGHBRIDGE Y', units: 50 },
      { destination: 'WEIGHBRIDGE X', units: 20 },
    ],
    destinationsNotShown: 0, destinationNotRecorded: 0,
    outNowByDestination: [{ destination: 'NYAONDO', units: 67 }],
    outNowDestinationsNotShown: 0,
    fuelIssues: {
      raised: 19, needInvestigating: 5, stillSettling: 9, ruledOut: 4,
      unverifiable: 1, litresConfirmedLost: 57.3,
    },
    feed: {
      byKind: { ZONE_ENTRY: 2914 },
      overspeedingAlerts: 3,
      latest: [{ at: '09:12', severity: 'warning', text: 'KTCB 295U flagged for a fuel drop' }],
    },
  },
}

describe('fabricatedFigures', () => {
  it('passes a brief whose every figure was measured', () => {
    const msg = 'The fleet is working steadily, with 80 online, 5 in transit and 11 idling. '
      + 'We have had 70 units leave the gate this morning, with 20 going to WEIGHBRIDGE X and '
      + '50 going to WEIGHBRIDGE Y. On the ground, 22 units are working FARM#212. '
      + 'There are 19 fuel issues raised, 5 of which need investigating.'
    expect(fabricatedFigures(msg, facts)).toEqual([])
  })

  it('catches a total the model computed for itself', () => {
    // 5 + 11 + 264 = 280. Arithmetic the model was never asked to do, and a
    // figure that appears nowhere in the data — the exact failure seen in
    // rollout.
    const msg = 'The fleet has 280 units accounted for, with 5 in transit.'
    expect(fabricatedFigures(msg, facts)).toEqual(['280'])
  })

  it('catches an invented figure even when the rest of the brief is sound', () => {
    const msg = 'We have had 70 units leave the gate this morning, averaging 47 minutes at the gate.'
    expect(fabricatedFigures(msg, facts)).toEqual(['47'])
  })

  it('allows digits inside names it is quoting back', () => {
    // FARM#212 and KTCB 295U are facts too — they arrive as strings, and a
    // brief that names them must not be rejected for it.
    const msg = 'On the ground, 22 units are working FARM#212. Latest: KTCB 295U flagged at 09:12.'
    expect(fabricatedFigures(msg, facts)).toEqual([])
  })

  it('reads a thousands separator as the same figure', () => {
    const msg = 'The feed carried 2,914 zone crossings today.'
    expect(fabricatedFigures(msg, facts)).toEqual([])
  })

  it('allows a decimal quoted exactly, and rejects one that was re-rounded', () => {
    expect(fabricatedFigures('57.3 litres confirmed lost.', facts)).toEqual([])
    // 57 is not 57.3 — a re-rounded figure is a different claim, and this is the
    // card that must agree with the fuel ledger to the decimal.
    expect(fabricatedFigures('About 57 litres were lost.', facts)).toEqual(['57'])
  })

  it('does NOT catch a figure that collides with digits in a name', () => {
    // The known limit of a syntactic check, pinned so it is a documented
    // property rather than a surprise: `212` is citable here only because the
    // facts contain FARM#212, so a brief inventing "212 units" passes. Quoting
    // area and plate names is worth that much slack — the alternative is
    // rejecting every brief that names FARM#212 — and the guard's job is to
    // stop invention out of whole cloth, not to police every collision.
    expect(fabricatedFigures('There are 212 units on site.', facts)).toEqual([])
  })

  it('passes a brief with no figures at all', () => {
    expect(fabricatedFigures('The fleet is quiet and nothing has been dispatched.', facts)).toEqual([])
  })
})

describe('buildFleetFallback', () => {
  it('writes the whole brief from the facts, inventing nothing', () => {
    const msg = buildFleetFallback(facts as never)
    expect(msg).toBe(
      'The fleet is running with 80 online, 5 in transit, 11 idling, 264 parked. '
      + '70 units have left the gate this morning, with 50 to WEIGHBRIDGE Y and 20 to WEIGHBRIDGE X. '
      + '67 units are out, 24 of them overdue, and 12 have returned today. '
      + 'On the ground, 22 in FARM#212. '
      + 'There are 19 fuel issues raised, 5 of which need investigating, and 3 overspeeding alerts.',
    )
    // The floor has to satisfy the same guard it exists to back up.
    expect(fabricatedFigures(msg, facts)).toEqual([])
  })

  it('says the shift is empty rather than listing zeroes', () => {
    const quiet = {
      fleetNow: {
        vehicles: 218, connectionKnown: false, online: null, offline: null, connectionUnknown: 218,
        enginesOn: 29, inTransit: 0, idling: 0, parked: 158, lowFuel: 12,
        inMaintenance: 0, insideKeepOutZone: 0, onRunByLeg: {},
      },
      working: { positioned: 0, byArea: [], areasNotShown: 0, outsideAnyEstateFeature: 0 },
      today: {
        asOfLocal: '00:41', sinceLabel: 'this morning', quiet: true,
        dispatchesRaised: 0, leftGate: 0, stillInYard: 0, returned: 0,
        outNow: 0, outNowOverdue: 0,
        byDestination: [], destinationsNotShown: 0, destinationNotRecorded: 0,
        outNowByDestination: [], outNowDestinationsNotShown: 0,
        fuelIssues: {
          raised: 0, needInvestigating: 0, stillSettling: 0, ruledOut: 0,
          unverifiable: 0, litresConfirmedLost: 0,
        },
        feed: { byKind: {}, overspeedingAlerts: 0, latest: [] },
      },
    }
    const msg = buildFleetFallback(quiet as never)
    expect(msg).toBe(
      'The fleet is running with 158 parked. '
      + 'Nothing has been dispatched yet today. '
      + 'No exceptions have been raised today.',
    )
    // No connectivity claim when the poller has no answer, and no zeroes.
    expect(msg).not.toMatch(/online|offline/)
    expect(msg).not.toMatch(/\b0\b/)
  })
})

describe('leakedFieldNames', () => {
  it('catches a brief that prints its own JSON keys', () => {
    // Seen in production 2026-08-05. Every figure in it was measured, so the
    // fabrication guard had no reason to fire — the sentence was still a
    // leaked debug line to the person it is written for.
    expect(leakedFieldNames('Today outNow stands at 138, with no overdue units, and 17 have returned.'))
      .toEqual(['outNow'])
  })

  it('leaves ordinary prose alone', () => {
    expect(leakedFieldNames(
      'The fleet is running steadily, with 98 online, 24 in transit and 235 parked; risk is medium. '
      + '138 units are still out and 17 have returned.',
    )).toEqual([])
  })
})
