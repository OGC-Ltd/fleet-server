/**
 * The trip report's figures, now worked out on the server (trips/trip-report.build).
 * Carried over from the dashboard's own tests (new-ui lib/tripReport.test.js),
 * so the move changes where the report is made and nothing it says.
 */
import { describe, expect, it } from 'vitest'
import { buildTripReport, BREACH_KINDS, type ReportInput } from '../../src/modules/trips/trip-report.build.js'

const T0 = Date.parse('2026-10-28T05:00:00Z')
const MIN = 60_000
// ~1.1 km per 0.01° of latitude near the equator.
const yard = { lat: -0.8234, lng: 34.3845, name: 'Ndhiwa' }
const dest = { lat: -0.7234, lng: 34.3845, name: 'NYAONDO', spreadM: 300 }

type Fix = [number, number, number, number | null, number | null]

/** Drive north from the yard for 60 min, stand 20 min at a road side, drive on, stand 40 min at the destination. */
function trackFixture(): Fix[] {
  const pts: Fix[] = []
  let t = T0, lat = yard.lat
  const push = (speed: number, ign = 1) => pts.push([t, lat, yard.lng, speed, ign])
  for (let i = 0; i < 30; i++) { push(40); lat += 0.0015; t += 2 * MIN }
  for (let i = 0; i < 10; i++) { push(0, 0); t += 2 * MIN }            // 20 min standing, engine off
  for (let i = 0; i < 25; i++) { push(45); lat += 0.0022; t += 2 * MIN }
  lat = dest.lat
  for (let i = 0; i < 21; i++) { push(0, 1); t += 2 * MIN }             // 40 min at the destination, engine on
  return pts
}

function fixture(over: Record<string, unknown> = {}): ReportInput {
  const track = trackFixture()
  return {
    mode: 'trip',
    generatedAt: T0 + 6 * 60 * MIN,
    companyName: 'SUKARI',
    vehicle: { id: 'v1', plate: 'KCP 145P', type: 'TRACTOR' },
    dispatch: { externalId: 'd-1', serialNumber: null, kind: 'CANE', status: 'DISPATCHED', driverName: 'Joel Kibet',
      destination: 'NYAONDO', dispatchedAt: T0, returnedAt: null, tonnageT: null, bags: null, cargoName: null },
    fromName: null, toName: null,
    window: { from: T0, to: track[track.length - 1]![0], clipped: false },
    day: { from: Date.parse('2026-10-27T21:00:00Z'), to: Date.parse('2026-10-28T21:00:00Z') },
    yard, dest, arrivedAt: T0 + 140 * MIN,
    track,
    legTrack: [],
    map: null,
    altitude: [],
    fuel: { hasProbe: true, series: [[T0, 200], [T0 + 80 * MIN, 180], [T0 + 172 * MIN, 150]], usedByCounterL: null,
      fillings: [], drains: [{ t: T0 + 70 * MIN, litres: 12, after: 180, place: null, review: null }] },
    dashcam: { fitted: false, complete: true, alarms: [] },
    speeding: [{ t: T0 + 10 * MIN, durationSec: 120, distanceM: 1900, peakKmh: 62, limitKmh: 40, lat: null, lng: null },
      { t: T0 + 300 * MIN, durationSec: 60, distanceM: 1100, peakKmh: 55, limitKmh: 40, lat: null, lng: null }],
    escalatedThefts: [{ t: T0 + 240 * MIN, litres: 18, place: 'Ndhiwa' }],
    harsh: [{ t: T0 + 100 * MIN, type: 'brake', lat: null, lng: null, speedKmh: 38, ms2: 4 }],
    zones: { timedOut: false, visits: [{ name: 'Nyaondo estate', enteredAt: T0 + 135 * MIN, leftAt: T0 + 180 * MIN, enforced: false }] },
    weighments: [
      { ticket: '1000906522', tokenAt: T0, at: T0, centre: 'FACTORY', grossKg: 19900, tareKg: 10440, netKg: 9460, cargo: 'Cane delivery', driver: null, weighings: [
        { kind: 'Tare', kg: 10440, at: T0 + 30 * MIN, bridge: 'FACTORY · bridge 1', doubtful: false },
        { kind: 'Gross', kg: 19900, at: T0 - 13 * 60 * MIN, bridge: 'FACTORY · bridge 1', doubtful: true }] },
      { ticket: '1000906400', tokenAt: T0 - 180 * MIN, at: T0, centre: 'FACTORY', grossKg: 20100, tareKg: 10400, netKg: 9700, cargo: 'Cane delivery', driver: null, weighings: [
        { kind: 'Gross', kg: 20100, at: T0 - 120 * MIN, bridge: 'FACTORY · bridge 2', doubtful: false },
        { kind: 'Tare', kg: 10400, at: T0 - 90 * MIN, bridge: 'FACTORY · bridge 2', doubtful: false }] }],
    ...over,
  } as unknown as ReportInput
}

