import { describe, it, expect, vi } from 'vitest'

// The place at a stop's coordinates: one cached, one looked up, one never answered
vi.mock('../../src/lib/geocode.js', () => ({
  cachedPlace: (lat: number) => (lat === 1 ? 'Cached Town, Uasin Gishu' : null),
  reverseGeocode: (lat: number) => (lat === 2 ? Promise.resolve('Looked Up, Nakuru') : new Promise(() => {})),
}))
const { placeStops } = await import('../../src/modules/planner/planner.service.js')

const stop = (lat: number | null, location = '') => ({ lat, lng: lat == null ? null : 35.123456, location })

describe('an itinerary stop is located by its coordinates', () => {
  it('names each stop from its point, else writes the point', async () => {
    const got = await placeStops([stop(1), stop(2), stop(3), stop(null), stop(2)], true, 50)
    expect(got.map((s) => s.location)).toEqual([
      'Cached Town, Uasin Gishu', 'Looked Up, Nakuru', '3.00000, 35.12346', '', 'Looked Up, Nakuru',
    ])
  })

  it('leaves a sales sheet, and any written location, as they are', async () => {
    expect((await placeStops([stop(2)], false, 50))[0].location).toBe('')
    expect((await placeStops([stop(2, 'ELDORET')], true, 50))[0].location).toBe('ELDORET')
  })
})
