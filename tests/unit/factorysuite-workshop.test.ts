import { describe, expect, it } from 'vitest'
import {
  boardDays, cardStage, categoryFor, eatDayStart, jobCardColumns, parseFsTime, stageRank, suspectedFaultOf,
} from '../../src/providers/raifactorysuite/raifactorysuite.workshop.js'

describe('parseFsTime', () => {
  it('reads an offsetless FactorySuite time as East Africa time', () => {
    expect(parseFsTime('2026-11-17T16:34:03.198264')?.toISOString()).toBe('2026-11-17T13:34:03.198Z')
  })
  it('keeps a time that carries its own zone', () => {
    expect(parseFsTime('2026-11-17T16:34:03Z')?.toISOString()).toBe('2026-11-17T16:34:03.000Z')
    expect(parseFsTime('2026-11-17T16:34:03+01:00')?.toISOString()).toBe('2026-11-17T15:34:03.000Z')
  })
  it('is null for nothing or nonsense', () => {
    expect(parseFsTime(null)).toBeNull()
    expect(parseFsTime('')).toBeNull()
    expect(parseFsTime('not a date')).toBeNull()
  })
})

describe('categoryFor (fault texts from the live feed, 2026-11-18)', () => {
  const cases: [string, string][] = [
    ['Puncture', 'tyres'], ['TYRE PUNCTURE ON 2RI POSITION', 'tyres'], ['Tire busted', 'tyres'],
    ['WHEEL NUTS LOOSEN', 'tyres'], ['Rear wheel stud broken', 'tyres'],
    ['Brake system problem', 'brakes'], ['Braker pipe leaks', 'brakes'],
    ['BRAKE SYSTEM PROBELM AND VIBRATING DURING ACCELERATING', 'brakes'],
    ['Hydraulic pipe leakage', 'hydraulics'], ['BUCKET TIPS BROKEN', 'hydraulics'],
    ['LIFT CYLINDER PROBLEM', 'hydraulics'],
    ['Transmission problem and track chain broken.', 'transmission'], ['Clutch is not working', 'transmission'],
    ['Final drive problem', 'transmission'], ['DIFFERENTIAL PROBLEM', 'transmission'], ['GEAR HARD SHIFTING', 'transmission'],
    ['Spring broken', 'suspension_steering'],
    ['Alternator not charging', 'electrical'], ['Wiper not working', 'electrical'], ['No battery', 'electrical'],
    ['Brake lights are not functioning', 'electrical'],
    ['Door mirror broken', 'body'], ['FRONTAL BUMPER BROKEN', 'body'], ['Mudguard problem', 'body'],
    ['LOW LEVEL OF ENGINE OIL', 'engine'], ['Not starting', 'engine'], ['Fuel system problem', 'engine'],
    ['AIR CLEANER CLOGGED', 'engine'], ['Injector nozzle fault', 'engine'], ['ENGINE SERVICE', 'engine'],
    ['GPS MALFUNCTIONAL', 'gps'], ['FUEL LEVEL SENSOR INSTALLATION', 'sensor'],
    ['FUEL TRACKER INSTALLATION - UNDER CONTROLL TAKE', 'tracker'],
    ['Daily routine maintenance', 'other'], ['General check ✔️', 'other'], ['AIR CLENER PROBLEM', 'engine'], ['Water outer let Pipe broken', 'engine'], ['NEEDS GREASING', 'other'],
  ]
  it.each(cases)('%s → %s', (text, cat) => expect(categoryFor(text)).toBe(cat))

  it('falls back to the diagnosis, then other', () => {
    expect(categoryFor('', 'Battery is too low and alternator not charging')).toBe('electrical')
    expect(categoryFor(null, null)).toBe('other')
  })
  it('never makes a probe job', () => {
    expect(categoryFor('fuel probe broken')).not.toBe('fuel_probe')
  })
})

