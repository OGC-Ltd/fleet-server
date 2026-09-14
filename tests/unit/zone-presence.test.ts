import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The Live Feed's whole narrative for a GPS-only org is zone crossings, so what
 * it says — and how often — is the product.
 *
 * Geometry below is synthetic but shaped like Kasulu's: a large farm polygon
 * with a smaller workshop inside it, a VES sample circle laid over both, and a
 * keep-out drain corridor.
 */
const published: Array<{ severity: string; alertType: string; text: string }> = []
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: (n: { severity: string; alertType: string; text: string }) => { published.push(n) },
}))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: { geofence: { findMany: vi.fn() }, vehicleGeofence: { findMany: vi.fn() } } }))

const { prisma } = await import('../../src/lib/prisma.js')
const { trackZonePresence, invalidateZoneCache, assignedZoneStatus } = await import('../../src/lib/zone-presence.js')

// A 0.1° box is ~11 km; the workshop is a 0.01° box inside its south-west corner.
const ring = (lat: number, lng: number, size: number): [number, number][] =>
  [[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]

const ZONES = [
  { id: 'farm',     name: 'FARM #215',  type: 'POLYGON', mode: 'BLOCKLIST', isActive: false,
    centerLat: null, centerLng: null, radiusM: null, widthM: null, polygonCoords: ring(-4, 30, 0.1) },
  { id: 'workshop', name: 'Workshop A', type: 'POLYGON', mode: 'BLOCKLIST', isActive: false,
    centerLat: null, centerLng: null, radiusM: null, widthM: null, polygonCoords: ring(-4, 30, 0.01) },
  { id: 'ves',      name: 'VES 143',    type: 'CIRCLE',  mode: 'BLOCKLIST', isActive: false,
    centerLat: -3.995, centerLng: 30.005, radiusM: 1000, widthM: null, polygonCoords: null },
  { id: 'drain',    name: 'DRAINS3',    type: 'LINE',    mode: 'BLOCKLIST', isActive: true,
    centerLat: null, centerLng: null, radiusM: null, widthM: 40,
    polygonCoords: [[30.05, -4.05], [30.05, -3.95]] as [number, number][] },
]

const MIN = 60_000
let clock = Date.UTC(2026, 7, 2, 6, 0, 0)
const tick = (mins: number) => { clock += mins * MIN; return new Date(clock).toISOString() }

let seq = 0
async function ping(vehicleId: string, lat: number, lng: number, atIso: string, orgId = 'org') {
  await trackZonePresence({
    orgId, vehicleId, plate: 'MUFINDI: EX 24', driverName: null, lat, lng, capturedAt: atIso,
  })
}

beforeEach(() => {
  published.length = 0
  seq++
  invalidateZoneCache()
  ;(prisma.geofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(ZONES)
  ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
})

const OUTSIDE = { lat: -4.5, lng: 29.5 }   // well clear of everything
const IN_FARM = { lat: -3.95, lng: 30.05 } // inside FARM #215 only
const IN_SHOP = { lat: -3.995, lng: 30.005 } // inside Workshop A, FARM #215 AND the VES circle

describe('the Live Feed names our overlay, not the provider', () => {
  it('never says a vehicle ARRIVED AT a VES circle, even standing in one', async () => {
    const v = `veh-ves-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    for (let i = 0; i < 6; i++) await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(2))

    expect(published.length).toBeGreaterThan(0)
    for (const n of published) {
      // A VES may only ever appear as the trailing cross-reference.
      expect(n.text).not.toMatch(/(arrived at|left|entered) VES/)
      const ves = n.text.indexOf('VES')
      if (ves >= 0) expect(n.text.slice(ves - 7, ves)).toBe(', near ')
    }
  })

  it('leads with the most specific feature, and says nothing about what contains it', async () => {
    const v = `veh-nest-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    for (let i = 0; i < 6; i++) await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(2))

    const arrival = published.find(n => n.alertType === 'ZONE_ENTRY')
    // The containing feature used to ride along as "— inside FARM #215", and
    // was dropped on 2026-09-15: the features nest, so the container is often
    // the contained one said again, and the map is drawing all of it anyway.
    // The vehicle sits exactly on the VES 143 centre, so the reference reads 0 m.
    expect(arrival?.text).toBe('MUFINDI: EX 24 arrived at Workshop A, near VES 143 (0 m).')
    expect(arrival?.text).not.toMatch(/inside/)
  })

  it('quotes the sample point in metres up close and kilometres further out', async () => {
    const v = `veh-dist-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    // ~0.004° north of the VES 143 centre — about 450 m, still inside the shop.
    for (let i = 0; i < 6; i++) await ping(v, IN_SHOP.lat + 0.004, IN_SHOP.lng, tick(2))

    const arrival = published.find(n => n.alertType === 'ZONE_ENTRY')
    expect(arrival?.text).toMatch(/near VES 143 \(4[0-9]0 m\)\.$/)
  })

  it('omits the reference entirely when no sample point is near', async () => {
    const v = `veh-far-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    for (let i = 0; i < 6; i++) await ping(v, IN_FARM.lat, IN_FARM.lng, tick(2))

    const arrival = published.find(n => n.alertType === 'ZONE_ENTRY')
    expect(arrival?.text).toBe('MUFINDI: EX 24 arrived at FARM #215.')
  })

  it('reports one crossing once, not once per nested zone', async () => {
    const v = `veh-once-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    for (let i = 0; i < 6; i++) await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(2))

    // Entering the workshop means entering FARM #215 and the VES circle too.
    // That is ONE event.
    expect(published.filter(n => n.alertType === 'ZONE_ENTRY')).toHaveLength(1)
  })

  it('says where the vehicle ended up when it leaves', async () => {
    const v = `veh-exit-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    for (let i = 0; i < 4; i++) await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(2))
    published.length = 0
    for (let i = 0; i < 4; i++) await ping(v, IN_FARM.lat, IN_FARM.lng, tick(2))

    const exit = published.find(n => n.alertType === 'ZONE_EXIT')
    expect(exit?.text).toBe('MUFINDI: EX 24 left Workshop A and is now in FARM #215.')
  })
})

