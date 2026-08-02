import { describe, it, expect } from 'vitest'
import {
  cellText, cellNumber, cellDate, columnIndex, mapFillings, mapThefts,
  type ReportTable, type ReportRow,
} from '../../src/providers/wialon/wialon.reports.js'

/**
 * Headers and rows below are VERBATIM from the live account (2026-08-02),
 * captured off resource 30394506 for unit 30287348. They are the contract this
 * mapping is written against — the two templates spell their columns
 * differently and their table order shifts per unit, which is exactly what
 * these tests pin down.
 */

const FILLINGS_HEADER = [
  'Time', 'Initial fuel level', 'Filled', 'Final fuel level', 'Location', 'Mileage',
  'Custom: Distance covered', 'Custom: Fuel Consumed', 'Custom: Average Consumption',
  'Custom: Drained', 'Sensor name',
]

/** "Advanced Fuel Analysis" — carries an initial speed. */
const THEFTS_HEADER_ADVANCED = [
  'Start Time', 'Start location', 'Time', 'End location',
  'Initial fuel level', 'Initial speed', 'Stolen', 'Final fuel level', 'Mileage',
]

/** The standalone "Fuel Theft Message" template — different names, no speed,
 *  and no initial level at all. */
const THEFTS_HEADER_STANDALONE = [
  'Beginning', 'Initial location', 'Time', 'Final location',
  'Drained', 'Final fuel level', 'Sensor name', 'Count', 'Mileage',
]

const time = (unix: number, text: string) => ({ t: text, v: unix, y: -4.0317, x: 30.5464 })
const place = (text: string) => ({ t: text, y: -4.0317, x: 30.5464 })

describe('cell readers', () => {
  it('pulls the number out of a measurement cell', () => {
    expect(cellNumber('80.83 l')).toBe(80.83)
    expect(cellNumber('720.00 l')).toBe(720)
    expect(cellNumber('0.01 km')).toBe(0.01)
    expect(cellNumber('1')).toBe(1)
  })

  it('treats Wialon\'s blanks as "not measured", never as zero', () => {
    // All three appear in live filling rows for the custom columns.
    for (const blank of ['', ' ', '-----']) expect(cellNumber(blank)).toBeNull()
    expect(cellNumber(null)).toBeNull()
  })

  it('reads the unix stamp off a time cell, not the display text', () => {
    // 1785334716 is 29.07.2026 in the account's own locale — the display text
    // is dd.mm.yyyy and would parse as a different date if it were trusted.
    expect(cellDate(time(1785334716, '29.07.2026 14:18:36'))?.getTime()).toBe(1785334716_000)
    expect(cellDate('29.07.2026 14:18:36')).toBeNull()
  })

  it('reads display text from either cell form', () => {
    expect(cellText(place('Nyalulanga, Tanzania'))).toBe('Nyalulanga, Tanzania')
    expect(cellText('80.83 l')).toBe('80.83 l')
    expect(cellText(' ')).toBeNull()
  })
})

describe('columnIndex — columns are found by label, not position', () => {
  it('matches the first pattern that hits', () => {
    expect(columnIndex(FILLINGS_HEADER, [/^filled$/i])).toBe(2)
    expect(columnIndex(THEFTS_HEADER_ADVANCED, [/^drained$/i, /^stolen$/i])).toBe(6)
    expect(columnIndex(THEFTS_HEADER_STANDALONE, [/^drained$/i, /^stolen$/i])).toBe(4)
  })

  it('returns -1 for a column the template does not carry', () => {
    expect(columnIndex(THEFTS_HEADER_STANDALONE, [/^initial speed$/i])).toBe(-1)
    expect(columnIndex(undefined, [/anything/])).toBe(-1)
  })

  it('does not confuse "Custom: Drained" in the fillings table for the volume filled', () => {
    // Both columns exist in that header; the filled volume must win.
    expect(columnIndex(FILLINGS_HEADER, [/^filled$/i, /filled/i])).toBe(2)
  })
})

