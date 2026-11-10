import { describe, expect, it } from 'vitest'
import { flaggedUnits, flagWords, nearestPlace, placesOf, plateIn, withMovement, type SnapshotUnit } from '../../src/modules/stop-watch/stop-watch.rules.js'

const NOW = Date.UTC(2026, 10, 10, 9, 0)
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const square = (name: string, lat: number, lng: number, d = 0.01, type = 'Customer') => ({
  type: 'Feature', properties: { name, type },
  geometry: { type: 'Polygon', coordinates: [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]] },
})
const authorised = placesOf([square('Kahawa Depot', -1.0, 37.0)])
const noGo = placesOf([square('Voi', -3.4, 38.5, 0.01, 'NoGoZone')])
const unit = (over: Partial<SnapshotUnit>): SnapshotUnit => ({
  vehicleId: 'v1', plate: 'KDA 101A', name: 'Faw KDA 101A', lat: -2.0, lng: 36.0, speedKmh: 0,
  capturedAt: ago(1), movement: { state: 'resting', since: ago(30) }, ...over,
})

describe('flaggedUnits', () => {
  it('flags a stop of 10 minutes or more outside every authorised place', () => {
    const [f] = flaggedUnits([unit({})], { authorised, noGo, now: NOW })
    expect(f).toMatchObject({ kind: 'unauthorised', plate: 'KDA 101A', zone: null })
    expect(flagWords(f!, NOW)).toBe('KDA 101A has stood 30 min outside any authorised place.')
  })

  it('leaves a unit at an authorised place, a short stop, a moving unit and a stale one', () => {
    const units = [
      unit({ vehicleId: 'a', lat: -1.0, lng: 37.0 }),
      unit({ vehicleId: 'b', movement: { state: 'resting', since: ago(5) } }),
      unit({ vehicleId: 'c', speedKmh: 40, movement: { state: 'moving', since: ago(30) } }),
      unit({ vehicleId: 'd', capturedAt: ago(7 * 60) }),
      unit({ vehicleId: 'e', lat: -0.288, lng: 36.045 }),  // MORL
    ]
    expect(flaggedUnits(units, { authorised, noGo, now: NOW })).toEqual([])
  })

  it('flags a no-go zone after 2 minutes, by name', () => {
    const [f] = flaggedUnits([unit({ lat: -3.4, lng: 38.5, movement: { state: 'idling', since: ago(3) } })], { authorised, noGo, now: NOW })
    expect(f).toMatchObject({ kind: 'nogo', zone: 'Voi' })
    expect(f!.key).toContain('|nogo|Voi|')
  })
})

describe('nearestPlace and plateIn', () => {
  it('measures to the nearest fence edge', () => {
    const n = nearestPlace(-1.0, 37.02, authorised)
    expect(n?.name).toBe('Kahawa Depot')
    expect(n!.metres).toBeGreaterThan(1000)
    expect(n!.metres).toBeLessThan(1200)
  })
  it('reads the plate from a name', () => {
    expect(plateIn(null, 'Mahindra 9200 KTCC 787D')).toBe('KTCC 787D')
  })
})

describe('withMovement', () => {
  // The cached snapshot carries no `movement`; without it every unit was skipped
  it('flags a stop read from a raw snapshot row once the run is attached', () => {
    const { movement: _m, ...raw } = unit({})
    expect(flaggedUnits([raw as SnapshotUnit], { authorised, noGo, now: NOW })).toEqual([])
    const units = withMovement([{ ...raw, lastMovedAt: ago(30) }], (_id, lastMovedAt) =>
      ({ state: 'resting', since: new Date(lastMovedAt as string).toISOString() }))
    expect(flaggedUnits(units, { authorised, noGo, now: NOW })).toHaveLength(1)
  })

  it('passes the fix time and leaves movement null when the tracker knows nothing', () => {
    let seen: number | null = null
    const [u] = withMovement([{ vehicleId: 'v9', lat: 0, lng: 0, speedKmh: 0, capturedAt: ago(2) }], (_id, _l, fixMs) => { seen = fixMs; return null })
    expect(seen).toBe(NOW - 2 * 60_000)
    expect(u!.movement).toBeNull()
  })
})
