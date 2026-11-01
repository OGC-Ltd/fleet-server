/**
 * The movement report's working (reports/movement-report.service): which way
 * a unit is going relative to MORL, and how the operator's unit names group.
 * The names are from the operator's own sheet.
 */
import { describe, it, expect } from 'vitest'
import { classify, groupingOf, groupOrder, type MorlFence } from '../../src/modules/reports/movement-report.service.js'

// A circle around MORL; about 0.009° of latitude to the kilometre.
const morl: MorlFence = { name: 'MORL', centre: { lat: -4.05, lng: 39.65 },
  geometry: { type: 'CIRCLE', centerLat: -4.05, centerLng: 39.65, radiusM: 800 } }
const fix = (lat: number, speedKmh: number | null = 60) => ({ lat, lng: 39.65, at: Date.now(), speedKmh })

describe('classify', () => {
  it('is "to MORL" when the unit is a kilometre or more closer than at the start of the window', () => {
    const c = classify(fix(-3.5), { lat: -3.0, lng: 39.65 }, morl)
    expect(c.state).toBe('to')
    expect(c.closerKm).toBeGreaterThan(50)
    expect(c.kmToMorl).toBeCloseTo(61.2, 0)
  })

  it('is "from MORL" when it is further away', () => {
    expect(classify(fix(-3.9), { lat: -4.0, lng: 39.65 }, morl).state).toBe('from')
  })

  it('is "at MORL" inside the fence, whatever it did before', () => {
    expect(classify(fix(-4.051, 0), { lat: -3.0, lng: 39.65 }, morl)).toMatchObject({ state: 'at', kmToMorl: 0 })
  })

  it('has no direction for less than a kilometre of change: moving or stopped by its speed', () => {
    expect(classify(fix(-3.5, 0), { lat: -3.5005, lng: 39.65 }, morl).state).toBe('stopped')
    expect(classify(fix(-3.5, 40), { lat: -3.5005, lng: 39.65 }, morl).state).toBe('moving')
  })

  it('has no direction without a fix at the start of the window, or without a MORL fence', () => {
    expect(classify(fix(-3.5, 40), null, morl)).toMatchObject({ state: 'moving', closerKm: null })
    expect(classify(fix(-3.5, 0), { lat: -3.0, lng: 39.65 }, null)).toMatchObject({ state: 'stopped', kmToMorl: null })
  })

  it('says so when the unit has never reported a position', () => {
    expect(classify(null, null, morl).state).toBe('no-fix')
  })
})

describe('groupingOf', () => {
  it("takes the grouping before the plate, however the name is written", () => {
    expect(groupingOf('CPO - Menengai - KCV 039A', 'KCV 039A')).toBe('CPO - Menengai')
    expect(groupingOf('CPO - Menengai KCN 912F', 'KCN 912F')).toBe('CPO - Menengai')
    expect(groupingOf('CPO - MENENGAI - KCV 033A', 'KCV 033A')).toBe('CPO - MENENGAI')
    expect(groupingOf('CPO - Menengai - KCH 045A (FMB202)', 'KCH 045A')).toBe('CPO - Menengai')
    expect(groupingOf('CPO - Menengai - KCC 386Z - FMB140', 'KCC386Z')).toBe('CPO - Menengai')
  })

  it('is null for a name that is only the plate', () => {
    expect(groupingOf('KCV 039A', 'KCV 039A')).toBeNull()
    expect(groupingOf(null, 'KCV 039A')).toBeNull()
  })
})

describe('groupOrder', () => {
  it('puts CPO first, then the rest by name', () => {
    expect(['Van Sales', 'Tankers', 'CPO - Menengai'].sort(groupOrder)).toEqual(['CPO - Menengai', 'Tankers', 'Van Sales'])
  })
})