describe('dwell — a boundary is not an event', () => {
  it('ignores a vehicle that clips a corner and carries on', async () => {
    const v = `veh-clip-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(1))   // inside for one minute
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(1))   // and gone again
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(5))

    expect(published.filter(n => n.alertType === 'ZONE_ENTRY')).toHaveLength(0)
  })

  it('still reports an arrival that holds', async () => {
    const v = `veh-hold-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(1))
    await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(4))   // past the 3-minute dwell

    expect(published.filter(n => n.alertType === 'ZONE_ENTRY')).toHaveLength(1)
  })
})

describe('a keep-out breach is not delayed and not folded in', () => {
  it('fires on the frame it happens, before any dwell elapses', async () => {
    const v = `veh-breach-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    await ping(v, -4.0, 30.05, tick(1))   // on the drain centre-line, one minute in

    const breach = published.find(n => n.alertType === 'GEOFENCE_BREACH')
    expect(breach?.severity).toBe('critical')
    expect(breach?.text).toBe('RESTRICTED: MUFINDI: EX 24 entered DRAINS3, a restricted zone.')
  })

  it('does not repeat while the vehicle works along the drain', async () => {
    const v = `veh-breach2-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    for (let i = 0; i < 5; i++) await ping(v, -4.0, 30.05, tick(1))

    expect(published.filter(n => n.alertType === 'GEOFENCE_BREACH')).toHaveLength(1)
  })
})


/**
 * Containment, which is NOT the same question as accountability.
 *
 * This is where the field went wrong in production. `assignedZoneStatus` used
 * to filter `inside` down to the vehicle's ASSIGNED zones, so on a fleet bound
 * to water infrastructure only — which is the one keep-out policy anyone ever
 * agreed — every farm, workshop and yard a machine was standing in reported as
 * nothing at all. Measured on Mufindi 2026-09-07: 107 fences, 210 evaluated
 * vehicles, `inside: []` for all of them, while the same geometry put 195 of
 * them inside a named zone.
 */