describe('cardStage', () => {
  const base = { status: 'IN_PROGRESS', repairStartedAt: null, partsRequestedAt: null, partsReceivedAt: null }
  it('checked in, nothing started', () => expect(cardStage(base)).toBe('in_workshop'))
  it('repair started', () => expect(cardStage({ ...base, repairStartedAt: 'x' })).toBe('fixing'))
  it('parts asked for and not in', () => expect(cardStage({ ...base, repairStartedAt: 'x', partsRequestedAt: 'y' })).toBe('spare_outsourced'))
  it('parts received', () => expect(cardStage({ ...base, repairStartedAt: 'x', partsRequestedAt: 'y', partsReceivedAt: 'z' })).toBe('fixing'))
  it('status AWAITING_PARTS wins over the times (DZ-03, 17 Nov)', () => expect(cardStage({ ...base, status: 'AWAITING_PARTS' })).toBe('spare_outsourced'))
  it('released is completed', () => expect(cardStage({ ...base, status: 'RELEASED' })).toBe('completed'))
  it('cancelled is void', () => expect(cardStage({ ...base, status: 'CANCELLED' })).toBe('void'))
})

describe('stageRank', () => {
  it('orders arrival < workshop < repair < completed', () => {
    expect(stageRank('booked')).toBeLessThan(stageRank('in_workshop'))
    expect(stageRank('in_workshop')).toBeLessThan(stageRank('fixing'))
    expect(stageRank('fixing')).toBe(stageRank('spare_outsourced'))
    expect(stageRank('fixing')).toBeLessThan(stageRank('completed'))
  })
})

describe('jobCardColumns', () => {
  it('normalises a live row', () => {
    const c = jobCardColumns({
      id: 'a', factoryCode: 'MUFINDI PAPER MILLS', cardNumber: 'MUFINDI PAPER MILLS-JC-2026-0247', machine: ' MTR-14 ',
      status: 'IN_PROGRESS', priority: 'NOEMAL', checkedInAt: '2026-11-17T16:34:03.198264', meterReadingIn: 3823.4,
      fuelLevelIn: 52.8, reportedFault: ' Not starting ', service: false, fuelDiscrepancy: true,
    }, 'org', 'veh')
    expect(c.machine).toBe('MTR-14')
    expect(c.priority).toBe('Normal')
    expect(c.reportedFault).toBe('Not starting')
    expect(c.checkedInAt?.toISOString()).toBe('2026-11-17T13:34:03.198Z')
    expect(c.meterIn).toBe(3823.4)
    expect(c.fuelDiscrepancy).toBe(true)
    expect(c.releasedAt).toBeNull()
  })
  it('names a service card with no fault', () => {
    expect(suspectedFaultOf({ reportedFault: null, isService: true, serviceType: '500', cardNumber: 'X' })).toBe('Service (500)')
  })
})

describe('board days (East Africa time)', () => {
  // 18 Nov 2026 05:30 EAT
  const now = new Date('2026-11-18T02:30:00Z')
  it('starts the window at an EAT midnight', () => {
    expect(eatDayStart(now).toISOString()).toBe('2026-11-17T21:00:00.000Z')
    expect(eatDayStart(now, 13).toISOString()).toBe('2026-11-04T21:00:00.000Z')
  })
  it('counts each card on its EAT day, every day present', () => {
    const out = boardDays(3, [
      new Date('2026-11-17T22:00:00Z'), // 18 Nov 01:00 EAT
      new Date('2026-11-17T20:59:00Z'), // 17 Nov 23:59 EAT
      new Date('2026-11-10T08:00:00Z'), // outside
    ], [new Date('2026-11-16T05:00:00Z')], now)
    expect(out).toEqual([
      { day: '2026-11-16', opened: 0, released: 1 },
      { day: '2026-11-17', opened: 1, released: 0 },
      { day: '2026-11-18', opened: 1, released: 0 },
    ])
  })
  it('leaves out the days before the feed began', () => {
    const out = boardDays(3, [], [], now, new Date('2026-11-17T05:00:00Z'))
    expect(out.map((r) => r.day)).toEqual(['2026-11-17', '2026-11-18'])
  })
})
