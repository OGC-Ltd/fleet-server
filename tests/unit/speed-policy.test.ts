import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Kasulu: LMVs (SALOON) 60 km/h inside the factory site and 100 km/h
 * everywhere else — the farms, haulage roads and logistic centres included;
 * every other unit 40 km/h, wherever it is. Geometry is synthetic but named as
 * Kasulu names its zones.
 */
vi.mock('../../src/lib/notifications/notification.store.js', () => ({ publishNotification: vi.fn() }))
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    geofence: { findMany: vi.fn() },
    vehicleGeofence: { findMany: vi.fn() },
    organisation: { findMany: vi.fn() },
  },
}))

const { prisma } = await import('../../src/lib/prisma.js')
const { invalidateZoneCache } = await import('../../src/lib/zone-presence.js')
const { warmSpeedPolicy, zoneLimitAt, speedPolicyFor, _setPolicyOrgsForTest, SPEED_POLICIES } = await import('../../src/lib/speed-policy.js')
const { overspeedLimitFor, deriveAlertFlags } = await import('../../src/lib/derived-alerts.js')
const { deriveSpeeding } = await import('../../src/modules/telemetry/playback-events.js')

const ring = (lat: number, lng: number, size: number): [number, number][] =>
  [[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]
const poly = (id: string, name: string, coords: [number, number][]) => ({
  id, name, type: 'POLYGON', mode: 'BLOCKLIST', isActive: false,
  centerLat: null, centerLng: null, radiusM: null, widthM: null, polygonCoords: coords,
})

const ZONES = [
  poly('factory', 'Factory site Location', ring(-4.05, 30.49, 0.01)),
  poly('farm',    'FARM #215',             ring(-4.2, 30.3, 0.1)),
  poly('lc1',     'Logistic centre1',      ring(-4.02, 30.52, 0.005)),
  { id: 'haul', name: 'Main Haulage road from  Factory to Zone3', type: 'LINE', mode: 'BLOCKLIST', isActive: false,
    centerLat: null, centerLng: null, radiusM: null, widthM: 30,
    polygonCoords: [[30.495, -4.045], [30.495, -4.2]] as [number, number][] },
]

const KASULU = 'org-kasulu'
const IN_FACTORY = { lat: -4.045, lng: 30.495 }  // also on the haulage road's end
const ON_FARM    = { lat: -4.15,  lng: 30.35 }
const IN_LC1     = { lat: -4.018, lng: 30.522 }
const NATIONAL   = { lat: -4.6,   lng: 29.9 }

beforeEach(async () => {
  invalidateZoneCache()
  ;(prisma.geofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(ZONES)
  ;(prisma.organisation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: KASULU, code: 'KASULU' }])
  // The id -> policy table as warmSpeedPolicy resolves it from the org codes
  _setPolicyOrgsForTest(new Map([[KASULU, SPEED_POLICIES.KASULU!]]))
  await warmSpeedPolicy(KASULU)
})

describe('Kasulu speed limits', () => {
  it('holds an LMV to 60 inside the factory site', () => {
    expect(zoneLimitAt(KASULU, 'SALOON', IN_FACTORY.lat, IN_FACTORY.lng)).toEqual({ kmh: 60, source: 'zone', zone: 'factory' })
  })

  it('lets an LMV do 100 on the roads, the farms and the logistic centres', () => {
    for (const p of [NATIONAL, ON_FARM, IN_LC1]) {
      expect(zoneLimitAt(KASULU, 'SALOON', p.lat, p.lng)).toEqual({ kmh: 100, source: 'road', zone: null })
    }
  })

  it('gives an LMV the road limit with no fix, never the stricter one', () => {
    expect(zoneLimitAt(KASULU, 'SALOON', null, null)?.kmh).toBe(100)
  })

  it('holds every other unit to 40, in the factory and out of it', () => {
    for (const type of ['TRUCK', 'LORRY', 'BUS', 'TRACTOR', 'PLANT', 'UNSPECIFIED', null]) {
      for (const p of [IN_FACTORY, NATIONAL, ON_FARM]) {
        expect(zoneLimitAt(KASULU, type, p.lat, p.lng)).toEqual({ kmh: 40, source: 'org', zone: null })
      }
      expect(zoneLimitAt(KASULU, type, null, null)?.kmh).toBe(40)
    }
  })

  it('reads the type case-blind', () => {
    expect(zoneLimitAt(KASULU, 'saloon', NATIONAL.lat, NATIONAL.lng)?.kmh).toBe(100)
  })

  it('leaves every other org on its type or fleet limit', () => {
    expect(zoneLimitAt('org-other', 'SALOON', IN_FACTORY.lat, IN_FACTORY.lng)).toBeNull()
    expect(overspeedLimitFor(null, { orgId: 'org-other', ...IN_FACTORY })).toBe(80)
    expect(speedPolicyFor('org-other')).toBeNull()
  })

  it('is what overspeedLimitFor answers when told the org and place', () => {
    expect(overspeedLimitFor('SALOON', { orgId: KASULU, ...IN_FACTORY })).toBe(60)
    expect(overspeedLimitFor('SALOON', { orgId: KASULU, ...NATIONAL })).toBe(100)
    expect(overspeedLimitFor('TRUCK',  { orgId: KASULU, ...NATIONAL })).toBe(40)
    // Without an org, as before
    expect(overspeedLimitFor('TRUCK')).toBe(80)
  })

  it('raises the live flag for an LMV at 70 in the factory but not at 90 on the road, and a truck at 50', () => {
    const frame = (speedKmh: number, at: { lat: number; lng: number }) => ({
      speedKmh, ...at, capturedAt: new Date(), fuelLevelMl: null, engineOn: true, ignitionKnown: true, flags: {},
    }) as never
    const ctx = (vehicleId: string, vehicleType: string) => ({ orgId: KASULU, vehicleId, tankCapacityMl: 0, vehicleType })
    let factory = {}, road = {}, truck = {}
    for (let i = 0; i < 3; i++) {
      factory = deriveAlertFlags(frame(70, IN_FACTORY), ctx('v-factory', 'SALOON'))
      road    = deriveAlertFlags(frame(90, NATIONAL), ctx('v-road', 'SALOON'))
      truck   = deriveAlertFlags(frame(50, NATIONAL), ctx('v-truck', 'TRUCK'))
    }
    expect(factory).toMatchObject({ overspeeding: true })
    expect(road).not.toHaveProperty('overspeeding')
    expect(truck).toMatchObject({ overspeeding: true })
  })

  it('replays each fix against the limit where it was', () => {
    const at = (t: number, spd: number, p: { lat: number; lng: number }) => ({ t, spd, hdg: 0, eng: true, lat: p.lat, lng: p.lng })
    const points = [
      at(1, 70, IN_FACTORY), at(2, 72, IN_FACTORY),  // over 60 in the factory
      at(3, 90, NATIONAL),   at(4, 95, NATIONAL),    // under 100 on the road
      at(5, 105, NATIONAL),  at(6, 110, NATIONAL),   // over 100
    ]
    const ev = deriveSpeeding(points, (p) => overspeedLimitFor('SALOON', { orgId: KASULU, lat: p.lat, lng: p.lng }))
    expect(ev.map(e => [e.t, e.endT, e.detail])).toEqual([
      [1, 2, 'peak 72 km/h, limit 60 km/h'],
      [5, 6, 'peak 110 km/h, limit 100 km/h'],
    ])
  })
})
