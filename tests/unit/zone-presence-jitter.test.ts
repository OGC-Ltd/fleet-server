import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A parked machine cannot cross a fence.
 *
 * Measured over 12 hours of live crossings: 277 of 2,319 (11.9%) fired while
 * the vehicle's own telemetry reported a top speed of exactly 0 km/h across a
 * four-minute window. That is GPS drift on a unit standing near a boundary, and
 * it defeats DWELL_MS because drift is PERSISTENT — it holds the wrong side for
 * minutes, which is the very condition the dwell was built to trust.
 *
 * The other 86.8% were moving at 5 km/h or more and are real: these are field
 * tractors working field boundaries and they genuinely do cross all day. So the
 * gate has to remove the drift without touching them, and the two cases that
 * must not break are a unit that parks the moment it arrives and a provider
 * that sends no speed at all.
 */
const published: Array<{ alertType: string; text: string }> = []
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: (n: { alertType: string; text: string }) => { published.push(n) },
}))
vi.mock('../../src/lib/prisma.js', () => ({
  prisma: { geofence: { findMany: vi.fn() }, vehicleGeofence: { findMany: vi.fn() } },
}))

const { prisma } = await import('../../src/lib/prisma.js')
const { trackZonePresence, invalidateZoneCache } = await import('../../src/lib/zone-presence.js')

const ring = (lat: number, lng: number, size: number): [number, number][] =>
  [[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]

const ZONES = [
  { id: 'farm', name: 'FARM #215', type: 'POLYGON', mode: 'BLOCKLIST', isActive: false,
    centerLat: null, centerLng: null, radiusM: null, widthM: null, polygonCoords: ring(-4, 30, 0.1) },
]

const MIN = 60_000
let clock = Date.UTC(2026, 7, 19, 6, 0, 0)
const tick = (mins: number) => { clock += mins * MIN; return new Date(clock).toISOString() }

const OUTSIDE = { lat: -4.5, lng: 29.5 }
const IN_FARM = { lat: -3.95, lng: 30.05 }

let vehicleSeq = 0
beforeEach(() => {
  published.length = 0
  clock += 60 * MIN            // clear of the previous test's cooldown window
  vehicleSeq++                 // a fresh unit, so no presence state carries over
  invalidateZoneCache()
  ;(prisma.geofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(ZONES)
  ;(prisma.vehicleGeofence.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])
})

/** Feed frames to one vehicle and return how many feed items came out. */
async function feed(frames: Array<{ pos: { lat: number; lng: number }; after: number; speedKmh?: number | null }>) {
  const vehicleId = `v${vehicleSeq}`
  for (const f of frames) {
    await trackZonePresence({
      orgId: 'org', vehicleId, plate: 'MUFINDI: FT 11', driverName: null,
      lat: f.pos.lat, lng: f.pos.lng, capturedAt: tick(f.after), speedKmh: f.speedKmh,
    })
  }
  return published.length
}

describe('zone crossings require movement', () => {
  it('stays silent when a stationary unit drifts across the line', async () => {
    // Never moves. Every frame reads 0 and the drift outlasts the three-minute
    // dwell, which is exactly how this survived the debounce in production.
    expect(await feed([
      { pos: OUTSIDE, after: 0,  speedKmh: 0 },
      { pos: IN_FARM, after: 5,  speedKmh: 0 },
      { pos: IN_FARM, after: 5,  speedKmh: 0 },
      { pos: IN_FARM, after: 5,  speedKmh: 0 },
    ])).toBe(0)
  })

  it('still announces a unit that drove in', async () => {
    expect(await feed([
      { pos: OUTSIDE, after: 0, speedKmh: 12 },
      { pos: IN_FARM, after: 5, speedKmh: 14 },
      { pos: IN_FARM, after: 5, speedKmh: 11 },
    ])).toBeGreaterThan(0)
  })

  it('announces a unit that arrives and parks immediately', async () => {
    // The case the grace window exists for: moving a minute ago, and every
    // confirming frame reads zero because it has already stopped.
    expect(await feed([
      { pos: OUTSIDE, after: 0, speedKmh: 20 },
      { pos: IN_FARM, after: 2, speedKmh: 0 },
      { pos: IN_FARM, after: 2, speedKmh: 0 },
      { pos: IN_FARM, after: 2, speedKmh: 0 },
    ])).toBeGreaterThan(0)
  })

  it('announces a sparse reporter that parked on arrival', async () => {
    // p99 frame gap is 905 s, so a real arrival can be confirmed a quarter of
    // an hour after the last moving frame. A flat five-minute grace silenced
    // this; tying it to the dwell does not.
    expect(await feed([
      { pos: OUTSIDE, after: 0, speedKmh: 18 },
      { pos: IN_FARM, after: 4, speedKmh: 0 },
      { pos: IN_FARM, after: 4, speedKmh: 0 },
    ])).toBeGreaterThan(0)
  })

  it('trusts the crossing when the provider sends no speed', async () => {
    // An absent reading is not evidence of stillness. Failing open keeps a
    // thin-frame provider narrating exactly as it did before.
    expect(await feed([
      { pos: OUTSIDE, after: 0, speedKmh: null },
      { pos: IN_FARM, after: 5, speedKmh: null },
      { pos: IN_FARM, after: 5, speedKmh: null },
    ])).toBeGreaterThan(0)
  })
})
