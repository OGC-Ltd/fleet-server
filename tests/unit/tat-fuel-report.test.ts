/**
 * The TAT and Fuel Report's working: when a unit left the premises, what a
 * dispatch burned, and what the Comment column says.
 */
import { describe, it, expect } from 'vitest'
import {
  baseOf, fenceTrips, fuelFigures, idleComment, leftPremises, millStays, onRoster, placeStation, routeStation, sortRows, stationFromFences,
  ticketStation, topUpLitres, tripComment, PARKED_MS, type Reading,
} from '../../src/modules/reports/tat-fuel-report.service.js'
import type { MorlFence } from '../../src/modules/reports/movement-report.service.js'

const MIN = 60_000
const YARD = { lat: -0.8227, lng: 34.3832 }
const fence: MorlFence = { name: 'Factory', centre: YARD, geometry: { type: 'CIRCLE', centerLat: YARD.lat, centerLng: YARD.lng, radiusM: 500 } }
const OUT = { lat: -0.7, lng: 34.5 }
const reading = (min: number, fuelL: number | null, where = OUT): Reading => ({ t: min * MIN, ...where, speedKmh: 40, fuelL })

describe('leftPremises', () => {
  it('is the first reading outside after dispatch', () => {
    const pings = [reading(0, 100, YARD), reading(10, 100, YARD), reading(20, 100), reading(30, 100)]
    expect(leftPremises(pings, [fence], 0, 60 * MIN)).toBe(20 * MIN)
  })
  it('is the dispatch when the unit was already out, or with no fence', () => {
    const pings = [reading(5, 100), reading(10, 100, YARD), reading(20, 100)]
    expect(leftPremises(pings, [fence], 0, 60 * MIN)).toBe(0)
    expect(leftPremises(pings, [], 0, 60 * MIN)).toBe(0)
  })
  it('is the dispatch when the unit never leaves', () => {
    expect(leftPremises([reading(5, 100, YARD)], [fence], 0, 60 * MIN)).toBe(0)
  })
})

describe('trips off the factory fence', () => {
  // A reading a minute, `km` out on the road from the yard (about 0.009 degrees a km).
  const road = (km: number) => ({ lat: YARD.lat + km * 0.009, lng: YARD.lng })
  const drive = (from: number, to: number, kmTo: number): Reading[] =>
    Array.from({ length: to - from }, (_, i) => reading(from + i, 100, road(((i + 1) / (to - from)) * kmTo)))

  it('reads the fix wandering at the gate as one visit', () => {
    const pings = [reading(0, 100, YARD), reading(5, 100, road(1)), reading(10, 100, YARD), reading(20, 100, YARD)]
    expect(millStays(pings, [fence])).toEqual([{ in: 0, out: 20 * MIN }])
  })

  it('folds a shuffle around the yard into the visit', () => {
    const pings = [reading(0, 100, YARD), ...drive(1, 31, 2), reading(40, 100, YARD)]
    expect(millStays(pings, [fence])).toHaveLength(1)
  })

  it('runs a trip from one entry to the next', () => {
    const pings = [reading(0, 100, YARD), reading(10, 100, YARD), ...drive(11, 71, 50), ...drive(71, 131, -50).map(r => r), reading(140, 100, YARD)]
    const stays = millStays(pings, [fence])
    expect(stays.map(s => s.in)).toEqual([0, 140 * MIN])
    expect(fenceTrips(stays, 100 * MIN, 200 * MIN)).toEqual([{ startAt: 0, endAt: 140 * MIN, leftAt: 10 * MIN }])
    expect(fenceTrips(stays, 200 * MIN, 300 * MIN)).toEqual([])
  })

  it('does not count days parked at the mill as the trip', () => {
    const stays = [{ in: 0, out: 3 * PARKED_MS }, { in: 3 * PARKED_MS + 300 * MIN, out: 3 * PARKED_MS + 310 * MIN }]
    expect(fenceTrips(stays, 0, 5 * PARKED_MS)[0]!.startAt).toBe(3 * PARKED_MS - 120 * MIN)
  })
})