describe('mapFillings', () => {
  const table: ReportTable = { name: 'unit_fillings', header: FILLINGS_HEADER, rows: 2 }

  const rows: ReportRow[] = [
    { c: [
      time(1785334716, '29.07.2026 14:18:36'),
      '40.00 l', '720.00 l', '760.00 l',
      place('Nyalulanga, Tanzania, Busunzu Ward'),
      '0.01 km', ' ', '', '', '', '2.Main Tank Fuel Level (760 L)',
    ] },
    { c: [
      time(1785399174, '30.07.2026 08:12:54'),
      '672.00 l', '31.28 l', '703.28 l',
      place('Nyalulanga, Tanzania'),
      '0.01 km', ' ', '', '', '', '2.Main Tank Fuel Level (760 L)',
    ] },
  ]

  it('maps litres to millilitres and the stamp to a Date', () => {
    const [first, second] = mapFillings(table, rows)

    expect(first!.filledMl).toBe(720_000)
    expect(first!.initialFuelLevelMl).toBe(40_000)
    expect(first!.finalFuelLevelMl).toBe(760_000)
    expect(first!.filledAt.getTime()).toBe(1785334716_000)
    expect(first!.location).toBe('Nyalulanga, Tanzania, Busunzu Ward')
    expect(first!.mileageAtFillKm).toBe(0.01)

    // Fractional litres must survive the conversion.
    expect(second!.filledMl).toBe(31_280)
  })

  it('keeps the provider\'s arithmetic intact (initial + filled = final)', () => {
    for (const f of mapFillings(table, rows)) {
      expect(f.initialFuelLevelMl! + f.filledMl).toBe(f.finalFuelLevelMl)
    }
  })

  it('drops rows with no timestamp or no volume rather than defaulting them', () => {
    const junk: ReportRow[] = [
      { c: ['29.07.2026', '40.00 l', '720.00 l', '760.00 l', place('x'), '0.01 km'] },  // no unix stamp
      { c: [time(1785334716, 'x'), '40.00 l', '', '760.00 l', place('x'), '0.01 km'] },  // no volume
      { c: [time(1785334716, 'x'), '40.00 l', '0.00 l', '40.00 l', place('x'), '0 km'] }, // zero fill
    ]
    expect(mapFillings(table, junk)).toHaveLength(0)
  })
})

describe('mapThefts', () => {
  it('reads the Advanced Fuel Analysis spelling, including initial speed', () => {
    const table: ReportTable = { name: 'unit_thefts', header: THEFTS_HEADER_ADVANCED, rows: 1 }
    const rows: ReportRow[] = [{ c: [
      time(1785343991, '29.07.2026 16:53:11'),
      place('Nyalulanga, Tanzania'),
      time(1785345010, '29.07.2026 17:10:10'),
      place('Nyalulanga, Tanzania'),
      '759.92 l', '0.00 km/h', '80.83 l', '679.09 l', '0.01 km',
    ] }]

    const [t] = mapThefts(table, rows)
    expect(t!.stolenMl).toBe(80_830)
    expect(t!.initialFuelLevelMl).toBe(759_920)
    expect(t!.finalFuelLevelMl).toBe(679_090)
    expect(t!.initialSpeedKmh).toBe(0)
    expect(t!.beganAt.getTime()).toBe(1785343991_000)
    expect(t!.detectedAt.getTime()).toBe(1785345010_000)
  })

  it('reads the standalone template, reconstructing the level it omits', () => {
    const table: ReportTable = { name: 'unit_thefts', header: THEFTS_HEADER_STANDALONE, rows: 1 }
    const rows: ReportRow[] = [{ c: [
      time(1785343991, '29.07.2026 16:53:11'),
      place('Nyalulanga, Tanzania'),
      time(1785345010, '29.07.2026 17:10:10'),
      place('Nyalulanga, Tanzania'),
      '80.83 l', '679.09 l', '2.Main Tank Fuel Level (760 L)', '1', '0.01 km',
    ] }]

    const [t] = mapThefts(table, rows)
    expect(t!.stolenMl).toBe(80_830)
    expect(t!.finalFuelLevelMl).toBe(679_090)
    // Not reported by this template — final + stolen, from the provider's own
    // two numbers.
    expect(t!.initialFuelLevelMl).toBe(759_920)
    // This template has no speed column at all; null, not zero.
    expect(t!.initialSpeedKmh).toBeNull()
  })

  it('falls back to the start time when a drain is instantaneous', () => {
    const table: ReportTable = { name: 'unit_thefts', header: THEFTS_HEADER_STANDALONE, rows: 1 }
    // Observed live: t1 === t2 on row 1 of unit 30287348.
    const rows: ReportRow[] = [{ c: [
      time(1785403555, '30.07.2026 09:25:55'),
      place('Nyalulanga'),
      time(1785403555, '30.07.2026 09:25:55'),
      place('Nyalulanga'),
      '25.00 l', '600.00 l', 'sensor', '1', '0 km',
    ] }]

    const [t] = mapThefts(table, rows)
    expect(t!.detectedAt.getTime()).toBe(t!.beganAt.getTime())
  })
})
