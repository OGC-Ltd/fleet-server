/**
 * The tracker's status codes, on the sensors and labels the 2026-11-27 survey
 * found on the account (Menengai's BLE set, West Kenya's Fls status).
 */
import { describe, it, expect } from 'vitest'
import { labelFor, readTrackerStatus, sensorValue } from '../../src/providers/wialon/wialon.status-codes.js'
import type { WialonSensor } from '../../src/providers/wialon/wialon.sensors.js'

const cfg = (ci: Record<string, string>) => JSON.stringify({ act: 1, ci: Object.fromEntries(Object.entries(ci).map(([k, t]) => [k, { c: 0, t }])) })

const FLS: WialonSensor = { n: '11.Fls Status', t: 'custom', p: 'flls1', c: cfg({ 0: 'Off', 1: 'Not Ready', 2: 'Ready', 3: 'Error' }) }
const FLS_LEVEL: WialonSensor = { n: '2.Main Tank Fuel Level Qty (605L)', t: 'fuel level', p: 'clls1', tbl: [{ x: 0, a: 0, b: 0 }, { x: 4000, a: 0, b: 605 }] as never }
const BLE_STATUS: WialonSensor = { n: '22.BLE Probe Status', t: 'custom', p: 'io_270', c: cfg({ 0: 'Sensor not Paired - Contact Support', 1: 'No Fuel Error - Contact Support', 2: 'Healthy', 4095: 'Full/Short Circuit/Water/Mettallic/Dirt/lighter Fuel - Contact Support' }) }
const BLE_TEMP: WialonSensor = { n: '21.BLE Probe Temperature', t: 'custom', p: 'io_25*const10', c: cfg({ 32765: 'Abnormal State', 32766: 'Sensor Failed', 32767: 'Sensor Not Found' }) }
const BLE_BATT: WialonSensor = { n: '20.BLE Probe Battery', t: 'custom', p: 'io_29/const10', c: cfg({ 0: 'Needs Replacement', 3.2: 'Needs Replacement', 3.3: 'Degrading', 3.5: 'Heathly' }) }
const GNSS: WialonSensor = { n: '14.GNSS Status', t: 'custom', p: 'io_69', c: cfg({ 0: 'Off', 1: 'On with Fix', 2: 'On without Fix', 3: 'Sleep', 4: 'ON with fix, invalid data' }) }
const sensors = (...s: WialonSensor[]) => Object.fromEntries(s.map((x, i) => [String(i + 1), x]))

describe('a sensor’s value and label', () => {
  it('reads plain, multiplied and divided parameters', () => {
    expect(sensorValue('flls1', { flls1: 3 })).toBe(3)
    expect(sensorValue('io_25*const10', { io_25: 3276.7 })).toBe(32767) // Wialon sends it scaled
    expect(sensorValue('io_25*const10', { io_25: 3276.6 })).toBe(32766)
    expect(sensorValue('io_29/const10', { io_29: 31 })).toBeCloseTo(3.1)
    expect(sensorValue('io_29', {})).toBeNull()
    expect(sensorValue('([a]+[b])/const2', { a: 1 })).toBeNull()
  })
  it('takes the label at or below the value', () => {
    expect(labelFor(FLS.c, 3)).toBe('Error')
    expect(labelFor(BLE_BATT.c, 3.4)).toBe('Degrading')
    expect(labelFor(BLE_STATUS.c, 812)).toBe('Healthy')
    expect(labelFor('not json', 1)).toBeNull()
  })
})

