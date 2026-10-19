/**
 * The unit insight's deterministic half: the findings the model works from,
 * the change detector the sweep runs on, and the check every model reply must
 * pass before an operator sees it.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveFindings, factsInsight, insightRejectionReason, signalsHash, type VehicleSignals,
} from '../../src/modules/vehicles/vehicle-insight.js'

const signals = (over: Partial<VehicleSignals> = {}): VehicleSignals => ({
  plate: 'MUFINDI: EX 04',
  type: 'EXCAVATOR',
  activity: { yesterdayHours: 8, usualHours: 9, yesterdayKm: 2, usualKm: 2, workedDays: 10, knownDays: 13 },
  fuel: {
    fillings: 3, filledL: 900, openCases: [], confirmedTheft: 0, probeFault: 0, notTheft: 0,
    parkedFallsLost: 0, parkedFallsL: 0, measuredL: null, expectedL: null,
  },
  burn: { measuredLph: null, ratedLph: null },
  speeding: { count: 0, before: 0, maxOverKmh: null },
  faults: { open: [], count: 0 },
  repairs: { open: [] },
  ...over,
})

describe('deriveFindings', () => {
  it('finds nothing in an ordinary fortnight', () => {
    expect(deriveFindings(signals())).toEqual([])
    expect(factsInsight(signals(), [])).toMatchObject({ risk: 'low', findings: [] })
  })

  it('puts a possible theft first, with the cases behind it', () => {
    const fs = deriveFindings(signals({
      fuel: { ...signals().fuel, openCases: [{ id: 'c1', at: '18 Oct', litres: 40, cause: 'SIPHON' }] },
      speeding: { count: 6, before: 1, maxOverKmh: 22 },
    }))
    expect(fs[0]).toMatchObject({ kind: 'fuel_cases_open', weight: 3, refs: [{ kind: 'fuel_case', id: 'c1' }] })
    expect(fs[0].text).toContain('possible theft')
    expect(fs.map(f => f.kind)).toContain('speeding_up')
  })

  it('reads burn against the FactorySuite register only when well over', () => {
    expect(deriveFindings(signals({ burn: { measuredLph: 13, ratedLph: 12 } }))).toEqual([])
    expect(deriveFindings(signals({ burn: { measuredLph: 21.6, ratedLph: 12 } }))[0])
      .toMatchObject({ kind: 'burn_over_rated', weight: 3 })
  })

  it('never calls a unit idle without a week of rows (no fuel probe, no rollup)', () => {
    const none = { yesterdayHours: null, usualHours: null, yesterdayKm: null, usualKm: null, workedDays: 0 }
    expect(deriveFindings(signals({ activity: { ...none, knownDays: 0 } }))).toEqual([])
    expect(deriveFindings(signals({ activity: { ...none, knownDays: 13 } }))[0]).toMatchObject({ kind: 'idle_fortnight' })
  })
})

describe('signalsHash', () => {
  it('ignores the numbers, which move daily, and follows the records', () => {
    const a = deriveFindings(signals({ speeding: { count: 6, before: 1, maxOverKmh: 22 } }))
    const b = deriveFindings(signals({ speeding: { count: 7, before: 1, maxOverKmh: 25 } }))
    expect(signalsHash(a)).toBe(signalsHash(b))
    const c = deriveFindings(signals({ fuel: { ...signals().fuel, openCases: [{ id: 'c2', at: '19 Oct', litres: 9, cause: 'UNEXPLAINED_BURN' }] } }))
    expect(signalsHash(c)).not.toBe(signalsHash(a))
  })
})

describe('insightRejectionReason', () => {
  const fs = deriveFindings(signals({
    fuel: { ...signals().fuel, parkedFallsLost: 2, parkedFallsL: 21 },
    repairs: { open: [{ id: 'r1', kind: 'probe', stage: 'pending', since: '2 Oct', overdue: false }] },
  }))
  const input = { unit: { plate: 'MUFINDI: EX 04' }, findings: fs.map(f => ({ kind: f.kind, text: f.text })), signals: {}, memory: [] }
  const reply = (over: object = {}) => ({
    headline: 'Fuel fell twice while parked, 21 L in 14 days.',
    findings: [{ kind: 'repairs_open', text: 'The probe repair has been pending since 2 Oct.' }],
    action: 'Check where it parks overnight.',
    risk: 'high',
    ...over,
  })

  it('accepts a reply built from the given figures', () => {
    expect(insightRejectionReason(reply(), input, fs)).toBeNull()
  })
  it('rejects a figure it was not given', () => {
    expect(insightRejectionReason(reply({ headline: 'Fuel fell twice while parked, 25 L.' }), input, fs)).toMatch(/not given \(25\)/)
  })
  it('rejects a finding kind it made up', () => {
    expect(insightRejectionReason(reply({ findings: [{ kind: 'tyres', text: 'Tyres worn.' }] }), input, fs)).toMatch(/unknown finding kind/)
  })
  it('rejects theft with no theft finding behind it', () => {
    expect(insightRejectionReason(reply({ headline: 'Likely theft while parked, 21 L.' }), input, fs)).toMatch(/theft/)
  })
  it('rejects placeholders and narrated absences', () => {
    expect(insightRejectionReason(reply({ action: 'Driver is null.' }), input, fs)).toMatch(/placeholder/)
    expect(insightRejectionReason(reply({ action: 'Driver not recorded.' }), input, fs)).toMatch(/absence/)
  })
})
