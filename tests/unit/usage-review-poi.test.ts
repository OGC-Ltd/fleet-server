import { describe, it, expect, vi } from 'vitest'
vi.mock('../../src/lib/logger.js', () => ({ logger: { warn: () => {}, info: () => {} } }))
import { osmActivity, pickPoi, type OsmElement } from '../../src/modules/usage-review/usage-review.poi.js'

describe('osmActivity', () => {
  it('reads what a place is from its OSM tags', () => {
    expect(osmActivity({ amenity: 'bank' })).toBe('Banking')
    expect(osmActivity({ amenity: 'restaurant' })).toBe('Food and drink')
    expect(osmActivity({ amenity: 'clinic' })).toBe('Medical')
    expect(osmActivity({ healthcare: 'hospital' })).toBe('Medical')
    expect(osmActivity({ amenity: 'fuel', shop: 'convenience' })).toBe('Fuel')
    expect(osmActivity({ landuse: 'industrial' })).toBe('Work')
    expect(osmActivity({ shop: 'hardware' })).toBe('Shopping')
    expect(osmActivity({ office: 'company' })).toBe('Offices')
    expect(osmActivity({ name: 'x' })).toBeNull()
  })
})

describe('pickPoi', () => {
  const lat = 0.5, lng = 34.5
  const bank: OsmElement = { type: 'node', id: 1, lat: 0.5005, lon: 34.5, tags: { name: 'Equity Bank', amenity: 'bank' } }
  const far: OsmElement = { type: 'node', id: 2, lat: 0.503, lon: 34.5, tags: { name: 'Far Cafe', amenity: 'cafe' } }
  const works: OsmElement = { type: 'way', id: 3, center: { lat: 0.51, lon: 34.51 }, bounds: { minlat: 0.49, minlon: 34.49, maxlat: 0.52, maxlon: 34.52 }, tags: { name: 'WEST KENYA SUGAR COMPANY', landuse: 'industrial' } }
  const road: OsmElement = { type: 'way', id: 4, center: { lat: 0.5, lon: 34.5 }, tags: { name: 'Kakamega Road', highway: 'primary' } }
  it('takes the nearest named business within reach', () => {
    expect(pickPoi(lat, lng, [far, works, bank, road])).toEqual({ name: 'Equity Bank', activity: 'Banking' })
  })
  it('else the premises it stands inside, in Title Case', () => {
    expect(pickPoi(lat, lng, [far, works, road])).toEqual({ name: 'West Kenya Sugar Company', activity: 'Work' })
  })
  it('names nothing from roads or far places', () => {
    expect(pickPoi(lat, lng, [far, road])).toBeNull()
  })
})