describe('buildTripReport', () => {
  const r = buildTripReport(fixture())

  it('measures distance and time from moving segments only', () => {
    expect(r.summary.distanceKm).toBeGreaterThan(10)
    // Moving up to arrival, the first fix inside the destination (T0+124).
    expect(r.summary.movingMs).toBe(104 * MIN)
    expect(r.summary.movingMs! + r.summary.stoppedMs!).toBe(r.toDestinationMs)
    expect(r.summary.maxKmh).toBe(45)
  })

  it('finds stops of 5 minutes or more on the way; the wait at the destination is after arrival', () => {
    expect(r.stops).toHaveLength(1)
    expect(r.stops[0]!.remark).toBe('Unscheduled')
    expect(r.stops[0]!.ms).toBe(20 * MIN)
    expect(r.stops[0]!.flag).toBe(false)
  })

  it('works out fuel used from the probe, less the drain, departure to arrival', () => {
    expect(r.fuel.startL).toBe(200)
    expect(r.fuel.endL).toBe(180)            // the 150 L reading is after arrival
    expect(r.summary.fuelUsedL).toBe(8)
    expect(r.fuel.rows[0]).toMatchObject({ kind: 'drain', label: 'Suspected theft', flag: true })
  })

  it('counts conduct during the trip only: the theft and the second overspeed come after arrival', () => {
    expect(r.breaches.counts).toEqual({ theft: 0, brake: 1, speed: 1, accel: 0 })
    expect(r.breaches.overspeedMs).toBe(2 * MIN)
    expect(r.breaches.overspeedKm).toBe(1.9)
    expect(BREACH_KINDS.map(k => k.key)).toEqual(Object.keys(r.breaches.counts))
  })

  it('lists every weighing with the time since the previous one', () => {
    const W = r.weighbridge
    expect(W.rows.map(x => `${x.ticket} ${x.kind}`)).toEqual(['1000906400 Gross', '1000906400 Tare', '1000906522 Tare', '1000906522 Gross'])
    expect(W.rows.map(x => x.sinceMs)).toEqual([null, 30 * MIN, 120 * MIN, null])
    expect(W.rows.map(x => x.netKg)).toEqual([null, 9700, null, 9460])
    expect(W).toMatchObject({ tickets: 2, weighings: 4, netKg: 19160, doubtful: true })
    expect(W.bridges).toEqual(['FACTORY · bridge 2', 'FACTORY · bridge 1'])
  })

  it('marks departure from the yard and arrival at the destination, not the zone at the destination again', () => {
    expect(r.geo.rows.map(g => `${g.label} ${g.zone}`)).toEqual(['Departure Ndhiwa', 'Arrival NYAONDO'])
  })

  it('leaves the journey back out: it is after arrival, outside the trip', () => {
    const back: Fix[] = []
    const last = trackFixture().at(-1)!
    for (let i = 1; i <= 30; i++) back.push([last[0] + i * 2 * MIN, dest.lat - (dest.lat - yard.lat) * (i / 30), yard.lng, 50, 1])
    const t = buildTripReport(fixture({ track: [...trackFixture(), ...back], zones: { timedOut: false, visits: [] } }))
    expect(t.geo.rows.map(g => `${g.label} ${g.zone}`)).toEqual(['Departure Ndhiwa', 'Arrival NYAONDO'])
  })

  it('uses the declared load before any weighbridge ticket', () => {
    const s = buildTripReport(fixture({ dispatch: { ...fixture().dispatch, kind: 'SALES', tonnageT: 29, bags: 580, cargoName: 'Processed Sugar' } }))
    expect(s.declared).toMatchObject({ netKg: 29000, bags: 580 })
  })

  it('numbers the report from the plate and the departure', () => {
    expect(r.reportNo).toBe('TR-KCP145P-20261028-0800')
  })
})