describe('assignedZoneStatus — containment is not accountability', () => {
  it('reports EVERY containing zone, not just the assigned ones', async () => {
    // The regression, in one assertion. The drain binding is what used to make
    // the farm, the workshop and the VES circle vanish from the answer.
    ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { vehicleId: `veh-contain-${seq}`, geofenceId: 'drain' },
    ])
    const v = `veh-contain-${seq}`
    await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(0))

    const status = assignedZoneStatus('org', v)
    expect(status.known).toBe(true)
    expect(status.inside.map(z => z.id).sort()).toEqual(['farm', 'ves', 'workshop'])
  })

  it('marks which of them the vehicle is actually accountable to', async () => {
    ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { vehicleId: `veh-acct-${seq}`, geofenceId: 'workshop' },
    ])
    const v = `veh-acct-${seq}`
    await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(0))

    const byId = Object.fromEntries(assignedZoneStatus('org', v).inside.map(z => [z.id, z]))
    expect(byId.workshop!.assigned).toBe(true)
    expect(byId.farm!.assigned).toBe(false)
    expect(byId.ves!.assigned).toBe(false)
  })

  it('treats a vehicle with no bindings at all as accountable to everything', async () => {
    // Preserves the previous behaviour exactly: the old code skipped the filter
    // when the vehicle had no assignment rows.
    ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const v = `veh-unbound-${seq}`
    await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(0))

    expect(assignedZoneStatus('org', v).inside.every(z => z.assigned)).toBe(true)
  })

  it('is not known until a fix has been seen', () => {
    expect(assignedZoneStatus('org', `veh-never-${seq}`)).toEqual({ inside: [], breach: false, known: false })
  })
})

describe('assignedZoneStatus — breach keeps its old meaning', () => {
  it('raises on an enforced zone the vehicle is bound to', async () => {
    ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { vehicleId: `veh-b1-${seq}`, geofenceId: 'drain' },
    ])
    const v = `veh-b1-${seq}`
    await ping(v, -4.0, 30.05, tick(0))          // on the drain centre-line

    const status = assignedZoneStatus('org', v)
    expect(status.inside.find(z => z.id === 'drain')?.enforced).toBe(true)
    expect(status.breach).toBe(true)
  })

  it('does NOT raise on an enforced zone the vehicle is not bound to', async () => {
    // The drain still appears in `inside` — it is a fact about where the unit
    // is — but nobody made this vehicle answer for it, so it is not a breach.
    ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { vehicleId: `veh-b2-${seq}`, geofenceId: 'workshop' },
    ])
    const v = `veh-b2-${seq}`
    await ping(v, -4.0, 30.05, tick(0))

    const status = assignedZoneStatus('org', v)
    expect(status.inside.some(z => z.id === 'drain')).toBe(true)
    expect(status.breach).toBe(false)
  })

  it('does not raise on unenforced zones, however many are containing', async () => {
    ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const v = `veh-b3-${seq}`
    await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(0))

    const status = assignedZoneStatus('org', v)
    expect(status.inside).toHaveLength(3)
    expect(status.breach).toBe(false)
  })
})

describe('the assignment cache is per-ORG', () => {
  it('does not answer one org from the bindings of another', async () => {
    // The cache was one flat map with a single freshness stamp: the first org
    // to poll filled it and every other org read its own vehicles out of a map
    // that never held them, so a bound vehicle looked unbound — and answered
    // for every zone instead of its own.
    const a = `veh-orgA-${seq}`
    const b = `veh-orgB-${seq}`

    ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { vehicleId: a, geofenceId: 'workshop' },
    ])
    await ping(a, IN_SHOP.lat, IN_SHOP.lng, tick(0), 'orgA')

    ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { vehicleId: b, geofenceId: 'drain' },
    ])
    await ping(b, IN_SHOP.lat, IN_SHOP.lng, tick(0), 'orgB')

    // B is bound to the drain only, so nothing it is standing in is assigned.
    const byIdB = Object.fromEntries(assignedZoneStatus('orgB', b).inside.map(z => [z.id, z]))
    expect(byIdB.workshop!.assigned).toBe(false)

    // A is bound to the workshop, and A's own answer is unchanged by B's load.
    const byIdA = Object.fromEntries(assignedZoneStatus('orgA', a).inside.map(z => [z.id, z]))
    expect(byIdA.workshop!.assigned).toBe(true)
    expect(byIdA.farm!.assigned).toBe(false)
  })
})
