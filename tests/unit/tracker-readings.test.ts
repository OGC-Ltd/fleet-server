/** A unit's tracker readings now, as Wialon calculates them (operator, 2026-11-27). */
import { describe, it, expect, vi } from 'vitest'
vi.mock('../../src/lib/prisma.js')
import { readingsFrom, reportVerdict, WIALON_NO_VALUE } from '../../src/modules/incidents/tracker-readings.service.js'
import { labelVerdict } from '../../src/providers/wialon/wialon.status-codes.js'

const cfg = (ci: Record<string, string>) => JSON.stringify({ ci: Object.fromEntries(Object.entries(ci).map(([k, t]) => [k, { t }])) })

describe('readings from Wialon', () => {
  const sens = {
    '11': { id: 11, n: '11.Fls Status', t: 'custom', p: 'flls1', c: cfg({ 0: 'Off', 1: 'Not Ready', 2: 'Ready', 3: 'Error' }) },
    '9':  { id: 9,  n: '9.External Battery Voltage', t: 'voltage', p: 'pwr_ext', m: 'V' },
    '2':  { id: 2,  n: '2.Main Tank Fuel Level Qty (605L)', t: 'fuel level', p: 'clls1', m: 'l' },
    '14': { id: 14, n: '14.GNSS Status', t: 'custom', p: 'io_69', c: cfg({ 1: 'On with Fix', 2: 'On without Fix' }) },
  }
  it('labels each value as the installer did, judges it, and keeps the installer\'s order', () => {
    const r = readingsFrom(sens, { 11: 3, 9: 26.1, 2: WIALON_NO_VALUE, 14: 1 })
    expect(r.map(x => x.name)).toEqual(['2.Main Tank Fuel Level Qty (605L)', '9.External Battery Voltage', '11.Fls Status', '14.GNSS Status'])
    expect(r[0]).toMatchObject({ value: null, label: null, verdict: null, unit: 'l' })
    expect(r[1]).toMatchObject({ value: 26.1, unit: 'V', label: null, verdict: null })
    expect(r[2]).toMatchObject({ value: 3, label: 'Error', verdict: 'fault' })
    expect(r[3]).toMatchObject({ value: 1, label: 'On with Fix', verdict: 'ok' })
  })
  it('a sensor with no value in the answer reads as none', () => {
    expect(readingsFrom(sens, {}).every(x => x.value === null)).toBe(true)
  })
})

describe('a label\'s verdict', () => {
  it('by the same families as the fault records', () => {
    expect(labelVerdict('22.BLE Probe Status', 'No Fuel Error - Contact Support')).toBe('fault')
    expect(labelVerdict('22.BLE Probe Status', 'Healthy')).toBe('ok')
    expect(labelVerdict('20.BLE Probe Battery', 'Heathly')).toBe('ok')
    expect(labelVerdict('24.Data Mode', 'Home on Moving')).toBeNull()
    expect(labelVerdict('14.GNSS Status', 'Sleep')).toBeNull()
  })
})

describe('where Wialon gives no value, and labels outside the families', () => {
  it('takes the latest message’s own reading, and says so', () => {
    const sens = { '7': { id: 7, n: '22.BLE Probe Status', t: 'custom', p: 'io_270', c: cfg({ 1: 'No Fuel Error - Contact Support', 2: 'Healthy' }) } }
    const [r] = readingsFrom(sens, { 7: WIALON_NO_VALUE }, { io_270: 1 })
    expect(r).toMatchObject({ value: 1, source: 'raw', label: 'No Fuel Error - Contact Support', verdict: 'fault' })
    expect(readingsFrom(sens, { 7: 2 }, { io_270: 1 })[0]).toMatchObject({ value: 2, source: 'wialon', verdict: 'ok' })
  })
  it('plain fault and health words judge the other sensors, for this report', () => {
    expect(reportVerdict('12.Fls Temperature', 'Sensor not found')).toBe('fault')
    expect(reportVerdict('19.Internal Battery Voltage', 'Present')).toBe('ok')
    expect(reportVerdict('24.Data Mode', 'Home on Moving')).toBeNull()
  })
})