describe('dashcam conduct', () => {
  const cam = { fitted: true, complete: true, alarms: [
    { t: T0 + 20 * MIN, kind: 'seatbelt', label: 'No seat belt', lat: null, lng: null, speed: 30 },
    { t: T0 + 50 * MIN, kind: 'phone', label: 'Phone call', lat: null, lng: null, speed: 41 },
    { t: T0 + 55 * MIN, kind: 'hands', label: 'Both hands off the wheel', lat: null, lng: null, speed: 44 }] }

  it('adds seat belt, phone and hands-off columns only for a unit with a dashcam', () => {
    expect(buildTripReport(fixture()).breaches.kinds.map(k => k.key)).not.toContain('seatbelt')
    const r = buildTripReport(fixture({ dashcam: cam }))
    expect(r.breaches.counts).toMatchObject({ seatbelt: 1, phone: 1, hands: 1 })
  })

  it('reports load details from the dispatch and the tickets', () => {
    expect(buildTripReport(fixture()).load).toMatchObject({ cargo: 'Cane delivery', kind: 'Cane', ref: 'd-1', declaredKg: null, weighedKg: 19160 })
  })
})

describe('everything inside the trip (KCP 134P, 30 Oct 2026)', () => {
  // Left the yard 2 min before the gate sign-out, arrived at 140 min, then sat
  // at the destination for hours before the report was made.
  const base = fixture()
  const late: Fix[] = []
  const last = (base.track as Fix[]).at(-1)!
  for (let i = 1; i <= 120; i++) late.push([last[0] + i * 2 * MIN, dest.lat, dest.lng, 0, 0])
  const signedOut = T0 + 16 * MIN
  const r = buildTripReport(fixture({
    dispatch: { ...base.dispatch, dispatchedAt: signedOut },
    track: [...(base.track as Fix[]), ...late],
    window: { from: T0, to: late.at(-1)![0], clipped: false },
    harsh: [{ t: T0 - 300 * MIN, type: 'accel', lat: null, lng: null, speedKmh: 33 },
      { t: T0 + 100 * MIN, type: 'brake', lat: null, lng: null, speedKmh: 38 }],
  }))

  it('starts at the yard exit just before the sign-out and ends on arrival', () => {
    expect(r.window.from).toBeLessThan(signedOut)
    expect(r.window.from).toBeGreaterThanOrEqual(signedOut - 30 * MIN)
    expect(r.geo.rows[0]).toMatchObject({ label: 'Departure', t: r.window.from })
    const arrival = r.geo.rows.find(g => g.label === 'Arrival')!
    expect(r.window.to).toBe(arrival.t)
    expect(r.toDestinationMs).toBe(r.window.to - r.window.from)
  })
  it('moving time plus stopped time is the time taken', () => {
    expect(r.summary.movingMs! + r.summary.stoppedMs!).toBe(r.toDestinationMs)
  })
  it('lists no stop after arrival', () => {
    expect(r.stops.every(s => s.t <= r.window.to && s.endT <= r.window.to)).toBe(true)
  })
  it('leaves out conduct from before departure', () => {
    expect(r.breaches.counts.accel).toBe(0)
    expect(r.breaches.rows.every(b => b.t >= r.window.from && b.t <= r.window.to)).toBe(true)
  })
  it('without an arrival, runs to the end of the window', () => {
    const t = buildTripReport(fixture({ arrivedAt: null, dest: null }))
    expect(t.window.to).toBe(fixture().window.to)
    expect(t.to.arrivedAt).toBeNull()
  })
  it('keeps altitude inside the trip only', () => {
    const altitude = Array.from({ length: 100 }, (_, i) => [T0 - 60 * MIN + i * 3 * MIN, 1500 + i * 2])
    const a = buildTripReport(fixture({ altitude }))
    expect(a.altitude.length).toBeGreaterThan(10)
    expect(a.altitude.every(([t]) => t >= a.window.from && t <= a.window.to)).toBe(true)
  })
})
