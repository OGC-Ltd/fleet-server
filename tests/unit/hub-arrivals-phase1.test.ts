import { describe, expect, it } from 'vitest'
import { unitClass, registerClass, type UnitClass } from '../../src/modules/route-ahead/unit-class.js'
import { etaBand, availability, inArrivalClass, classCounts } from '../../src/modules/route-ahead/hub-arrivals.js'
import { equipmentTypeOf } from '../../src/providers/raifactorysuite/raifactorysuite.machine.js'

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

describe('unitClass from the FactorySuite machine register (KASULU)', () => {
  // Every category GET /machines sent on 2026-10-20 (367 rows), through the
  // sync's own normaliser, with the register's basis.
  const REGISTER: [string, 'HOUR' | 'KM_PER_LITRE', UnitClass][] = [
    ['Truck', 'KM_PER_LITRE', 'TRUCK'], ['Hired Truck', 'KM_PER_LITRE', 'TRUCK'],
    ['Water Bowser', 'KM_PER_LITRE', 'TRUCK'], ['Bus', 'KM_PER_LITRE', 'TRUCK'], ['Hired Bus', 'KM_PER_LITRE', 'TRUCK'],
    ['LMV', 'KM_PER_LITRE', 'CAR'], ['FES - LMV', 'KM_PER_LITRE', 'CAR'], ['Hired LMV', 'KM_PER_LITRE', 'CAR'],
    ['POLICE', 'KM_PER_LITRE', 'CAR'],
    ['Mahindra Tractor', 'HOUR', 'TRACTOR'], ['FES - Mahindra', 'HOUR', 'TRACTOR'], ['FES-Mahindra', 'KM_PER_LITRE', 'TRACTOR'],
    ['CASE PUMA', 'HOUR', 'TRACTOR'], ['CASE STEIGER', 'HOUR', 'TRACTOR'], ['CASE 110', 'HOUR', 'TRACTOR'],
    ['CASE MAGNUM', 'HOUR', 'TRACTOR'], ['Case SprayingTractor', 'HOUR', 'TRACTOR'], ['TRACTOR', 'HOUR', 'TRACTOR'],
    ['FES - Challenger', 'HOUR', 'TRACTOR'], ['FES - Fendt', 'HOUR', 'TRACTOR'], ['FES - Massey Ferguson', 'HOUR', 'TRACTOR'],
    ['Excavator', 'HOUR', 'PLANT'], ['Bull Dozer', 'HOUR', 'PLANT'], ['Wheel Loader', 'HOUR', 'PLANT'],
    ['Grader', 'HOUR', 'PLANT'], ['FES - Grader', 'KM_PER_LITRE', 'PLANT'], ['Backhoe', 'HOUR', 'PLANT'],
    ['Compactor', 'HOUR', 'PLANT'], ['COMPACTOR', 'HOUR', 'PLANT'], ['SMALLCOMPACTOR', 'HOUR', 'PLANT'],
    ['Hydra Crane', 'HOUR', 'PLANT'], ['HYDRA', 'HOUR', 'PLANT'], ['Slew Loader', 'HOUR', 'PLANT'],
    ['Concret Mixer', 'HOUR', 'PLANT'], ['CONCRETE MIXER', 'HOUR', 'PLANT'], ['Concrete Pump', 'HOUR', 'PLANT'],
    ['DRILLING MACHINE', 'HOUR', 'PLANT'], ['FES - Forklift', 'HOUR', 'PLANT'], ['FES - Chopper harvester', 'HOUR', 'PLANT'],
    ['Hired Machines', 'HOUR', 'PLANT'],
    ['DIESEL GENERATORS', 'HOUR', 'FIXED'], ['DIESEL GENERATOR', 'HOUR', 'FIXED'], ['SMALL DIESEL GENERATORS', 'HOUR', 'FIXED'],
    ['SMALL PETROL GENERATORS', 'HOUR', 'FIXED'], ['FES - Generator', 'HOUR', 'FIXED'], ['HIRED GENERATOR', 'HOUR', 'FIXED'],
    ['Hand Compactor', 'HOUR', 'FIXED'], ['Drums', 'HOUR', 'FIXED'],
  ]
  it.each(REGISTER)('%s (%s) is %s', (category, basis, want) => {
    const reg = { equipmentType: equipmentTypeOf(category), ratedConsumptionBasis: basis === 'HOUR' ? 'HOURS' : 'DISTANCE' }
    expect(unitClass('UNSPECIFIED', 'MUFINDI - X 01', reg)).toBe(want)
  })

  it('overrides the Wialon type where the two disagree (live, 2026-10-20)', () => {
    expect(unitClass('UNSPECIFIED', 'MUFINDI - DG 06', { equipmentType: 'Diesel Generator', ratedConsumptionBasis: 'HOURS' })).toBe('FIXED')
    expect(unitClass('UNSPECIFIED', 'MUFINDI - WL 08', { equipmentType: 'Wheel Loader', ratedConsumptionBasis: 'HOURS' })).toBe('PLANT')
    expect(unitClass('TRACTOR', 'MUFINDI - HYD 01', { equipmentType: 'Hydra Crane', ratedConsumptionBasis: 'HOURS' })).toBe('PLANT')
    expect(unitClass('TRUCK', 'MUFINDI - SPY 01', { equipmentType: 'Case Spraying Tractor', ratedConsumptionBasis: 'HOURS' })).toBe('TRACTOR')
    expect(unitClass('PLANT', 'MUFINDI - DB 30', { equipmentType: 'Truck', ratedConsumptionBasis: 'DISTANCE' })).toBe('TRUCK')
  })

  it('falls to the rated basis for a type no rule names, then to the Wialon type', () => {
    expect(registerClass({ equipmentType: 'Something New', ratedConsumptionBasis: 'DISTANCE' })).toBe('TRUCK')
    expect(registerClass({ equipmentType: 'Something New', ratedConsumptionBasis: 'HOURS' })).toBe('PLANT')
    expect(registerClass({ equipmentType: null, ratedConsumptionBasis: null })).toBeNull()
    expect(unitClass('BUS', 'MUFINDI - BUS 02', { equipmentType: null })).toBe('TRUCK')
    expect(unitClass('TRACTOR', 'MUFINDI - CTR 30', null)).toBe('TRACTOR')
  })
})

