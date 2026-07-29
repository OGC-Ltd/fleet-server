import { describe, it, expect } from 'vitest'
import { classifyUnit } from '../../src/providers/wialon/wialon.vehicle-type.js'

/** Names below are verbatim from the live Kasulu account. */
describe('classifyUnit — the operator legend', () => {
  it('classifies plant', () => {
    expect(classifyUnit('MUFINDI - EX 09')).toBe('PLANT')   // excavator
    expect(classifyUnit('MUFINDI: DZ 14')).toBe('PLANT')    // dozer
    expect(classifyUnit('MUFINDI: WL 05')).toBe('PLANT')    // wheel loader
    expect(classifyUnit('MUFINDI: GR 01')).toBe('PLANT')    // grader
    expect(classifyUnit('MUFINDI: BH 02')).toBe('PLANT')    // backhoe
  })

  it('classifies haulage', () => {
    expect(classifyUnit('MUFINDI: FT 03')).toBe('TRUCK')    // flatbed truck
    expect(classifyUnit('MUFINDI - FT 06')).toBe('TRUCK')
    expect(classifyUnit('MUFINDI: FTT 01')).toBe('LORRY')   // flatbed TRAILER truck
    expect(classifyUnit('MUFINDI: HFT 02')).toBe('LORRY')   // heavy freight
    expect(classifyUnit('MUFINDI: DB 03')).toBe('TRUCK')
  })

  it('classifies tractors', () => {
    expect(classifyUnit('MUFINDI: MTR 07')).toBe('TRACTOR')  // motor tractor
    expect(classifyUnit('MUFINDI: CTR 21')).toBe('TRACTOR')  // cane tractor
  })

  it('classifies light vehicles', () => {
    expect(classifyUnit('MUFINDI: LMV 06')).toBe('SALOON')
  })

  it('COM and COMP are different codes', () => {
    expect(classifyUnit('MUFINDI: COM 01')).toBe('TRUCK')    // commercial vehicle
    expect(classifyUnit('MUFINDI: COMP 02')).toBe('PLANT')   // compactor
  })

  describe('name shapes that defeated the old positional regex', () => {
    it('reads the code past a SITE prefix', () => {
      // 29 units look like this; they were all read as code "OPTIM".
      expect(classifyUnit('MUFINDI: OPTIM - CM 01')).toBe('PLANT')
      expect(classifyUnit('MUFINDI: OPTIM - CTR 05')).toBe('TRACTOR')
      expect(classifyUnit('MUFINDI: OPTIM - COMP 02')).toBe('PLANT')
    })

    it('returns UNSPECIFIED for a name with no code at all', () => {
      // The old regex backtracked through "MUFIND|I" and captured a bare "I".
      expect(classifyUnit('MUFINDI: 002')).toBe('UNSPECIFIED')
      expect(classifyUnit('MUFINDI: 019')).toBe('UNSPECIFIED')
    })

    it('does not mistake a plate letter for an equipment code', () => {
      expect(classifyUnit('MUFINDI:T199 ELC')).toBe('UNSPECIFIED')
      expect(classifyUnit('MUFINDI: T 883 ENZ')).toBe('UNSPECIFIED')
    })
  })

  it('a declared TYPE field still outranks the name', () => {
    const declared = { 1: { n: 'TYPE', v: 'Excavator' } }
    // Name says light vehicle, the operator says excavator — operator wins.
    expect(classifyUnit('MUFINDI: LMV 06', declared)).toBe('PLANT')
  })
})
