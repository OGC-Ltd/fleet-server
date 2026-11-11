import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { readDeliverySheet } from '../../src/modules/planner/sheet.js'
import { readKm, readMinutes, readWhen, itineraryCode } from '../../src/modules/planner/itinerary.js'
import { plannedColumns, routeColumns } from '../../src/modules/planner/planner.service.js'

/** A workbook laid out as Wialon Logistics exports an itinerary, made-up data. */
function book(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Route')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

const HEAD = ['#', 'Order', 'Address', 'Estimated arrival', 'Fact', 'Delivery interval', 'Estimated mileage', 'Estimated service time',
  'Weight, kg', 'Volume, ', 'Cost, ', 'Phone', 'Client', 'Comment', 'Comment (confirmation)', '#Registration number']
const TOP = [
  [null, 'Generated: 08:48'],
  [null, 'Itinerary "VS - Menengai - KZZ 002B"'],
  [null, '11.11.2026 05:34 — 12.11.2026 11:20'],
  [],
]
const row = (n: number, name: string, at: string, arrive: string, win: string, km: string, svc: string | null, client = name) =>
  [String(n), name, at, arrive, null, win, km, svc, null, null, '0', null, client]

describe('a Wialon itinerary', () => {
  const sheet = readDeliverySheet(book([
    ...TOP, HEAD,
    row(1, 'DEPOT', '-0.288, 36.044', '05:34', '04:00 — 23:00', '0 m', '30 min', ''),
    row(2, 'SHOP ONE', '-0.143, 35.683', '07:13', '04:00 — 22:00', '49.4 km', null),
    row(3, 'SHOP TWO', '0.520, 35.269', '23:50', '08:00 — 23:59', '426 m', '1 h 30 min'),
    row(4, 'SHOP THREE', '0.605, 34.771', '12.11.2026 01:01', '04:00 — 22:00', '3.8 km', '180 min'),
    row(5, 'DEPOT', '-0.288, 36.044', '12.11.2026 11:20', '04:00 — 23:00', '186.6 km', '30 min', ''),
  ]))

  it('takes the truck and run from the title, home from the first line', () => {
    expect(sheet.problems).toEqual([])
    expect(sheet.header).toMatchObject({ plate: 'KZZ 002B', planDate: '2026-11-11', sheetAt: '2026-11-11T05:34:00+03:00', driverName: '' })
    expect(sheet.route).toEqual({
      name: 'VS - Menengai - KZZ 002B', start: '2026-11-11T05:34:00+03:00', end: '2026-11-12T11:20:00+03:00',
      km: 240.2, home: { name: 'DEPOT', lat: -0.288, lng: 36.044 },
    })
  })

  it('keeps the stops between leaving home and coming back, with their plan', () => {
    expect(sheet.stops.map((s) => s.customerName)).toEqual(['SHOP ONE', 'SHOP TWO', 'SHOP THREE'])
    expect(sheet.stops[0]).toMatchObject({
      sequence: 1, customerCode: 'WL:SHOP ONE', lat: -0.143, lng: 35.683, amount: null, invoiceNo: '',
      planned: { at: '2026-11-11T07:13:00+03:00', windowFrom: '04:00', windowTo: '22:00', serviceMin: null, legKm: 49.4 },
    })
    expect(sheet.stops[1].planned).toMatchObject({ serviceMin: 90, legKm: 0.426, windowFrom: '08:00', windowTo: '23:59' })
    expect(sheet.stops[2].planned?.at).toBe('2026-11-12T01:01:00+03:00')
  })

  it('keeps the last line when the run does not come home', () => {
    const open = readDeliverySheet(book([...TOP, HEAD,
      row(1, 'DEPOT', '-0.288, 36.044', '05:34', '', '0 m', null),
      row(2, 'SHOP ONE', '-0.143, 35.683', '07:13', '', '49.4 km', null),
      row(3, 'SHOP TWO', '0.520, 35.269', '09:00', '', '60 km', null),
    ]))
    expect(open.stops.map((s) => s.customerName)).toEqual(['SHOP ONE', 'SHOP TWO'])
  })

  it('says what is missing', () => {
    const bad = readDeliverySheet(book([[null, 'Itinerary'], [], HEAD,
      row(1, 'DEPOT', '-0.288, 36.044', '05:34', '', '0 m', null),
      row(2, 'SHOP ONE', '', '07:13', '', '1 km', null),
    ]))
    expect(bad.problems.map((p) => p.message)).toEqual([
      'SHOP ONE: no coordinates.',
      'No itinerary name with a truck on the sheet.',
      'No planned run dates on the sheet.',
    ])
  })

  it('reads its cells', () => {
    expect(readWhen('07:13', '2026-11-11')).toBe('2026-11-11T07:13:00+03:00')
    expect(readWhen('12.11.2026 4:52', null)).toBe('2026-11-12T04:52:00+03:00')
    expect(readWhen('', '2026-11-11')).toBeNull()
    expect(readKm('0 m')).toBe(0)
    expect(readKm('1,5 km')).toBe(1.5)
    expect(readMinutes('2 h')).toBe(120)
    expect(readMinutes('')).toBeNull()
    expect(itineraryCode(' quick  mart ')).toBe('WL:QUICK MART')
  })

  it('becomes plan and stop columns', () => {
    expect(routeColumns(sheet)).toMatchObject({ source: 'itinerary', routeName: 'VS - Menengai - KZZ 002B', plannedKm: 240.2, homeName: 'DEPOT' })
    expect(routeColumns({})).toMatchObject({ source: 'sheet', routeName: '', plannedStart: null, homeLat: null })
    expect(plannedColumns(sheet.stops[0].planned)).toEqual({
      plannedAt: new Date('2026-11-11T04:13:00Z'), windowFrom: '04:00', windowTo: '22:00', serviceMin: null, legKm: 49.4,
    })
    expect(plannedColumns(undefined).plannedAt).toBeNull()
  })
})