describe('unitClass from FactorySuite /vehicles (SUKARI = NDHIWA)', () => {
  // vehicleType is FactorySuite's own type, synced by plate; checked against
  // GET /vehicles 2026-10-20: all 594 tracked units agree.
  it('keeps FactorySuite TRACTOR and TRUCK', () => {
    expect(unitClass('TRACTOR', '125F Bell 38 KHMA 858U')).toBe('TRACTOR')
    expect(unitClass('TRACTOR', 'Mahindra 9200 4WD KTCC 787D')).toBe('TRACTOR')
    expect(unitClass('TRUCK', 'Faw Prime Mover CA 4181 KDL 712E')).toBe('TRUCK')
    expect(unitClass('TRUCK', 'Toyota  Hlux KCA 001A')).toBe('TRUCK')
  })

  // Every tracked COMPANY_VEHICLE on 2026-10-20, by FactorySuite make + model.
  const COMPANY: [string, UnitClass][] = [
    ['Toyota Double Cab GUN125R-DJFLXJ KDM 341M', 'CAR'], ['Toyota Landcruiser HZJ79 KBU 189W', 'CAR'],
    ['Toyota  Landcruiser Van KCU 759H', 'CAR'], ['Toyota Hiace Van KCS 596A', 'CAR'],
    ['Toyota Pick up GUN125R-BJFSXJ KDM 156W', 'CAR'], ['Toyota Hilux KUN25R KBN 201N', 'CAR'],
    ['Faw Truck Buses CA1081 KBV 714U', 'TRUCK'], ['Faw Bus CA1081 KCR 118T', 'TRUCK'],
    ['CATERPILLAR D8GC KHMA 449U', 'PLANT'], ['CATERPILLAR D8R KHMA 991H', 'PLANT'],
    ['GRADER KOMATSU 6D125 KHMA 338K', 'PLANT'], ['KOMATSU EXCAVATOR PC200-8M0 KHMA 337K', 'PLANT'],
    ['WOLWA EXCAVATOR WITH GRAPPLE DLS150-6A KHMA 007R', 'PLANT'], ['JCB BACKHOE LOADER 3DX KHMA 907H', 'PLANT'],
    ['BOMAG COMPACTOR BW213PD-40 KHMA 635K', 'PLANT'], ['HYDRACRANE ESCORT KHMA 607A', 'PLANT'],
    ['HYDRA CRANE ESCORT KHMA 800A', 'PLANT'], ['HYDRAUKLIC CRANE FX230 KHMA 686T', 'PLANT'],
    ['WHEELBELL LOADER L1806E KHMA 001A', 'PLANT'], ['DOZER KOMATSU D65EX-16 KHMA 002A', 'PLANT'],
  ]
  it.each(COMPANY)('COMPANY_VEHICLE %s is %s', (name, want) => {
    expect(unitClass('COMPANY_VEHICLE', name)).toBe(want)
  })

  it('lists each class on its own', () => {
    const bus = unitClass('COMPANY_VEHICLE', 'Faw Truck Buses CA1081 KBV 714U')
    const cab = unitClass('COMPANY_VEHICLE', 'Toyota Double Cab GUN125R-DJFLXJ KDM 341M')
    const dozer = unitClass('COMPANY_VEHICLE', 'CATERPILLAR D8R KHMA 991H')
    expect([inArrivalClass(bus, 'TRUCK'), inArrivalClass(bus, 'CAR')]).toEqual([true, false])
    expect([inArrivalClass(cab, 'CAR'), inArrivalClass(cab, 'TRUCK')]).toEqual([true, false])
    expect([inArrivalClass(dozer, 'PLANT'), inArrivalClass(dozer, 'CAR')]).toEqual([true, false])
    expect(inArrivalClass(unitClass('TRACTOR', '125F Bell 38 KHMA 858U'), 'TRUCK')).toBe(false)
  })
})

