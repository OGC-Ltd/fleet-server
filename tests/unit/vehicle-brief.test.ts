/**
 * The facts-only brief.
 *
 * This is the floor the feature stands on: no OPENAI_API_KEY, a timeout, or a
 * malformed reply all land here, and the operator must still get the same
 * information. It is also the specification for what the model is allowed to
 * say — the model is handed these facts and told to narrate them and nothing
 * else, so anything absent here is something it must not claim either.
 */

import { describe, it, expect } from 'vitest'
import {
  buildFallback, modelBriefRejectionReason, type VehicleFacts,
} from '../../src/modules/vehicles/vehicle-brief.js'

const facts = (over: Partial<VehicleFacts> = {}): VehicleFacts => ({
  plate: 'KCW 865K',
  driver: 'VICTOR OOKO OKELLO',
  driverSource: 'dispatch',
  startedAt: '23:16',
  startedSource: 'dispatch',
  distanceTodayKm: 61.4,
  refuelledLitres: 57.3,
  refuelCount: 1,
  refuelLocations: ['Ndhiwa-Uriri, Riat Centre'],
  dispatchStatus: 'DISPATCHED',
  dispatchedAtLocal: '23:16 yesterday',
  leftYardLocal: '01:02',
  leftYardSource: 'gate',
  yardWaitHours: 1.8,
  destination: 'OPAPO',
  leg: 'returning',
  dueBackAt: '2026-08-03T08:04:57.291Z',
  dueBackLocal: '11:04',
  dueBackSource: 'history',
  lastRunDestination: null,
  lastRunDispatchedAtLocal: null,
  lastRunReturnedAtLocal: null,
  speedKmh: 42,
  fuelLevelPct: 63,
  online: true,
  lastReportedLocal: '01:50',
  ...over,
})

describe('buildFallback', () => {
  it('answers the operator question: who, since when, what, where, due back', () => {
    const msg = buildFallback(facts())
    expect(msg).toContain('VICTOR OOKO OKELLO')
    expect(msg).toContain("today's dispatch")
    expect(msg).toContain('since 23:16')
    expect(msg).toContain('61.4 km')
    expect(msg).toContain('57.3 L')
    expect(msg).toContain('OPAPO')
    expect(msg).toContain('on its way back')
    expect(msg).toContain('due back 11:04')
  })

  it('omits a figure entirely rather than printing a zero for it', () => {
    // A unit with no fixes today has not "covered 0 km" — nothing is known
    // about its distance, and the two must not read the same. Same for fuel.
    const msg = buildFallback(facts({ distanceTodayKm: null, refuelledLitres: null, refuelCount: 0, refuelLocations: [] }))
    expect(msg).not.toContain('0 km')
    expect(msg).not.toContain('0 L')
    expect(msg).not.toContain('It has')
    // …while everything still known is still said.
    expect(msg).toContain('VICTOR OOKO OKELLO')
    expect(msg).toContain('OPAPO')
  })

  it('says so when there is no driver on record', () => {
    // 502 of Sukari's 597 vehicles have no assignment, and most are not out on
    // a dispatch either. "Unassigned" is a real answer, not a blank.
    const msg = buildFallback(facts({ driver: null, driverSource: null }))
    expect(msg).toContain('no driver on record')
  })

  it('does not claim a dispatch when none is open', () => {
    const msg = buildFallback(facts({
      destination: null, leg: null, dueBackLocal: null, dueBackSource: null,
      dispatchStatus: null, dispatchedAtLocal: null,
      leftYardLocal: null, leftYardSource: null, yardWaitHours: null,
    }))
    expect(msg).toContain('No dispatch open')
    expect(msg).not.toContain('due back')
    expect(msg).not.toContain('left the yard')
  })

  it('separates when the run was raised from when the unit actually left', () => {
    // A quarter of the units carrying an open dispatch are still standing in
    // the yard, so "dispatched 23:16" and "left 01:02" are two facts and the
    // gap between them is the one an operator is looking for.
    const msg = buildFallback(facts())
    expect(msg).toContain('Dispatched 23:16 yesterday to OPAPO')
    expect(msg).toContain('left the yard at 01:02')
    expect(msg).toContain('1.8 h after being dispatched')
  })

  it('does not claim a departure for a unit still in the yard', () => {
    // Nothing measured it out of the yard, so nothing may say it left.
    const msg = buildFallback(facts({
      leg: 'at-yard', leftYardLocal: null, leftYardSource: null, yardWaitHours: null,
    }))
    expect(msg).toContain('is still at the yard')
    expect(msg).not.toContain('left the yard')
  })

  it('flags an overdue dispatch as overdue', () => {
    const msg = buildFallback(facts({ dispatchStatus: 'OVERDUE' }))
    expect(msg).toContain('(overdue)')
  })

  it('quotes the refuel place as shortened, never re-expanded', () => {
    const msg = buildFallback(facts())
    expect(msg).toContain('at Ndhiwa-Uriri, Riat Centre')
    expect(msg).not.toContain('County')
  })

  it('names the driver of a run that has already finished', () => {
    // Production, KTCC 832B: it ran to OGANDO CENTRAL with PETER OUMA ODIEGI and
    // was back by 09:05, and the brief said "has no driver on record. No
    // dispatch open." Only 95 of 597 vehicles carry a standing assignment, so
    // for the rest the closed dispatch is the only record of who drove today —
    // and it is a record, not a guess.
    const msg = buildFallback(facts({
      driver: 'PETER OUMA ODIEGI', driverSource: 'last-dispatch',
      destination: null, leg: null, dueBackLocal: null, dueBackSource: null,
      dispatchStatus: null, dispatchedAtLocal: null,
      leftYardLocal: null, leftYardSource: null, yardWaitHours: null,
      lastRunDestination: 'OGANDO CENTRAL',
      lastRunDispatchedAtLocal: '06:12',
      lastRunReturnedAtLocal: '09:05',
    }))
    expect(msg).toContain('PETER OUMA ODIEGI')
    expect(msg).not.toContain('no driver on record')
    expect(msg).not.toContain('No dispatch open')
    // Past tense — the vehicle is parked, so nothing may read as still out.
    expect(msg).toContain('was with')
    expect(msg).toContain('ran to OGANDO CENTRAL today')
    expect(msg).toContain('back at 09:05')
    expect(msg).not.toContain('due back')
  })

  it('still says nothing about a run it cannot confirm came back', () => {
    const msg = buildFallback(facts({
      driver: 'PETER OUMA ODIEGI', driverSource: 'last-dispatch',
      destination: null, leg: null, dueBackLocal: null, dueBackSource: null,
      dispatchStatus: null, dispatchedAtLocal: null,
      leftYardLocal: null, leftYardSource: null, yardWaitHours: null,
      lastRunDestination: 'OGANDO CENTRAL',
      lastRunDispatchedAtLocal: '06:12',
      lastRunReturnedAtLocal: null,
    }))
    expect(msg).toContain('no return time recorded')
    expect(msg).not.toContain('back at')
  })

  it('reports a silent unit as silent, not as stationary', () => {
    const msg = buildFallback(facts({ leg: 'no-fix', distanceTodayKm: null }))
    expect(msg).toContain('has not reported since it was dispatched')
  })

  it('does not attribute a standing assignment to today\'s run', () => {
    // The phrase "on today's dispatch" is a claim about WHO TOOK THE KEYS. It
    // may only appear when the name came from the dispatch itself.
    const msg = buildFallback(facts({ driverSource: 'assignment' }))
    expect(msg).toContain('VICTOR OOKO OKELLO')
    expect(msg).not.toContain("today's dispatch")
  })
})

