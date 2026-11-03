/**
 * The Tankers Report's working (reports/tankers-report.service): when a
 * tanker left the Mombasa depot, how far it went in the 4 hours and since,
 * and which tankers are red. Moved here from the Reports page, 4 Nov 2026.
 */
import { describe, it, expect } from 'vitest'
import { depotTrip, markSlow, sortRows, trackKm, DEPOT, type Ping } from '../../src/modules/reports/tankers-report.service.js'
import type { MorlFence } from '../../src/modules/reports/movement-report.service.js'

const at = (s: string) => Date.parse(`${s}+03:00`)
// MORL: a circle near Nakuru.
const MORL = { lat: -0.25, lng: 36.005 }
const morl: MorlFence = { name: 'MORL', centre: MORL, geometry: { type: 'CIRCLE', centerLat: MORL.lat, centerLng: MORL.lng, radiusM: 600 } }
const DEPOT_AT = { lat: DEPOT.lat, lng: DEPOT.lng }
// On the Mombasa road, `km` from the depot (about 0.009° a km).
const road = (km: number) => ({ lat: DEPOT.lat + km * 0.009, lng: DEPOT.lng - km * 0.0005 })
const ping = (ts: string, where: { lat: number; lng: number }): Ping => ({ t: at(ts), ...where, speedKmh: 40 })
/** A reading every 2 minutes from `a` to `b`, driving from km `k0` to `k1` out of the depot. */
function drive(a: string, b: string, k0: number, k1: number): Ping[] {
  const out: Ping[] = []
  const t0 = at(a); const t1 = at(b)
  for (let t = t0; t <= t1; t += 120_000) {
    const k = k0 + ((k1 - k0) * (t - t0)) / (t1 - t0 || 1)
    out.push({ t, ...road(k), speedKmh: k1 === k0 ? 0 : 60 })
  }
  return out
}

