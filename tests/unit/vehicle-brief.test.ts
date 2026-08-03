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
import { buildFallback, type VehicleFacts } from '../../src/modules/vehicles/vehicle-brief.js'

const facts = (over: Partial<VehicleFacts> = {}): VehicleFacts => ({
  plate: 'KCW 865K',
  driver: 'VICTOR OOKO OKELLO',
  driverSource: 'dispatch',
  startedAt: '23:16',
  startedSource: 'dispatch',
  distanceTodayKm: 61.4,
  refuelledLitres: 57.3,
  refuelCount: 1,
  refuelLocations: ['Ndhiwa-Uriri Rd.'],
  destination: 'OPAPO',
  leg: 'returning',
  dueBackAt: '2026-08-03T08:04:57.291Z',
  dueBackLocal: '11:04',
  dueBackSource: 'history',
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
    const msg = buildFallback(facts({ destination: null, leg: null, dueBackLocal: null, dueBackSource: null }))
    expect(msg).toContain('No dispatch open')
    expect(msg).not.toContain('due back')
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