describe('the station off the fences', () => {
  const line = (name: string, lat: number): MorlFence => ({
    name, centre: { lat, lng: 34.5 },
    geometry: { type: 'LINE', pathCoords: [[34.0, lat], [35.0, lat]], widthM: 100 },
  })
  const on = (lat: number, n: number) => Array.from({ length: n }, (_, i) => ({ t: i, lat, lng: 34.5, speedKmh: 40 }))

  it('names a route by where it goes', () => {
    expect(routeStation('Kabras to Magut Route')).toBe('Magut')
    expect(routeStation('Naitiri - Rai Paper Route')).toBe('Rai Paper')
    expect(routeStation('Selia Dangerous Bridge')).toBeNull()
  })

  it('takes the route most driven, then the place most stood in', () => {
    const routes = [line('Kabras - Selia Route', 0.1), line('Kabras - Khalaba Route', 0.2)]
    expect(stationFromFences([...on(0.1, 3), ...on(0.2, 9)], routes, [])).toBe('Khalaba')
    const place: MorlFence = { name: 'Misikhu New', centre: { lat: 0.3, lng: 34.5 }, geometry: { type: 'CIRCLE', centerLat: 0.3, centerLng: 34.5, radiusM: 500 } }
    expect(stationFromFences(on(0.3, 2), routes, [place])).toBe('Misikhu')
    expect(stationFromFences(on(0.9, 2), routes, [place])).toBeNull()
  })

  it('names a ticket as the sheet does', () => {
    expect(ticketStation('SELIENT YARD')).toBe('Selia')
    expect(ticketStation('KHALABA YARD')).toBe('Khalaba')
    expect(ticketStation('KITALE (AMUKA)')).toBe('Amuka')
    expect(placeStation('Selia Region')).toBe('Selia')
  })
})

describe('the units on the report', () => {
  it('reads the base off the name, spelt right', () => {
    expect(baseOf('WKS - Kabras - KDE 321Q', 'West Kenya')).toBe('Kabras')
    expect(baseOf('WKS - kabaras - KDE 314Q', 'West Kenya')).toBe('Kabras')
    expect(baseOf('WKS -  Naitiri - KCL 917M', 'West Kenya')).toBe('Naitiri')
    expect(baseOf('KDL 201X', 'Sukari')).toBe('Sukari')
  })

  const unit = (type: string, plate: string, tankL: number | null) => ({ type, plate, tankL })
  it('takes dispatched and ticketed units, and big-tanked road units', () => {
    expect(onRoster(unit('TRACTOR', 'KTCC 100G', null), true, false)).toBe(true)
    expect(onRoster(unit('UNSPECIFIED', 'KDE 321Q', 567), false, false)).toBe(true)
    expect(onRoster(unit('UNSPECIFIED', 'KDE 321Q', null), false, true)).toBe(true)
  })
  it('leaves out the listed light vehicles, plant, and machines by their plate', () => {
    expect(onRoster(unit('SALOON', 'KDM 359A', 80), false, true)).toBe(false)
    expect(onRoster(unit('PLANT', 'CAT 214B', 600), false, true)).toBe(false)
    expect(onRoster(unit('UNSPECIFIED', 'KTCC 409H', 310), false, false)).toBe(false)
    expect(onRoster(unit('UNSPECIFIED', 'CAT 214B', 600), false, false)).toBe(false)
    expect(onRoster(unit('UNSPECIFIED', 'KDM 359A', 80), false, false)).toBe(false)
  })
})