describe('inArrivalClass', () => {
  it('keeps plant out of "Truck or car" and generators out of everything', () => {
    expect(inArrivalClass('TRUCK', 'VEHICLE')).toBe(true)
    expect(inArrivalClass('CAR', 'VEHICLE')).toBe(true)
    expect(inArrivalClass('PLANT', 'VEHICLE')).toBe(false)
    expect(inArrivalClass('TRACTOR', 'VEHICLE')).toBe(false)
    expect(inArrivalClass('PLANT', 'PLANT')).toBe(true)
    expect(inArrivalClass('TRACTOR', 'TRACTOR')).toBe(true)
    for (const c of ['all', 'VEHICLE', 'TRACTOR', 'PLANT', 'MOTORBIKE'] as const) expect(inArrivalClass('FIXED', c)).toBe(false)
  })
  it('counts the window classes', () => {
    const row = (vehicleType: string, equipmentType: string | null) =>
      ({ vehicleId: equipmentType ?? vehicleType, name: null, vehicleType, equipmentType, lat: null, lng: null, speedKmh: null, capturedAt: null })
    expect(classCounts([row('PLANT', 'Excavator'), row('UNSPECIFIED', 'Diesel Generator'), row('SALOON', 'LMV'),
      row('TRACTOR', 'Hydra Crane'), row('TRACTOR', 'Mahindra Tractor'), row('LORRY', null)]))
      .toEqual({ TRACTOR: 1, TRUCK: 1, CAR: 1, PLANT: 2, VEHICLE: 2 })
  })
})

describe('etaBand', () => {
  it('bands only past an hour', () => {
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
