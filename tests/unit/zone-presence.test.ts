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
const { trackZonePresence, invalidateZoneCache } = await import('../../src/lib/zone-presence.js')

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
async function ping(vehicleId: string, lat: number, lng: number, atIso: string) {
  await trackZonePresence({
    orgId: 'org', vehicleId, plate: 'MUFINDI: EX 24', driverName: null, lat, lng, capturedAt: atIso,
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

  it('leads with the most specific feature and names what contains it', async () => {
    const v = `veh-nest-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    for (let i = 0; i < 6; i++) await ping(v, IN_SHOP.lat, IN_SHOP.lng, tick(2))

    const arrival = published.find(n => n.alertType === 'ZONE_ENTRY')
    // The vehicle sits exactly on the VES 143 centre, so the reference reads 0 m.
    expect(arrival?.text).toBe('MUFINDI: EX 24 arrived at Workshop A — inside FARM #215, near VES 143 (0 m).')
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
    expect(exit?.text).toBe('MUFINDI: EX 24 left Workshop A — now in FARM #215.')
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
    expect(breach?.text).toBe('RESTRICTED: MUFINDI: EX 24 entered DRAINS3 — a keep-out zone.')
  })

  it('does not repeat while the vehicle works along the drain', async () => {
    const v = `veh-breach2-${seq}`
    await ping(v, OUTSIDE.lat, OUTSIDE.lng, tick(0))
    for (let i = 0; i < 5; i++) await ping(v, -4.0, 30.05, tick(1))

    expect(published.filter(n => n.alertType === 'GEOFENCE_BREACH')).toHaveLength(1)
  })
})
