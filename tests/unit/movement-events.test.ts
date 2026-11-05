import { describe, it, expect } from 'vitest'
import { longStops, oneOfEach, cameraEvents, type MovementEvent, type Reading, type EventKind } from '../../src/modules/reports/movement-events.service.js'
import type { DashcamIncident } from '../../src/modules/dashcam/dashcam.service.js'

const T0 = Date.parse('2026-11-05T08:00:00Z')
const min = 60_000
const window = { from: T0, to: T0 + 240 * min }
const HERE = { lat: -1.2, lng: 36.8 }
const FAR = { lat: -1.25, lng: 36.8 }     // about 5.5 km south
const at = (m: number, speedKmh: number | null, where = HERE): Reading => ({ t: T0 + m * min, ...where, speedKmh })

describe('long stops', () => {
  it('lists 10 minutes standing, not 9', () => {
    const route = (n: number) => [at(0, 40), at(5, 0), at(5 + n, 40)]
    expect(longStops(route(9), window)).toEqual([])
    expect(longStops(route(10), window)).toEqual([{ at: T0 + 5 * min, ...HERE, minutes: 10, before: false, ongoing: false }])
  })
  it('keeps a slow creep as standing, and ends it at the first reading over 5 km/h', () => {
    expect(longStops([at(0, 40), at(1, 0), at(6, 5), at(12, 6)], window)).toMatchObject([{ minutes: 11 }])
  })
  it('says a stop was already running when the window opened', () => {
    expect(longStops([at(0, 0), at(20, 50)], window)).toMatchObject([{ at: T0, minutes: 20, before: true, ongoing: false }])
  })
  it('says a stop is still running when the window closes, and counts to the close', () => {
    expect(longStops([at(0, 40), at(200, 0), at(210, 0)], window)).toMatchObject([{ minutes: 40, before: false, ongoing: true }])
  })
  it('ends a stand at the last reading before a tracker gap took the unit elsewhere', () => {
    const stops = longStops([at(0, 40), at(1, 0), at(15, 0), at(60, 0, FAR), at(80, 0, FAR), at(81, 30, FAR)], window)
    expect(stops).toMatchObject([{ at: T0 + min, minutes: 14, lat: HERE.lat }, { at: T0 + 60 * min, minutes: 21, lat: FAR.lat }])
  })
  it('counts a reading with no speed as standing', () => {
    expect(longStops([at(0, 40), at(1, null), at(12, null), at(13, 40)], window)).toMatchObject([{ minutes: 12 }])
  })
  it('reads nothing outside the window', () => {
    expect(longStops([at(-60, 0), at(-30, 0)], window)).toEqual([])
  })
})

describe('an event from both the tracker and the camera', () => {
  const event = (over: Partial<MovementEvent>): MovementEvent => ({ vehicleId: 'v1', plate: 'KDE', kind: 'cornering', at: T0, lat: null, lng: null, place: null, speedKmh: null, source: 'tracker', ...over })
  it('is one, the tracker’s, within a minute', () => {
    const kept = oneOfEach([event({ source: 'camera', at: T0 - 30_000 }), event({ source: 'tracker' })])
    expect(kept).toHaveLength(1)
    expect(kept[0]!.source).toBe('tracker')
  })
  it('stays two when further apart, on another unit, or another kind', () => {
    expect(oneOfEach([event({ source: 'camera', at: T0 + 2 * min }), event({})])).toHaveLength(2)
    expect(oneOfEach([event({ source: 'camera', vehicleId: 'v2' }), event({})])).toHaveLength(2)
    expect(oneOfEach([event({ source: 'camera', kind: 'freewheel' }), event({})])).toHaveLength(2)
  })
  it('keeps two reports from one source', () => {
    expect(oneOfEach([event({}), event({ at: T0 + 10_000 })])).toHaveLength(2)
  })
})

describe('the camera alarms', () => {
  const alarm = (code: number, m = 10): DashcamIncident => ({ id: 'a', code, label: 'x', group: 'g', severity: 'warning', category: 'safety' as DashcamIncident['category'],
    occurredAt: new Date(T0 + m * min).toISOString(), vehicleId: 'v1', plate: 'KDE', deviceId: 'd', lat: 1, lng: 2, speed: 40, videos: [], photos: [] })
  const picked = (...k: EventKind[]) => new Set<EventKind>(k)
  it('takes free-wheeling and harsh turns only when picked', () => {
    const list = [alarm(38), alarm(214), alarm(71), alarm(125)]
    expect(cameraEvents(list, picked('freewheel'), window).map(e => e.kind)).toEqual(['freewheel'])
    expect(cameraEvents(list, picked('cornering'), window).map(e => e.kind)).toEqual(['cornering', 'cornering'])
    expect(cameraEvents(list, picked('stop'), window)).toEqual([])
  })
  it('leaves out what falls outside the window', () => {
    expect(cameraEvents([alarm(38, 300), alarm(38, -5)], picked('freewheel'), window)).toEqual([])
  })
})