/**
 * The gate the model's version has to pass.
 *
 * The model buys phrasing, not information. A reply that loses a fact we
 * measured, or announces one we did not, is worse than the deterministic
 * sentence — and the deterministic sentence is already written, so there is no
 * cost to refusing. Both rejection cases below are verbatim production output.
 */
describe('modelBriefRejectionReason', () => {
  it('accepts a faithful rendering', () => {
    const msg = 'KCW 865K is with VICTOR OOKO OKELLO, out since 23:16 yesterday. '
      + 'It has covered 61.4 km today and taken on 57.3 L at Ndhiwa-Uriri, Riat Centre. '
      + 'Dispatched to OPAPO, it left the yard at 01:02 and is due back 11:04.'
    expect(modelBriefRejectionReason(msg, facts())).toBeNull()
  })

  it('rejects a reply that announces what we did not measure', () => {
    // Production, KDL 705E: the driver WAS known and the model still spent half
    // the brief listing nulls. An operator reading "not reported" beside a card
    // showing the value stops trusting both.
    const msg = 'Driver FREDRICK OCHIENG ONGOLA since 07:45. Distance today: 61.4 km; '
      + 'fuel data not reported. Left yard 07:45 local; yard wait hours not reported.'
    expect(modelBriefRejectionReason(msg, facts({ driver: 'FREDRICK OCHIENG ONGOLA' })))
      .toMatch(/narrates an absence/)
  })

  it('rejects a reply that drops the driver we know', () => {
    const msg = 'KCW 865K has covered 61.4 km today and is on its way back from OPAPO.'
    expect(modelBriefRejectionReason(msg, facts())).toBe('omits the driver we know')
  })

  it('accepts a name the model re-cased', () => {
    // The provider writes names in upper case; title case is a phrasing choice,
    // not a lost fact.
    const msg = 'KCW 865K is with Victor Ooko Okello and has covered 61.4 km today.'
    expect(modelBriefRejectionReason(msg, facts())).toBeNull()
  })

  it('rejects a distance that is not the one on the card', () => {
    const msg = 'KCW 865K is with VICTOR OOKO OKELLO and has covered 61 km today.'
    expect(modelBriefRejectionReason(msg, facts())).toMatch(/does not quote distanceTodayKm/)
  })

  it('does not accept a near-miss figure that merely contains the real one', () => {
    // "0.1" appears inside "10.1". Catching the near miss is the whole point.
    const msg = 'KCW 865K is with VICTOR OOKO OKELLO and has covered 10.1 km today.'
    expect(modelBriefRejectionReason(msg, facts({ distanceTodayKm: 0.1 })))
      .toMatch(/does not quote distanceTodayKm/)
  })

  it('asks nothing of a figure the fleet does not have', () => {
    // No distance measured ⇒ no distance required in the sentence, and saying
    // nothing about it is exactly right.
    const msg = 'KCW 865K is with VICTOR OOKO OKELLO, out since 23:16 yesterday, on a run to OPAPO.'
    expect(modelBriefRejectionReason(msg, facts({ distanceTodayKm: null }))).toBeNull()
  })

  it('does not require a driver the fleet does not have', () => {
    const msg = 'KCW 865K has covered 61.4 km today on a run to OPAPO.'
    expect(modelBriefRejectionReason(msg, facts({ driver: null, driverSource: null }))).toBeNull()
  })
})
