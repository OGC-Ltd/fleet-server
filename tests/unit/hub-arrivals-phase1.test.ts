import { describe, expect, it } from 'vitest'
import { unitClass } from '../../src/modules/route-ahead/unit-class.js'
import { etaBand, availability } from '../../src/modules/route-ahead/hub-arrivals.js'

describe('unitClass', () => {
  it('reads the register first', () => {
    expect(unitClass('TRACTOR', 'Mahindra 9200 4WD')).toBe('TRACTOR')
    expect(unitClass('PLANT', 'MUFINDI: EX 11')).toBe('PLANT')
    expect(unitClass('SALOON', 'KDA 001A')).toBe('CAR')
    expect(unitClass('LORRY', 'KCB 123A')).toBe('TRUCK')
  })
  it('takes a KT plate as a tractor where the register says nothing', () => {
    expect(unitClass('UNSPECIFIED', 'WKS - Nzoia Sugar - KTCC 224P')).toBe('TRACTOR')
    expect(unitClass('UNSPECIFIED', 'FG - Menengai - KCC 385Z')).toBe('TRUCK')
    expect(unitClass('UNSPECIFIED', 'WKS - Kabras KTCB 358X')).toBe('TRACTOR')
    expect(unitClass('UNSPECIFIED', 'WKS - Kabras - KDJ 827Z')).toBe('TRUCK')
    expect(unitClass('UNSPECIFIED', 'WKS - Kabras - KTCB358X')).toBe('TRACTOR')
  })
})

describe('etaBand', () => {
  it('bands only past the rings', () => {
    expect(etaBand(59 * 60)).toBeNull()
    expect(etaBand(61 * 60)).toBe('1–2 h')
    expect(etaBand(3 * 3600)).toBe('2–4 h')
    expect(etaBand(5 * 3600)).toBe('4 h+')
  })
})

describe('availability', () => {
  const now = Date.UTC(2026, 9, 15, 6)
  it('is busy on a dispatch, stale without a recent fix, else free', () => {
    expect(availability(now - 60_000, true, now)).toBe('busy')
    expect(availability(now - 45 * 60_000, false, now)).toBe('stale')
    expect(availability(now - 60_000, false, now)).toBe('free')
  })
})
