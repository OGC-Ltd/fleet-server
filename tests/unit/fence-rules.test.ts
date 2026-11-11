import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Geofence rules (lib/fence-rules, lib/fence-rule-watch), driven through
 * trackZonePresence as live frames drive them: a tanker crossing a no-go road
 * raises one no-go alert, staying inside or flicking on the edge raises no
 * more, and a unit the rule does not cover raises none.
 */
const published: Array<{ alertType: string; text: string; severity: string; vehicleId: string }> = []
const pushed: Array<{ title: string; body: string }> = []
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: (n: { alertType: string; text: string; severity: string; vehicleId: string }) => { published.push(n) },
}))
vi.mock('../../src/modules/notifications/notifications.service.js', () => ({
  pushService: { broadcastToOrg: async (_org: string, p: { title: string; body: string }) => { pushed.push(p) } },
}))
vi.mock('../../src/lib/redis.js', () => ({ getCacheRedis: () => null }))
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { geofence: { findMany: vi.fn() }, vehicleGeofence: { findMany: vi.fn() }, vehicle: { findMany: vi.fn() } },
}))

const { prisma } = await import('../../src/lib/prisma.js')
const { trackZonePresence, invalidateZoneCache } = await import('../../src/lib/zone-presence.js')
const { __resetFenceRuleWatch, EXIT_GRACE_MS } = await import('../../src/lib/fence-rule-watch.js')
const { ruleWords, ruleActiveAt, fenceRuleSchema } = await import('../../src/lib/fence-rules.js')

const rule = (r: Record<string, unknown>) => fenceRuleSchema.parse(r)

// A no-go road: a corridor 40 m wide along the equator from lng 36.00 to 36.10.
const ROAD = {
  id: 'road', name: 'Tanker no-go road', type: 'LINE', mode: 'ALLOWLIST', isActive: true, purpose: 'restricted',
  centerLat: null, centerLng: null, radiusM: null, widthM: 40, polygonCoords: [[36.0, 0], [36.1, 0]],
  rule: { trigger: 'enter', vehicleTypes: ['TANKER'], fleets: [], vehicleIds: [], hours: null, alert: { type: 'nogo', severity: 'critical' } },
}

const OFF = { lat: 0.01, lng: 36.05 }        // ~1.1 km off the road
const ON = { lat: 0, lng: 36.05 }
const EDGE_OUT = { lat: 0.0003, lng: 36.05 } // ~33 m from the centre-line: just outside a 40 m road

const MIN = 60_000
let clock = Date.UTC(2026, 10, 11, 6, 0, 0)
let seq = 0
const VEHICLES = [
  { id: 'tanker', vehicleType: 'Tanker' },   // case does not matter
  { id: 'lorry', vehicleType: 'LORRY' },
]

beforeEach(() => {
  published.length = 0
  pushed.length = 0
  clock += 120 * MIN
  seq++
  invalidateZoneCache()
  __resetFenceRuleWatch()
  ;(prisma.geofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ROAD])
  ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
  ;(prisma.vehicle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(VEHICLES.map((v) => ({ ...v, id: `${v.id}${seq}` })))
})

async function drive(vehicle: 'tanker' | 'lorry', frames: Array<{ pos: { lat: number; lng: number }; after: number; speedKmh?: number }>) {
  for (const f of frames) {
    clock += f.after * MIN
    await trackZonePresence({
      orgId: 'org', vehicleId: `${vehicle}${seq}`, plate: vehicle === 'tanker' ? 'KCT 507W' : 'KBT 112R', driverName: null,
      lat: f.pos.lat, lng: f.pos.lng, capturedAt: new Date(clock).toISOString(), speedKmh: f.speedKmh ?? 40,
    })
  }
  return published.filter((n) => n.alertType === 'NOGO_ZONE')
}