describe('Tankers Report: from the Mombasa depot', () => {
  const to = at('2026-11-03T12:30:00')
  const ctx = { from: to - 4 * 3_600_000, to }

  it('reads when a tanker left the depot, the 4 hours and the whole trip', () => {
    const pings = [
      ping('2026-11-02T14:00:00', DEPOT_AT), ping('2026-11-02T15:54:00', DEPOT_AT),
      ping('2026-11-02T15:54:53', road(1.2)), ...drive('2026-11-02T15:56:53', '2026-11-02T20:00:00', 1.3, 200),
      ...drive('2026-11-03T08:30:00', '2026-11-03T12:30:00', 300, 400),
    ]
    const { trip } = depotTrip(pings, morl, ctx)
    expect(trip!.leftAt).toBe(at('2026-11-02T15:54:53'))
    expect(trip!.status).toBe('transit')
    expect(trip!.windowKm).toBeGreaterThan(90)
    expect(trip!.tripKm).toBeGreaterThan(trip!.windowKm)
  })

  it('skips a step out of the depot and back within 15 minutes', () => {
    const pings = [
      ping('2026-11-02T14:00:00', DEPOT_AT), ping('2026-11-02T14:05:00', road(1.5)), ping('2026-11-02T14:10:00', DEPOT_AT),
      ping('2026-11-02T15:00:00', DEPOT_AT), ping('2026-11-02T15:20:00', road(5)), ...drive('2026-11-03T09:00:00', '2026-11-03T12:00:00', 100, 200),
    ]
    expect(depotTrip(pings, morl, ctx).trip!.leftAt).toBe(at('2026-11-02T15:20:00'))
  })

  it('is completed when it reached MORL, and off the report once that was over a day ago', () => {
    const back = [ping('2026-11-02T10:00:00', DEPOT_AT), ping('2026-11-02T10:30:00', road(2)), ping('2026-11-03T11:00:00', MORL)]
    expect(depotTrip(back, morl, ctx).trip!.status).toBe('completed')
    const old = [ping('2026-11-01T06:00:00', DEPOT_AT), ping('2026-11-01T06:30:00', road(2)), ping('2026-11-02T08:00:00', MORL), ping('2026-11-03T12:00:00', MORL)]
    expect(depotTrip(old, morl, ctx).trip).toBeNull()
    // Reached MORL before these 4 hours but within the day: still listed, for the operator to leave out
    const lastReport = [ping('2026-11-02T10:00:00', DEPOT_AT), ping('2026-11-02T10:30:00', road(2)), ping('2026-11-03T07:00:00', MORL)]
    expect(depotTrip(lastReport, morl, ctx).trip!.status).toBe('completed')
  })

  it('leaves out a tanker still at the depot, and asks for more days when the depot is not in what was read', () => {
    const loading = [ping('2026-11-03T08:00:00', DEPOT_AT), ping('2026-11-03T12:00:00', DEPOT_AT)]
    expect(depotTrip(loading, morl, ctx)).toEqual({ need: false, trip: null })
    const onRoad = drive('2026-11-03T08:30:00', '2026-11-03T12:30:00', 300, 400)
    expect(depotTrip(onRoad, morl, ctx).need).toBe(true)
    expect(depotTrip([], morl, ctx).need).toBe(true)
    const atMorlLong = [ping('2026-11-01T08:00:00', MORL), ping('2026-11-03T12:00:00', MORL)]
    expect(depotTrip(atMorlLong, morl, ctx)).toEqual({ need: false, trip: null })
  })

  it('never completes a trip without a MORL fence', () => {
    const back = [ping('2026-11-02T10:00:00', DEPOT_AT), ping('2026-11-02T10:30:00', road(2)), ping('2026-11-03T11:00:00', MORL)]
    expect(depotTrip(back, null, ctx).trip!.status).toBe('transit')
  })

  it('counts track only while moving, never across a long silence or a GPS jump', () => {
    const t0 = at('2026-11-03T09:00:00')
    const p = (min: number, km: number, speedKmh = 60): Ping => ({ t: t0 + min * 60_000, ...road(km), speedKmh })
    expect(trackKm([p(0, 0), p(2, 2)], t0, t0 + 3_600_000)).toBeCloseTo(2, 0)
    expect(trackKm([p(0, 0, 0), p(2, 0.2, 0)], t0, t0 + 3_600_000)).toBe(0)   // parked drift
    expect(trackKm([p(0, 0), p(30, 20)], t0, t0 + 3_600_000)).toBe(0)         // 30 minutes silent
    expect(trackKm([p(0, 0), p(1, 50)], t0, t0 + 3_600_000)).toBe(0)          // 50 km in a minute
  })

  it('marks red the tankers under half of what the middle one covered', () => {
    const r = (plate: string, km: number, status: 'transit' | 'completed' = 'transit') => ({ unit: { key: plate, plate }, status, windowKm: km, leftAt: 0 })
    const rows = [r('A', 130), r('B', 120), r('C', 110), r('D', 50), r('E', 0), r('F', 5, 'completed')]
    const { median, line } = markSlow(rows)
    expect(median).toBe(110)
    expect(line).toBe(55)
    expect(rows.map(x => x.status)).toEqual(['transit', 'transit', 'transit', 'still', 'still', 'completed'])
    // Nobody moved: still red, the line never under half a kilometre
    const parked = [r('G', 0), r('H', 0.1)]
    expect(markSlow(parked).line).toBe(0.5)
    expect(parked.map(x => x.status)).toEqual(['still', 'still'])
  })

  it('sorts the tankers on the road by time left, then those that reached MORL', () => {
    const r = (plate: string, leftAt: number, status: 'transit' | 'completed' | 'still') => ({ unit: { key: plate, plate }, status, leftAt })
    expect(sortRows([r('A', 3, 'completed'), r('B', 2, 'transit'), r('C', 1, 'still')]).map(x => x.unit.plate)).toEqual(['C', 'B', 'A'])
  })
})