describe('the tracker’s status, by the account’s labels', () => {
  it('KDJ 813Z: Fls status Error is a probe fault, though the level reads 0', () => {
    const r = readTrackerStatus(sensors(FLS_LEVEL, FLS), { clls1: 0, flls1: 3, tlls1: 0 })
    expect(r.faults).toEqual([{ kind: 'fuel_probe_status', reason: 'Fuel probe: Status Error', raw: 3 }])
    expect(r.ok).toEqual([])
  })
  it('Fls Ready is a recovery; Off and Not Ready are neither', () => {
    expect(readTrackerStatus(sensors(FLS), { flls1: 2 })).toEqual({ faults: [], ok: ['fuel_probe_status'] })
    expect(readTrackerStatus(sensors(FLS), { flls1: 0 })).toEqual({ faults: [], ok: [] })
    expect(readTrackerStatus(sensors(FLS), { flls1: 1 })).toEqual({ faults: [], ok: [] })
  })
  it('a BLE probe that is not paired or reads No Fuel Error, or is not found', () => {
    expect(readTrackerStatus(sensors(BLE_STATUS), { io_270: 1 }).faults[0]?.reason).toBe('Fuel probe: No Fuel Error - Contact Support')
    expect(readTrackerStatus(sensors(BLE_STATUS), { io_270: 0 }).faults[0]?.reason).toBe('Fuel probe: Sensor not Paired - Contact Support')
    const both = readTrackerStatus(sensors(BLE_STATUS, BLE_TEMP), { io_270: 0, io_25: 3276.7 })
    expect(both.faults).toHaveLength(1)
    expect(both.faults[0]?.reason).toBe('Fuel probe: Sensor not Paired - Contact Support; Fuel probe: Sensor Not Found')
  })
  it('a healthy BLE reading is a recovery; 4095 and up are left to the calibrated-range check', () => {
    expect(readTrackerStatus(sensors(BLE_STATUS, BLE_TEMP), { io_270: 812, io_25: 25 })).toEqual({ faults: [], ok: ['fuel_probe_status'] })
    expect(readTrackerStatus(sensors(BLE_STATUS), { io_270: 4095 })).toEqual({ faults: [], ok: [] })
  })
  it('one sensor’s fault outranks another’s health', () => {
    const r = readTrackerStatus(sensors(BLE_STATUS, BLE_TEMP), { io_270: 812, io_25: 3276.6 })
    expect(r.faults.map(f => f.reason)).toEqual(['Fuel probe: Sensor Failed'])
    expect(r.ok).toEqual([])
  })
  it('the probe battery: low is its own fault, 0 (no probe answering) is not', () => {
    expect(readTrackerStatus(sensors(BLE_BATT), { io_29: 31 }).faults).toEqual([{ kind: 'fuel_probe_battery', reason: 'Fuel probe battery: Needs Replacement (3.10 V)', raw: 3.1 }])
    expect(readTrackerStatus(sensors(BLE_BATT), { io_29: 34 }).faults[0]?.reason).toBe('Fuel probe battery: Degrading (3.40 V)')
    expect(readTrackerStatus(sensors(BLE_BATT), { io_29: 36 })).toEqual({ faults: [], ok: ['fuel_probe_battery'] })
    expect(readTrackerStatus(sensors(BLE_BATT), { io_29: 0 })).toEqual({ faults: [], ok: [] })
  })
  it('the variants the account has (2026-11-27): Healthy spelt right, Fls labelled Healthy', () => {
    const batt = { ...BLE_BATT, c: cfg({ 3.2: 'Needs Replacement', 3.3: 'Battery Degrading', 3.5: 'Healthy' }) }
    expect(readTrackerStatus(sensors(batt), { io_29: 36 })).toEqual({ faults: [], ok: ['fuel_probe_battery'] })
    expect(readTrackerStatus(sensors(batt), { io_29: 34 }).faults[0]?.reason).toBe('Fuel probe battery: Battery Degrading (3.40 V)')
    const fls = { ...FLS, c: cfg({ 1: 'NO Calibration', 2: 'Healthy' }) }
    expect(readTrackerStatus(sensors(fls), { flls1: 2 })).toEqual({ faults: [], ok: ['fuel_probe_status'] })
    expect(readTrackerStatus(sensors(fls), { flls1: 1 })).toEqual({ faults: [], ok: [] })
  })
  it('GPS: without a fix or with invalid data is a fault; Off and Sleep are neither', () => {
    expect(readTrackerStatus(sensors(GNSS), { io_69: 2 }).faults[0]).toEqual({ kind: 'gnss_fault', reason: 'GPS: On without Fix', raw: 2 })
    expect(readTrackerStatus(sensors(GNSS), { io_69: 4 }).faults[0]?.reason).toBe('GPS: ON with fix, invalid data')
    expect(readTrackerStatus(sensors(GNSS), { io_69: 1 })).toEqual({ faults: [], ok: ['gnss_fault'] })
    expect(readTrackerStatus(sensors(GNSS), { io_69: 0 })).toEqual({ faults: [], ok: [] })
    expect(readTrackerStatus(sensors(GNSS), { io_69: 3 })).toEqual({ faults: [], ok: [] })
  })
  it('says nothing without the sensor, its parameter or its labels', () => {
    expect(readTrackerStatus(undefined, { flls1: 3 })).toEqual({ faults: [], ok: [] })
    expect(readTrackerStatus(sensors(FLS), { clls1: 0 })).toEqual({ faults: [], ok: [] })
    expect(readTrackerStatus(sensors({ ...FLS, c: undefined }), { flls1: 3 })).toEqual({ faults: [], ok: [] })
  })
})