describe('a geofence rule on live frames', () => {
  it('raises one no-go alert when a tanker drives onto the road', async () => {
    const alerts = await drive('tanker', [
      { pos: OFF, after: 0 },
      { pos: ON, after: 1 },
    ])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.severity).toBe('critical')
    expect(alerts[0]!.text).toBe('KCT 507W entered Tanker no-go road, a no-go zone for TANKER units.')
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.title).toBe('No-go zone — KCT 507W')
  })

  it('does not repeat while the tanker stays inside', async () => {
    expect(await drive('tanker', [
      { pos: OFF, after: 0 },
      { pos: ON, after: 1 },
      ...Array.from({ length: 30 }, () => ({ pos: ON, after: 1 })),
    ])).toHaveLength(1)
  })

  it('does not repeat when the tanker flicks over the edge on GPS noise', async () => {
    expect(await drive('tanker', [
      { pos: OFF, after: 0 },
      { pos: ON, after: 1 },
      { pos: EDGE_OUT, after: 0.5 },
      { pos: ON, after: 0.5 },
      { pos: EDGE_OUT, after: 1 },
      { pos: ON, after: 1 },
    ])).toHaveLength(1)
  })

  it('alerts again on a new visit, once it has been off the road a while', async () => {
    expect(await drive('tanker', [
      { pos: OFF, after: 0 },
      { pos: ON, after: 1 },
      { pos: OFF, after: 1 },
      { pos: OFF, after: EXIT_GRACE_MS / MIN + 1 },
      { pos: ON, after: 1 },
    ])).toHaveLength(2)
  })

  it('raises nothing for a unit the rule does not cover', async () => {
    expect(await drive('lorry', [
      { pos: OFF, after: 0 },
      { pos: ON, after: 1 },
      { pos: ON, after: 1 },
    ])).toHaveLength(0)
  })

  it('does not call a tanker first seen already on the road an entry', async () => {
    expect(await drive('tanker', [
      { pos: ON, after: 0 },
      { pos: ON, after: 1 },
    ])).toHaveLength(0)
  })

  it('does not take a parked tanker drifting onto the road for an entry', async () => {
    expect(await drive('tanker', [
      { pos: OFF, after: 0, speedKmh: 0 },
      { pos: ON, after: 60, speedKmh: 0 },
    ])).toHaveLength(0)
  })

  it('raises nothing outside the rule\'s hours', async () => {
    // An hour that starts six hours from now on the fleet clock
    const h = String(new Date(clock + 9 * 3_600_000).getUTCHours()).padStart(2, '0')
    ;(prisma.geofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...ROAD, rule: { ...ROAD.rule, hours: { from: `${h}:00`, to: `${h}:59` } } },
    ])
    expect(await drive('tanker', [
      { pos: OFF, after: 0 },
      { pos: ON, after: 1 },
    ])).toHaveLength(0)
  })

  it('an `inside` rule alerts a unit already standing there, once', async () => {
    ;(prisma.geofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...ROAD, rule: { ...ROAD.rule, trigger: 'inside' } },
    ])
    const alerts = await drive('tanker', [
      { pos: ON, after: 0 },
      { pos: ON, after: 1 },
      { pos: ON, after: 1 },
    ])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.text).toBe('KCT 507W is inside Tanker no-go road, a no-go zone for TANKER units.')
  })

  it('applies to units listed by id (a fleet picked on the form)', async () => {
    ;(prisma.geofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...ROAD, rule: { ...ROAD.rule, vehicleTypes: [], fleets: ['Tankers'], vehicleIds: [`lorry${seq}`] } },
    ])
    const alerts = await drive('lorry', [{ pos: OFF, after: 0 }, { pos: ON, after: 1 }])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.text).toContain('a no-go zone for Tankers')
  })

  it('applies to units picked one by one, and names them', async () => {
    ;(prisma.geofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...ROAD, rule: { ...ROAD.rule, vehicleTypes: [], units: [{ id: `lorry${seq}`, plate: 'KBT 112R' }] } },
    ])
    const alerts = await drive('lorry', [{ pos: OFF, after: 0 }, { pos: ON, after: 1 }])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.text).toBe('KBT 112R entered Tanker no-go road, a no-go zone for KBT 112R.')
    expect(await drive('tanker', [{ pos: OFF, after: 0 }, { pos: ON, after: 1 }])).toHaveLength(1)   // still only the lorry's
  })

  it('ignores a rule on an inactive fence', async () => {
    ;(prisma.geofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...ROAD, isActive: false }])
    expect(await drive('tanker', [{ pos: OFF, after: 0 }, { pos: ON, after: 1 }])).toHaveLength(0)
  })

  it('replaces the keep-out breach on a BLOCKLIST fence that has a rule', async () => {
    ;(prisma.geofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...ROAD, mode: 'BLOCKLIST' }])
    await drive('tanker', [{ pos: OFF, after: 0 }, { pos: ON, after: 1 }])
    expect(published.map((n) => n.alertType)).toEqual(['NOGO_ZONE'])
  })
})

describe('the rule in words', () => {
  it('says who, what and the alert', () => {
    expect(ruleWords(rule({ vehicleTypes: [], fleets: ['Tankers'], vehicleIds: ['a'] })))
      .toBe('Tankers must not enter. Raise a no-go alert.')
    expect(ruleWords(rule({ trigger: 'inside', vehicleTypes: ['tanker', 'lorry'], hours: { from: '18:00', to: '06:00' }, alert: { severity: 'warning' } })))
      .toBe('TANKER units and LORRY units must not be inside between 18:00 and 06:00. Raise a no-go alert (warning).')
    expect(ruleWords(rule({}))).toBe('No unit may enter. Raise a no-go alert.')
    const u = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, plate: `KCT 50${i}W` }))
    expect(ruleWords(rule({ fleets: ['Tankers'], vehicleIds: ['x'], units: u(2) })))
      .toBe('Tankers, KCT 500W and KCT 501W must not enter. Raise a no-go alert.')
    expect(ruleWords(rule({ units: u(4) }))).toBe('4 chosen units must not enter. Raise a no-go alert.')
  })

  it('reads hours on the fleet clock, overnight included', () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 10, 11, h - 3, m)   // Nairobi h:m
    const night = { hours: { from: '18:00', to: '06:00' } }
    expect(ruleActiveAt(night, at(20))).toBe(true)
    expect(ruleActiveAt(night, at(5, 59))).toBe(true)
    expect(ruleActiveAt(night, at(6))).toBe(false)
    expect(ruleActiveAt(night, at(12))).toBe(false)
    expect(ruleActiveAt({ hours: { from: '08:00', to: '17:00' } }, at(9))).toBe(true)
    expect(ruleActiveAt({ hours: null }, at(3))).toBe(true)
  })

  it('refuses a rule whose hours are empty', () => {
    expect(fenceRuleSchema.safeParse({ hours: { from: '06:00', to: '06:00' } }).success).toBe(false)
    expect(fenceRuleSchema.safeParse({ hours: { from: '6:00', to: '18:00' } }).success).toBe(false)
  })
})
