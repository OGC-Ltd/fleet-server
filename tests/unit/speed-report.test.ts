/**
 * The Speed Report's working: what counts as an occurrence, which limit a unit
 * is held to, and how the rows are laid out.
 */
import { describe, it, expect } from 'vitest'
import { groupOf, limitFor, mileageKm, sortSpeedRows, speedingOf, wialonIdOf, type SpeedMessage } from '../../src/modules/reports/speed-report.service.js'

/** Along the equator, about 1.11 km for each 0.01 degree. */
const m = (t: number, kmh: number, lng = t / 1000): SpeedMessage => ({ t, lat: 0, lng, kmh })

describe('speedingOf', () => {
  it('counts an unbroken run over the limit as one, with its peak and length', () => {
    const s = speedingOf([m(0, 60), m(10, 75), m(20, 90), m(30, 72), m(40, 60)], 70)
    expect(s.occurrences).toBe(1)
    expect(s.maxKmh).toBe(90)
    expect(s.peak).toEqual({ lat: 0, lng: 0.02, at: 20_000 })
    expect(s.overKm).toBeCloseTo(2 * 0.01 * 111.19, 1)
  })

  it('leaves out a single message over the limit, and its peak', () => {
    const s = speedingOf([m(0, 60), m(10, 120), m(20, 60), m(30, 75), m(31, 80), m(40, 60)], 70)
    expect(s.occurrences).toBe(1)
    expect(s.maxKmh).toBe(80)
  })

  it('leaves out two messages at the same second', () => {
    expect(speedingOf([m(10, 90), m(10, 95), m(20, 60)], 70).occurrences).toBe(0)
  })

  it('counts a limit exactly met as not over it', () => {
    expect(speedingOf([m(0, 70), m(10, 70)], 70).occurrences).toBe(0)
  })

  it('closes a run still going when the day ends', () => {
    expect(speedingOf([m(0, 90), m(10, 90)], 70).occurrences).toBe(1)
  })

  it('has no peak place where the fix was missing', () => {
    const s = speedingOf([{ t: 0, lat: null, lng: null, kmh: 90 }, { t: 10, lat: null, lng: null, kmh: 95 }], 70)
    expect(s.occurrences).toBe(1)
    expect(s.overKm).toBe(0)
    expect(s.peak).toBeNull()
  })
})

describe('mileageKm', () => {
  it('counts hops that moved', () => {
    expect(mileageKm([m(0, 50, 0), m(60, 50, 0.01)])).toBeCloseTo(1.11, 1)
  })
  it('does not drive across a long gap, a parked pair, or a jump', () => {
    expect(mileageKm([m(0, 50, 0), m(700, 50, 0.1)])).toBe(0)
    expect(mileageKm([m(0, 0, 0), m(60, 0, 0.001)])).toBe(0)
    expect(mileageKm([m(0, 50, 0), m(10, 50, 1)])).toBe(0)
  })
})

describe('limitFor', () => {
  const policy = { default: { outsideKmh: 80 }, byType: { SALOON: { outsideKmh: 110 } } }
  it('holds a listed light vehicle to its rule, whatever Wialon has', () => {
    expect(limitFor('SALOON', policy, 80, 80)).toBe(110)
  })
  it('uses a per-vehicle server limit ahead of Wialon and type policies', () => {
    expect(limitFor('SALOON', policy, 110, 80, 140)).toBe(140)
  })
  it('takes the limit set on the Wialon unit, as the sheet does', () => {
    expect(limitFor('UNSPECIFIED', policy, 70, 80)).toBe(70)
  })
  it('falls back where Wialon has none, or says 0', () => {
    expect(limitFor('UNSPECIFIED', policy, null, 80)).toBe(80)
    expect(limitFor('UNSPECIFIED', policy, 0, 80)).toBe(80)
  })
})

it('calls an untyped unit on a road plate a truck, and leaves other units under their type', () => {
  expect(groupOf({ type: 'UNSPECIFIED', plate: 'KDE 581S', name: 'WKS - Kabras - KDE 581S' })).toBe('Trucks')
  expect(groupOf({ type: 'UNSPECIFIED', plate: 'KBU 537Q', name: 'WKS - Kabras - Landcruiser-KBU 537Q' })).toBe('Other')
  expect(groupOf({ type: 'UNSPECIFIED', plate: 'KTCC 100G', name: 'KTCC 100G' })).toBe('Other')
  expect(groupOf({ type: 'SALOON', plate: 'KDP 365T', name: 'KDP 365T' })).toBe('Saloons')
  expect(groupOf({ type: 'TRUCK', plate: 'KDL 208X', name: 'KDL 208X' })).toBe('Trucks')
})

it('puts trucks first, then by name', () => {
  const rows = [{ group: 'Other', name: 'A' }, { group: 'Trucks', name: 'WKS - Naitiri - X' }, { group: 'Trucks', name: 'WKS - Kabras - Y' }]
  expect(sortSpeedRows(rows).map(r => r.name)).toEqual(['WKS - Kabras - Y', 'WKS - Naitiri - X', 'A'])
})

it('reads a Wialon id off the device, and nothing off any other', () => {
  expect(wialonIdOf('wialon:12345')).toBe(12345)
  expect(wialonIdOf('5f2c-uuid')).toBeNull()
})
