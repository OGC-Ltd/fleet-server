import { describe, expect, it } from 'vitest'
import { idleUnits, idleWords, workingMs, IDLE_MS, type IdleUnit } from '../../src/modules/idle-watch/idle-watch.rules.js'
import { storePlaces } from '../../src/modules/stop-watch/stop-watch.rules.js'

/** Nairobi time, as the operator reads it. */
const at = (s: string) => Date.parse(`${s}+03:00`)
const iso = (s: string) => new Date(at(s)).toISOString()
const NOW = at('2026-11-11T15:00:00')
const list = [
  { plate: 'KDE 132E', size: 'HYUNDAI', designation: 'RETAIL' },
  { plate: 'KCE 780B', size: 'PROBOX', designation: 'GT/MT' },
]
const unit = (over: Partial<IdleUnit>): IdleUnit => ({
  vehicleId: 'v1', plate: 'KDE 132E', name: null, lat: -0.9, lng: 36.5, speedKmh: 0, engineOn: false,
  capturedAt: iso('2026-11-11T14:55:00'), movement: { state: 'resting', since: iso('2026-11-11T09:00:00'), exact: true }, ...over,
})
const excluded = storePlaces()

describe('workingMs', () => {
  it('counts only the day shift, 07:30 to 19:30 Nairobi time', () => {
    expect(workingMs(at('2026-11-11T09:00:00'), at('2026-11-11T15:00:00'))).toBe(6 * 3_600_000)
    // Parked 18:00, away 08:00 next day: 1 h 30 min of the evening, 30 min of the morning
    expect(workingMs(at('2026-11-10T18:00:00'), at('2026-11-11T08:00:00'))).toBe(2 * 3_600_000)
    // The whole night stands for nothing
    expect(workingMs(at('2026-11-10T19:30:00'), at('2026-11-11T07:30:00'))).toBe(0)
    // Two whole days: two shifts of 12 h
    expect(workingMs(at('2026-11-09T00:00:00'), at('2026-11-11T00:00:00'))).toBe(24 * 3_600_000)
    expect(workingMs(at('2026-11-11T10:00:00'), at('2026-11-11T09:00:00'))).toBe(0)
  })
})

describe('idleUnits', () => {
  it('flags a listed unit stood 3 h or more of working time, critical from 6 h', () => {
    const { alerts } = idleUnits([unit({})], { list, excluded, now: NOW })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ plate: 'KDE 132E', size: 'HYUNDAI', designation: 'RETAIL', severity: 'critical', sinceExact: true, idleMs: 6 * 3_600_000 })
    expect(alerts[0]!.key).toBe(`v1|idle|${at('2026-11-11T09:00:00')}`)
    const warn = idleUnits([unit({ movement: { state: 'resting', since: iso('2026-11-11T11:30:00'), exact: true } })], { list, excluded, now: NOW })
    expect(warn.alerts[0]).toMatchObject({ severity: 'warning', idleMs: 3.5 * 3_600_000 })
  })

  it('leaves out a unit parked overnight, one under 3 h, one moving, and one in the yard or a depot', () => {
    // Parked 18:00: by 08:30 that is 1 h 30 min of the evening and 1 h of the morning
    const morning = at('2026-11-11T08:30:00')
    const overnight = idleUnits([unit({ capturedAt: iso('2026-11-11T08:25:00'), movement: { state: 'resting', since: iso('2026-11-10T18:00:00'), exact: true } })], { list, excluded, now: morning })
    expect(overnight.alerts).toEqual([])
    const units = [
      unit({ vehicleId: 'a', movement: { state: 'resting', since: iso('2026-11-11T13:00:00'), exact: true } }),
      unit({ vehicleId: 'b', speedKmh: 45, movement: { state: 'moving', since: iso('2026-11-11T14:00:00'), exact: true } }),
    ]
    expect(idleUnits(units, { list, excluded, now: NOW }).alerts).toEqual([])
    // MORL yard and the Nairobi depot (STO), 1 km round each
    expect(idleUnits([unit({ lat: -0.2880, lng: 36.0449 })], { list, excluded, now: NOW }).alerts).toEqual([])
    expect(idleUnits([unit({ lat: -1.3027, lng: 36.8657 })], { list, excluded, now: NOW }).alerts).toEqual([])
  })

  it('reads the plate from the name, and says which listed units it cannot judge', () => {
    const units = [
      unit({ plate: 'VS - Menengai - KDE 132E' }),
      unit({ vehicleId: 'dark', plate: 'KCE 780B', capturedAt: iso('2026-11-05T10:00:00') }),
    ]
    const w = idleUnits(units, { list, excluded, now: NOW })
    expect(w.alerts.map((a) => a.plate)).toEqual(['KDE 132E'])
    expect(w.notReporting).toEqual([{ plate: 'KCE 780B', vehicleId: 'dark', lastSeenAt: at('2026-11-05T10:00:00') }])
    expect(idleUnits([unit({})], { list, excluded, now: NOW }).notOnPlatform).toEqual(['KCE 780B'])
  })

  it('keeps a stop the server did not see begin, marked as at least that long', () => {
    const { alerts } = idleUnits([unit({ movement: { state: 'resting', since: iso('2026-11-11T08:00:00'), exact: false } })], { list, excluded, now: NOW })
    expect(alerts[0]).toMatchObject({ sinceExact: false })
    expect(alerts[0]!.idleMs).toBeGreaterThanOrEqual(IDLE_MS)
  })
})

describe('idleWords', () => {
  it('reads as hours and minutes, or days and hours', () => {
    expect(idleWords(3 * 3_600_000 + 5 * 60_000)).toBe('3 h 05 min')
    expect(idleWords(28 * 3_600_000)).toBe('1 d 4 h')
    expect(idleWords(42 * 60_000)).toBe('42 min')
    expect(idleWords(3 * 3_600_000)).toBe('3 h')
  })
})
