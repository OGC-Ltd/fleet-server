import { describe, it, expect } from 'vitest'
import { categorise, isEstateFeature, ringAreaHa } from '../../src/lib/zone-taxonomy.js'

/**
 * The Kasulu account's 107 zones are two different things, and the notification
 * layer has to tell them apart: 40 surveyed estate features that operators know
 * by name, and 67 bulk-imported `VES` sample circles that they do not. Names
 * below are the real ones, in the real spellings — the account is inconsistent
 * about the separator and the casing.
 */
describe('categorise — VES sample points are not estate features', () => {
  it('recognises every VES spelling in the account', () => {
    for (const name of ['VES 104', 'VES-45', 'VES-101', 'VES 130b', 'VES 153b', 'VES-2']) {
      expect(categorise(name), name).toBe('sample')
      expect(isEstateFeature(categorise(name)), name).toBe(false)
    }
  })

  it('classifies the estate features by land use', () => {
    const cases: Array<[string, string]> = [
      ['FARM#210',                            'farm'],
      ['FARM #215',                           'farm'],
      ['2500 Ha Area',                        'farm'],
      ['Nursery A',                           'nursery'],
      ['Nursery - B',                         'nursery'],
      ['Commercial Area',                     'commercial'],
      ['Rainfed Area',                        'rainfed'],
      ['Factory site Location',               'factory'],
      ['Logistic centre1',                    'logistics'],
      ['Swamp area3',                         'wetland'],
      ['Wet land2',                           'wetland'],
      ['Main river malagarasi2',              'water'],
      ['DRAINS4',                             'drain'],
      ['Main Haulage road from  Factory to Zone3', 'road'],
      ['workshop1',                           'facility'],
      ['Staff Residence',                     'facility'],
      ['Reservoir site',                      'facility'],
      ['Dispensary',                          'facility'],
    ]
    for (const [name, expected] of cases) {
      expect(categorise(name), name).toBe(expected)
      expect(isEstateFeature(categorise(name)), name).toBe(true)
    }
  })

  it('an unrecognised name is still ours — only VES is excluded', () => {
    // The fallback must not silently drop a zone from the feed: anything we
    // cannot classify is still a named boundary someone drew.
    expect(categorise('Proposed labour camp Location')).toBe('facility')
    expect(isEstateFeature(categorise('Something nobody anticipated'))).toBe(true)
  })

  it('does not mistake a name that merely contains "ves"', () => {
    // `startsWith`, not `includes` — "Harvesting bay" is not a sample point.
    expect(categorise('Harvesting bay')).not.toBe('sample')
    expect(isEstateFeature(categorise('Harvesting bay'))).toBe(true)
  })
})

describe('ringAreaHa — ranks overlapping features so the smallest can lead', () => {
  it('measures a ring in hectares', () => {
    // ~1 km × ~1 km at the equator ≈ 100 ha.
    const km = 1 / 111.32
    const square: Array<[number, number]> = [[0, 0], [km, 0], [km, km], [0, km]]
    expect(ringAreaHa(square)).toBeGreaterThan(95)
    expect(ringAreaHa(square)).toBeLessThan(105)
  })

  it('orders a small block inside a large one', () => {
    const big: Array<[number, number]>   = [[30, -4], [30.1, -4], [30.1, -3.9], [30, -3.9]]
    const small: Array<[number, number]> = [[30.01, -3.99], [30.02, -3.99], [30.02, -3.98], [30.01, -3.98]]
    expect(ringAreaHa(small)).toBeLessThan(ringAreaHa(big))
  })

  it('is zero for a degenerate ring rather than NaN', () => {
    expect(ringAreaHa([])).toBe(0)
    expect(ringAreaHa([[30, -4], [30.1, -4]])).toBe(0)
  })
})
