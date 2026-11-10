import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { readDeliverySheet, readCoordinates, readNumber } from '../../src/modules/planner/sheet.js'

/** A workbook laid out as Menengai's Sales Order Booking Delivery Sheet, made-up data. */
function sheet(rows: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!merges'] = [{ s: { c: 0, r: 0 }, e: { c: 12, r: 0 } }, { s: { c: 0, r: 1 }, e: { c: 12, r: 1 } }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Delivery List')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

const HEAD = ['NO.', 'REP', 'CUSTOMER ID', 'CUSTOMER NAME', 'LOCATION', 'COORDINATES', 'INVOICE NO.', 'AMOUNT', 'TONNAGE', 'FULL', 'PARTLY', 'REJECTED', 'REMARKS']
const TOP = [
  ['NO.'],
  ['Sales Order Booking Delivery Sheet'],
  ['TILL NO:'],
  ['Truck Number: KZZ 001A', null, null, null, null, null, 'Gate Pass:'],
  ['Date: 2026-11-09 09:36:16', null, null, null, null, null, 'Driver Name: JANE DOE'],
]
const line = (n: number, code: string, name: string, coords: string, amount: string, tons: string, extra: unknown[] = [null, null, null, '--']) =>
  [String(n), 'A REP', code, name, 'TOWN', coords, '0', amount, tons, ...extra]
const FOOT = [
  ['TOTALS', null, null, null, null, null, null, null, '0.05'],
  ['Driver Name', 'JANE DOE'],
  ['TurnBoy 1'],
  ['Mileage Out', null, 'Fixed'],
]

describe('readDeliverySheet', () => {
  it('reads the header block, every customer line, and stops at TOTALS', () => {
    const got = readDeliverySheet(sheet([
      ...TOP, HEAD,
      line(1, '900001', 'SHOP ONE', 'LAT: -0.095096700000000 LONG: 36.127076700000000', '3957', '0.02'),
      line(2, '900002', 'SHOP TWO', 'LAT: -0.273848300000000 LONG: 36.100081700000000', '8,435', '0.03'),
      ...FOOT,
    ]))
    expect(got.header).toEqual({
      plate: 'KZZ 001A', planDate: '2026-11-09', sheetAt: '2026-11-09T09:36:16+03:00',
      driverName: 'JANE DOE', gatePass: '', tillNo: '',
    })
    expect(got.stops).toHaveLength(2)
    expect(got.stops[0]).toMatchObject({
      sequence: 1, rep: 'A REP', customerCode: '900001', customerName: 'SHOP ONE', location: 'TOWN',
      lat: -0.0950967, lng: 36.1270767, invoiceNo: '0', amount: 3957, tonnage: 0.02, outcome: null, remarks: '', row: 7,
    })
    expect(got.stops[1].amount).toBe(8435)
    expect(got.problems).toEqual([])
  })

  it('reads columns by heading, in any order, and plain "lat, lng"', () => {
    const got = readDeliverySheet(sheet([
      ...TOP,
      ['CUSTOMER NAME', 'CUSTOMER ID', 'AMOUNT', 'COORDINATES'],
      ['SHOP ONE', 900001, 1200, '-0.2650, 36.1207'],
    ]))
    expect(got.stops[0]).toMatchObject({ customerCode: '900001', customerName: 'SHOP ONE', amount: 1200, lat: -0.265, lng: 36.1207 })
  })

  it('flags a missing point, swaps a reversed one, and keeps the line', () => {
    const got = readDeliverySheet(sheet([
      ...TOP, HEAD,
      line(1, '900001', 'NO POINT', '', '10', '0.01'),
      line(2, '900002', 'ZERO POINT', 'LAT: 0 LONG: 0', '10', '0.01'),
      line(3, '900003', 'SWAPPED', 'LAT: 36.12 LONG: -0.27', '10', '0.01'),
      ...FOOT,
    ]))
    expect(got.stops.map((s) => [s.customerName, s.lat, s.lng])).toEqual([
      ['NO POINT', null, null], ['ZERO POINT', null, null], ['SWAPPED', -0.27, 36.12],
    ])
    expect(got.problems.map((p) => p.row)).toEqual([7, 8, 9])
  })

  it('reads an outcome already ticked on the sheet', () => {
    const got = readDeliverySheet(sheet([
      ...TOP, HEAD,
      line(1, '900001', 'SHOP ONE', '-0.1, 36.1', '10', '0.01', [null, 'x', null, 'short 2 cartons']),
      ...FOOT,
    ]))
    expect(got.stops[0]).toMatchObject({ outcome: 'PARTLY', remarks: 'short 2 cartons' })
  })

  it('says what is missing when the sheet has no headings', () => {
    const got = readDeliverySheet(sheet([['hello']]))
    expect(got.stops).toEqual([])
    expect(got.problems[0].message).toMatch(/CUSTOMER ID/)
  })
})

describe('cell readers', () => {
  it('reads numbers and coordinates in the forms the sheets use', () => {
    expect(readNumber('278,386')).toBe(278386)
    expect(readNumber('')).toBeNull()
    expect(readCoordinates('LAT: 0.0334339 LONG: 36.3605628')).toEqual({ lat: 0.0334339, lng: 36.3605628 })
    expect(readCoordinates('-1.10 37.01')).toEqual({ lat: -1.1, lng: 37.01 })
    expect(readCoordinates('Nyahururu')).toBeNull()
  })
})
