import { describe, it, expect, vi } from 'vitest'
import * as XLSX from 'xlsx'
vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/zone-presence.js', () => ({ invalidateZoneCache: vi.fn() }))
// Addresses as a geocoder would place them: a door, a road, and one it cannot find
vi.mock('../../src/modules/planner/address-geocode.js', () => ({
  geocodeAddress: vi.fn(async (a: string) => (a.startsWith('50300') ? { lat: 0.2130687, lng: 34.7692777, exact: true, source: 'google' }
    : a.startsWith('C35') ? { lat: -0.1697534, lng: 35.5917935, exact: false, source: 'google' } : null)),
}))
import { prismaMock } from '../helpers/prisma.mock.js'
import { locateStops } from '../../src/modules/planner/planner.service.js'
import { readDeliverySheet } from '../../src/modules/planner/sheet.js'
import { decodeFull, decodePlusCode, encodePairs, findPlusCode } from '../../src/modules/planner/plus-code.js'
import { itineraryCode, readAddress, townOf } from '../../src/modules/planner/itinerary.js'

describe('plus codes', () => {
  it('round-trips a point through a full code', () => {
    const code = encodePairs(-0.0843, 34.7735, 5)
    const p = decodeFull(`${code.slice(0, 8)}+${code.slice(8)}`)!
    expect(Math.abs(p.lat - -0.0843)).toBeLessThan(0.0002)
    expect(Math.abs(p.lng - 34.7735)).toBeLessThan(0.0002)
  })

  it('recovers a short code against a point nearby, across the equator too', () => {
    // Ahero: the KCA sheet's own point for the stop is -0.17249, 34.91875
    const ahero = decodePlusCode('RWG9+WC9', { lat: -0.2127, lng: 35.1528 })!
    expect(Math.abs(ahero.lat - -0.17249)).toBeLessThan(0.0005)
    expect(Math.abs(ahero.lng - 34.91875)).toBeLessThan(0.0005)
    const code = encodePairs(0.0123, 34.6, 5)
    const back = decodePlusCode(`${code.slice(4, 8)}+${code.slice(8)}`, { lat: -0.02, lng: 34.7 })!
    expect(Math.abs(back.lat - 0.0123)).toBeLessThan(0.0002)
    expect(decodePlusCode('WQ8F+7C', null)).toBeNull()
  })

  it('finds a code in an address', () => {
    expect(findPlusCode('RWG9+WC9, Ahero, Kenya')).toBe('RWG9+WC9')
    expect(findPlusCode('WQ8F+7C Kisumu, Kenya')).toBe('WQ8F+7C')
    expect(findPlusCode('C35, Londiani, Kenya')).toBeNull()
  })
})

describe('an itinerary Address', () => {
  it('is a point, a place with a point, a plus code, or a street', () => {
    expect(readAddress('-0.1592, 35.6935')).toMatchObject({ p: { lat: -0.1592, lng: 35.6935 }, query: '' })
    expect(readAddress('C35, Londiani, Kenya')).toEqual({ place: 'Londiani', p: null, query: 'C35, Londiani, Kenya', plusCode: null })
    expect(readAddress('WQ8F+7C Kisumu, Kenya')).toMatchObject({ place: 'Kisumu', p: null, plusCode: 'WQ8F+7C' })
    expect(readAddress('50300 Kakamega Rd, Mukumu, Kenya').p).toBeNull()
    expect(townOf('Kericho-Kisumu Highway, Kericho, Kenya')).toBe('Kericho')
  })

  it('keeps one customer however the dispatcher spelled it', () => {
    expect(itineraryCode('Awasi Drive.')).toBe(itineraryCode('AWASI DRIVE'))
  })
})

function book(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Route')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}
const HEAD = ['#', 'Order', 'Address', 'Estimated arrival', 'Fact', 'Delivery interval', 'Estimated mileage', 'Estimated service time', 'Weight, kg', 'Volume, ', 'Cost, ', 'Phone', 'Client']

describe('an itinerary whose addresses carry no points', () => {
  const sheet = readDeliverySheet(book([
    [null, 'Itinerary "FG - Menengai - KZZ 004D"'], [null, '11.11.2026 03:31 — 12.11.2026 00:08'], [], HEAD,
    ['1', 'DEPOT', 'Nakuru-Kisumu Road, Nakuru, Kenya', '03:31', null, '00:00 — 23:59', '0 m'],
    ['2', 'JUNCTION SHOP', '-0.21266916641031655, 35.15282252048105', '07:24', null, '04:00 — 22:00', '20 km'],
    ['3', 'AHERO SHOP', 'RWG9+WC9, Ahero, Kenya', '07:40', null, '04:00 — 22:00', '18.1 km'],
    ['4', 'ROAD SHOP', 'C35, Londiani, Kenya', '08:40', null, '04:00 — 22:00', '20 km'],
    ['5', 'DOOR SHOP', '50300 Kakamega Rd, Mukumu, Kenya', '09:40', null, '04:00 — 22:00', '29.5 km'],
    ['6', 'LOST SHOP', 'Nowhere Lane, Kenya', '10:40', null, '04:00 — 22:00', '1 km'],
  ]))

  it('decodes plus codes while reading, and leaves streets for the geocoder', () => {
    expect(sheet.problems).toEqual([])
    expect(sheet.route?.home).toEqual({ name: 'DEPOT', lat: null, lng: null })
    expect(sheet.stops.map((s) => s.customerName)).toEqual(['JUNCTION SHOP', 'AHERO SHOP', 'ROAD SHOP', 'DOOR SHOP', 'LOST SHOP'])
    expect(sheet.stops[1]).toMatchObject({ located: 'plus_code', location: 'Ahero' })
    expect(sheet.stops[2]).toMatchObject({ lat: null, address: 'C35, Londiani, Kenya', location: 'Londiani' })
  })

  it('places streets by geocoding, flags a road, and asks for the one it cannot find', async () => {
    prismaMock.plannerCustomer.findMany.mockResolvedValue([] as never)
    const { stops, problems } = await locateStops('org', sheet.stops)
    expect(stops[2]).toMatchObject({ lat: -0.1697534, lng: 35.5917935, located: 'approx' })
    expect(stops[3]).toMatchObject({ lat: 0.2130687, lng: 34.7692777, located: 'address' })
    expect(stops[4]).toMatchObject({ lat: null })
    expect(problems.map((p) => p.message)).toEqual([
      'ROAD SHOP: placed from "C35, Londiani, Kenya", which is a road or area, not the shop; check its fence.',
      'LOST SHOP: "Nowhere Lane, Kenya" could not be placed; add its point.',
    ])
  })

  it('keeps a known customer\'s own point rather than geocoding', async () => {
    prismaMock.plannerCustomer.findMany.mockResolvedValue([{ customerCode: 'WL:ROAD SHOP' }] as never)
    const { stops } = await locateStops('org', sheet.stops)
    expect(stops[2].lat).toBeNull()
  })
})
