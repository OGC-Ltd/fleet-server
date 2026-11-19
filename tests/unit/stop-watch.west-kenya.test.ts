import { describe, expect, it } from 'vitest'
import { placesOf } from '../../src/modules/stop-watch/stop-watch.rules.js'
import { westKenyaStops, WK_STOP_MS, type WkUnit } from '../../src/modules/stop-watch/stop-watch.west-kenya.js'

const NOW = Date.UTC(2026, 10, 19, 9, 0)
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const square = (name: string, category: string, lat: number, lng: number, d = 0.01) => ({
  properties: { name, category },
  geometry: { type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] },
})
// On site: a factory and a weighbridge (the service keeps only these categories)
const onSite = placesOf([square('Naitiri Factory', 'factory', 0.8, 34.9), square('Kabras Weighbridge', 'weighing', 0.5, 34.7)])
const unit = (o: Partial<WkUnit>): WkUnit => ({
  vehicleId: 'v1', plate: 'KDE 321Q', name: 'WKS - Naitiri - KDE 321Q', vehicleType: 'UNSPECIFIED',
  lat: 1.0, lng: 35.0, speedKmh: 0, capturedAt: ago(1), movement: { state: 'resting', since: ago(12) }, ...o,
})

describe('westKenyaStops', () => {
  it('flags a truck stopped 5 minutes or more off site', () => {
    const [f] = westKenyaStops([unit({})], onSite, NOW)
    expect(f).toMatchObject({ kind: 'unauthorised', plate: 'KDE 321Q', zone: null })
    expect(f!.key).toContain('|wkstop|')
    expect(WK_STOP_MS).toBe(5 * 60_000)
  })

  it('flags a prime mover by its name, whatever its plate', () => {
    expect(westKenyaStops([unit({ plate: 'PM 07', name: 'West Sugar - Prime Mover 07' })], onSite, NOW)).toHaveLength(1)
  })

  it('leaves a stop at a factory or weighbridge, a short stop, a moving or stale unit, and units that are not trucks', () => {
    const units = [
      unit({ vehicleId: 'a', lat: 0.8, lng: 34.9 }),
      unit({ vehicleId: 'b', lat: 0.5, lng: 34.7 }),
      unit({ vehicleId: 'c', movement: { state: 'resting', since: ago(4) } }),
      unit({ vehicleId: 'd', speedKmh: 40, movement: { state: 'moving', since: ago(30) } }),
      unit({ vehicleId: 'e', capturedAt: ago(7 * 60) }),
      unit({ vehicleId: 'f', plate: 'KTCB 504Z', name: 'WKS - Naitiri - KTCB 504Z' }),
      unit({ vehicleId: 'g', plate: 'KCA 123B', name: 'WKS - LV - Land Cruiser KCA 123B' }),
    ]
    expect(westKenyaStops(units, onSite, NOW)).toEqual([])
  })

  it('lists the most recent stop first', () => {
    const got = westKenyaStops([unit({ vehicleId: 'old', movement: { state: 'resting', since: ago(40) } }), unit({ vehicleId: 'new' })], onSite, NOW)
    expect(got.map((f) => f.vehicleId)).toEqual(['new', 'old'])
  })
})
