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

import { classifyByNameAndTank, statedTankLitres } from '../../src/providers/wialon/wialon.vehicle-type.js'

const fuel = (n: string) => ({ a: { n, t: 'fuel level' } })

/** Names and sensor names verbatim from the live Timsales / Aquamist units, 2026-10-07. */
describe('classifyByNameAndTank — Timsales and Aquamist', () => {
  it('reads machine words as plant, whatever the tank says', () => {
    expect(classifyByNameAndTank('TIMSALES - LOGGER 16')).toBe('PLANT')
    expect(classifyByNameAndTank('Timsales - LOGGER  06')).toBe('PLANT')
    expect(classifyByNameAndTank('TIMSALES - CAT 7')).toBe('PLANT')
    expect(classifyByNameAndTank('Timsales - CAT2')).toBe('PLANT')
    expect(classifyByNameAndTank('Timsales - CAT M325C')).toBe('PLANT')
    expect(classifyByNameAndTank('Timsales - BULLDOZER 05', fuel('Fuel Level (254L)'))).toBe('PLANT')
    expect(classifyByNameAndTank('TIMSALES - TIMBER JACK 3')).toBe('PLANT')
    expect(classifyByNameAndTank('Timsales -BUCKETLOADER(KBA 499A)', fuel('Fuel (258L)'))).toBe('PLANT')
  })

  it('does not read a plate as a Caterpillar', () => {
    // "KCAT…" style text must not trip the CAT rule; only "CAT <n>" does.
    expect(classifyByNameAndTank('AQUAMIST - KCA 259J', fuel('Main Tank Fuel (Qty 100L)'))).toBe('TRUCK')
  })

  it('sizes plated units by the stated tank', () => {
    expect(classifyByNameAndTank('AQUAMIST - KCH 773B', fuel('Main Tank Fuel (Qty 55L)'))).toBe('SALOON')
    expect(classifyByNameAndTank('AQUAMIST - KDE 170P', fuel('Main Tank Fuel (Qty 101L)'))).toBe('TRUCK')
    expect(classifyByNameAndTank('Timsales - KDJ 079M', fuel('Fuel Level (205L)'))).toBe('TRUCK')
    expect(classifyByNameAndTank('Timsales - KBT 801R', fuel('Fuel Level (410L)'))).toBe('LORRY')
    expect(classifyByNameAndTank('Timsales - KCP 272L', fuel('Fuel Level (590L)'))).toBe('LORRY')
  })

  it('leaves what it cannot know unspecified', () => {
    expect(classifyByNameAndTank('Timsales - KAW 605R')).toBe('UNSPECIFIED')                                  // no tank stated
    expect(classifyByNameAndTank('AQUAMIST - KMEC 054B', fuel('Main Tank Fuel (Qty 266L)'))).toBe('UNSPECIFIED') // motorcycle
    expect(classifyByNameAndTank('AQUAMIST - KBT 313D', fuel('Main Tank Fuel (Qty 266L)'))).toBe('UNSPECIFIED')  // placeholder 266
  })
})

describe('statedTankLitres — both spellings', () => {
  it('reads every measured form', () => {
    expect(statedTankLitres(fuel('Main Tank Fuel Level Qty (450L)'))).toBe(450)
    expect(statedTankLitres(fuel('Main Tank Fuel (Qty 97L)'))).toBe(97)
    expect(statedTankLitres(fuel('Reserve Tank Fuel Level Qty (100L Tank)'))).toBe(100)
    expect(statedTankLitres(fuel('Reserve Tank Fuel Level Qty (98L )'))).toBe(98)
  })
  it('takes the largest tank and ignores non-fuel sensors', () => {
    expect(statedTankLitres({
      a: { n: 'Main Tank Fuel (Qty 98L)', t: 'fuel level' },
      b: { n: 'Reserve Tank (Qty 361L)', t: 'fuel level' },
      c: { n: 'Battery (500L)', t: 'voltage' },
    })).toBe(361)
  })
})

import { statedTankCapacity } from '../../src/providers/wialon/wialon.vehicle-type.js'

describe('statedTankCapacity — what the sync stores for Timsales / Aquamist', () => {
  it('reads the Qty spelling the shared parser misses', () => {
    expect(statedTankCapacity(fuel('Main Tank Fuel (Qty 97L)'))).toBe(97)
    expect(statedTankCapacity(fuel('Main Tank (Qty 355L)'))).toBe(355)
    expect(statedTankCapacity(fuel('Main Tank (QTY 590 L)'))).toBe(590)
  })
  it('keeps the 266 L Wialon states, unlike the type rule', () => {
    expect(statedTankCapacity(fuel('Main Tank Fuel (Qty 266L)'))).toBe(266)
    expect(statedTankLitres(fuel('Main Tank Fuel (Qty 266L)'))).toBeNull()
  })
  it('is null where nothing is stated', () => {
    expect(statedTankCapacity(fuel('Virtual Tank'))).toBeNull()
    expect(statedTankCapacity(undefined)).toBeNull()
  })
})