describe('topUpLitres', () => {
  it('reads one stop at the pump off the level, not the claimed fillings', () => {
    const readings = [reading(0, 320), reading(1, 322), reading(2, 321), reading(40, 373), reading(41, 372), reading(42, 374)]
    const fills = [{ at: 5 * MIN, ml: 15_000 }, { at: 30 * MIN, ml: 62_000 }]
    expect(topUpLitres(readings, fills)).toBe(52)
  })
  it('does not count a probe rocking on the yard', () => {
    const readings = [reading(0, 320), reading(1, 321), reading(30, 322), reading(31, 323)]
    expect(topUpLitres(readings, [{ at: 5 * MIN, ml: 13_000 }])).toBe(0)
  })
  it('adds separate stops', () => {
    const readings = [reading(0, 100), reading(10, 150), reading(200, 140), reading(300, 190)]
    expect(topUpLitres(readings, [{ at: 5 * MIN, ml: 50_000 }, { at: 250 * MIN, ml: 50_000 }])).toBe(100)
  })
  it('takes the filling itself when the level around it is not there', () => {
    expect(topUpLitres([], [{ at: 5 * MIN, ml: 40_000 }])).toBe(40)
  })
})

describe('fuelFigures', () => {
  it('balances as the sheet does', () => {
    const flat = (min: number, l: number) => Array.from({ length: 7 }, (_, i) => reading(min + i, l))
    const readings = [...flat(0, 200), ...flat(10, 250), ...flat(300, 180)]
    expect(fuelFigures(readings, [{ at: 5 * MIN, ml: 50_000 }], 10)).toEqual({
      initial: 200, topUps: 50, total: 250, consumption: 60, theft: 10, final: 180,
    })
  })
  it('skips a dead probe and gives nothing without readings', () => {
    expect(fuelFigures([reading(0, 0), reading(1, 0.5)], [], 0)).toBeNull()
    expect(fuelFigures([reading(0, null), reading(1, 100), reading(2, 90)], [], 0)?.initial).toBe(100)
  })
})

describe('the Comment column', () => {
  const fuel = { initial: 100, topUps: 0, total: 100, consumption: 40, theft: 0, final: 60 }
  const trip = { readings: 50, fuel, km: 90, durationMs: 5 * 60 * MIN, tankL: 600 }
  it('reads a completed trip', () => {
    expect(tripComment(trip)).toBe('PROBE OK')
    expect(tripComment({ ...trip, readings: 0 })).toBe('NOT UPDATING')
    expect(tripComment({ ...trip, km: 0 })).toBe('GPS MILEAGE FAILURE')
    expect(tripComment({ ...trip, fuel: null })).toBe('PROBE FAILURE')
    expect(tripComment({ ...trip, fuel: null, tankL: null })).toBe('NO FLS')
    expect(tripComment({ ...trip, fuel: { ...fuel, consumption: -3 } })).toBe('PROBE ISSUE')
    expect(tripComment({ ...trip, fuel: { ...fuel, consumption: 2 } })).toBe('PROBE ISSUE')
  })
  it('reads a unit with no trip', () => {
    const idle = { readings: 50, fuelReadings: 50, open: false, tankL: 600 }
    expect(idleComment(idle)).toBe('NO TRIP')
    expect(idleComment({ ...idle, open: true })).toBe('INCOMPLETE TRIP')
    expect(idleComment({ ...idle, readings: 0 })).toBe('NOT UPDATING')
    expect(idleComment({ ...idle, fuelReadings: 0 })).toBe('PROBE FAILURE')
    expect(idleComment({ ...idle, fuelReadings: 0, tankL: null })).toBe('NO FLS')
  })
})

describe('sortRows', () => {
  it('keeps a unit together, trucks first, trips in order', () => {
    const rows = sortRows([
      { group: 'Tractors', plate: 'KTCA 1', leftAt: 1 },
      { group: 'Trucks', plate: 'KDB 2', leftAt: 9 },
      { group: 'Trucks', plate: 'KDB 2', leftAt: 3 },
      { group: 'Trucks', plate: 'KDA 1', leftAt: 5 },
    ])
    expect(rows.map(r => `${r.plate}:${r.leftAt}`)).toEqual(['KDA 1:5', 'KDB 2:3', 'KDB 2:9', 'KTCA 1:1'])
  })
})
