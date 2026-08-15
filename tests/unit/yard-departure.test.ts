import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(async () => undefined),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { publishNotification } from '../../src/lib/notifications/notification.store.js'
import { trackYardDeparture, trackYardArrival, invalidateYardCache, resetYardPresence } from '../../src/lib/yard-departure.js'
import { resetFixPlausibility } from '../../src/lib/fix-plausibility.js'

// SUKARI's real geometry: the hub sits 17 m from the gate, which is exactly why
// the old 800 m hub radius announced departures ~867 m past the barrier.
const HUB  = { lat: -0.8217694077015398, lng: 34.381997088730536 }
const GATE = { lat: -0.821842, lng: 34.381860 }
const GATE_RADIUS_M = 60

// Offsets due north of the gate — 1 degree of latitude is ~111,320 m here.
const north = (m: number) => ({ lat: GATE.lat + m / 111_320, lng: GATE.lng })
const AT_GATE = north(0)      // at the barrier
const IN_BAND = north(80)     // past the radius, inside the 40 m hysteresis band
const CLEAR   = north(150)    // through the band — departed, still well inside 800 m of the hub
const FAR     = north(1400)   // beyond the hub radius too

// Fixes 60 s apart, so every step below is physically plausible (150 m in 60 s
// is 9 km/h; 1,400 m in 60 s is 84 km/h, under the 120 km/h ceiling).
const T0 = Date.parse('2026-08-04T02:50:00.000Z')
let clock = T0

const input = (pos: { lat: number; lng: number }, stepMs = 60_000) => {
  clock += stepMs
  return {
    orgId: 'org_1', vehicleId: 'veh_1', plate: 'KTCC 870B',
    driverName: 'AUGUSTINE OWINO NYAMWOK',
    lat: pos.lat, lng: pos.lng, capturedAt: new Date(clock).toISOString(),
  }
}

const published = () =>
  (publishNotification as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls

const org = (over: Record<string, unknown> = {}) => ({
  hubLat: HUB.lat, hubLng: HUB.lng,
  gateLat: GATE.lat, gateLng: GATE.lng, gateRadiusM: GATE_RADIUS_M,
  ...over,
})

beforeEach(() => {
  invalidateYardCache()
  resetYardPresence()
  resetFixPlausibility()
  clock = T0
  vi.mocked(publishNotification).mockClear()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.organisation.findUnique as any).mockResolvedValue(org())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.dispatch.findFirst as any).mockResolvedValue({
    id: 'dsp_1', destination: 'kwoyo u k', dispatchedAt: new Date('2026-08-04T02:25:14.410Z'),
  })
})

describe('trackYardDeparture', () => {
  it('says nothing on the first frame, wherever the vehicle is', async () => {
    // A restart must not announce a departure for every vehicle already out.
    await trackYardDeparture(input(FAR))
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('publishes once when the vehicle clears the gate', async () => {
    await trackYardDeparture(input(AT_GATE))   // seed: at the barrier
    await trackYardDeparture(input(CLEAR))     // through it

    expect(published()).toHaveLength(1)
    const item = published()[0]![0]
    expect(item['text']).toBe(
      'KTCC 870B · AUGUSTINE OWINO NYAMWOK cleared the gate to kwoyo u k 27 min after sign-out.',
    )
    expect(item['alertType']).toBe('MOVEMENT_EXIT')
    expect(item['source']).toBe('telemetry')
  })

  it('fires 150 m out, not 800 m out — the whole point of the change', async () => {
    // CLEAR is 150 m from the gate and still ~140 m from the hub, so the old
    // hub-radius rule would not have said a word yet.
    await trackYardDeparture(input(AT_GATE))
    await trackYardDeparture(input(CLEAR))
    expect(published()).toHaveLength(1)
  })

  it('stays silent inside the hysteresis band', async () => {
    // 80 m out: past the gate radius but not committed to leaving. A truck
    // shunting at the barrier must not narrate a departure.
    await trackYardDeparture(input(AT_GATE))
    await trackYardDeparture(input(IN_BAND))
    await trackYardDeparture(input(AT_GATE))
    await trackYardDeparture(input(IN_BAND))
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('announces a dispatch once, however often the vehicle re-crosses', async () => {
    await trackYardDeparture(input(AT_GATE))
    await trackYardDeparture(input(CLEAR))
    await trackYardDeparture(input(AT_GATE))
    await trackYardDeparture(input(CLEAR))

    expect(published()).toHaveLength(1)
    expect(published()[0]![0]['id']).toBe('yd-dsp_1')
  })

  it('ignores a fix the vehicle could not physically have reached', async () => {
    // 1,400 m in two seconds is 2,520 km/h. Measured on the live account, 5.15%
    // of fixes in departure windows are like this, and three of them announced
    // departures that had not happened.
    await trackYardDeparture(input(AT_GATE))
    await trackYardDeparture(input(FAR, 2_000))
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('bounds the claim when the vehicle was never seen at the gate', async () => {
    // 9 of 54 replayed departures had no fix at the gate at all, behind
    // coverage gaps. We know it left — the sign-out said so — but we do not
    // know when it crossed, and the sentence must not imply a measured time.
    await trackYardDeparture(input(CLEAR))   // seed: already past the gate
    await trackYardDeparture(input(FAR))     // crosses the hub radius

    expect(published()).toHaveLength(1)
    expect(published()[0]![0]['text']).toBe(
      'KTCC 870B · AUGUSTINE OWINO NYAMWOK is clear of the yard to kwoyo u k — departure time not observed (no fix at the gate).',
    )
  })

  it('falls back to the yard radius for an organisation with no gate', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.organisation.findUnique as any).mockResolvedValue(
      org({ gateLat: null, gateLng: null, gateRadiusM: null }),
    )
    await trackYardDeparture(input(AT_GATE))
    await trackYardDeparture(input(CLEAR))
    expect(publishNotification).not.toHaveBeenCalled()   // 150 m is still "at the yard"

    await trackYardDeparture(input(FAR))
    expect(published()).toHaveLength(1)
    expect(published()[0]![0]['text']).toContain('cleared the yard')
  })

  it('does not call a vehicle with no open dispatch a departure', async () => {
    // Moving is not the same as going somewhere.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.dispatch.findFirst as any).mockResolvedValue(null)
    await trackYardDeparture(input(AT_GATE))
    await trackYardDeparture(input(CLEAR))
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('says nothing when the organisation has neither gate nor yard recorded', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.organisation.findUnique as any).mockResolvedValue(
      org({ hubLat: null, hubLng: null, gateLat: null, gateLng: null }),
    )
    await trackYardDeparture(input(AT_GATE))
    await trackYardDeparture(input(FAR))
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('ignores a frame with no fix', async () => {
    await trackYardDeparture({ ...input(AT_GATE), lat: null, lng: null })
    await trackYardDeparture(input(CLEAR))
    // The null frame was not a seed, so the first real frame only seeds.
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('omits the wait when the vehicle leaves promptly', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.dispatch.findFirst as any).mockResolvedValue({
      id: 'dsp_2', destination: 'OPAPO', dispatchedAt: new Date('2026-08-04T02:51:30.000Z'),
    })
    await trackYardDeparture(input(AT_GATE))
    await trackYardDeparture(input(CLEAR))
    expect(published()[0]![0]['text']).toBe('KTCC 870B · AUGUSTINE OWINO NYAMWOK cleared the gate to OPAPO.')
  })
})

/**
 * Arrivals. The mirror of the departure band — away, then back inside the gate
 * radius — and the half the provider cannot cover on its own.
 *
 * Both trackers run on the same frame from telemetry.worker, departure first,
 * because that pass is what seeds the shared per-vehicle state. The tests call
 * them in that order for the same reason.
 */
const frame = async (pos: { lat: number; lng: number }) => {
  const p = input(pos)
  await trackYardDeparture(p)
  await trackYardArrival(p)
}

describe('trackYardArrival', () => {
  it('says nothing on the first frame, even sitting at the gate', async () => {
    // A restart must not narrate an arrival for every unit already parked up.
    await frame(AT_GATE)
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('publishes when a unit that was away comes back inside the gate radius', async () => {
    await frame(FAR)        // seed: out on the road
    await frame(AT_GATE)    // home

    const arrivals = published().filter(c => c[0]!['alertType'] === 'MOVEMENT_ENTRY')
    expect(arrivals).toHaveLength(1)
    const item = arrivals[0]![0]
    expect(item['source']).toBe('telemetry')
    expect(item['severity']).toBe('success')
    expect(item['text']).toContain('arrived at the gate')
    expect(item['text']).toContain('from kwoyo u k')
  })

  it('does not narrate a unit that never left', async () => {
    // Parked at the barrier all shift: it crosses no threshold, so there is
    // nothing to report. This is the case the hysteresis band exists for.
    await frame(AT_GATE)
    await frame(AT_GATE)
    await frame(AT_GATE)
    expect(published().filter(c => c[0]!['alertType'] === 'MOVEMENT_ENTRY')).toHaveLength(0)
  })

  it('does not re-arm inside the hysteresis band', async () => {
    // Nosing out to 80 m and back is GPS jitter plus a barrier queue, not a
    // round trip. Re-arming on it would narrate a convoy of arrivals.
    await frame(AT_GATE)
    await frame(IN_BAND)
    await frame(AT_GATE)
    expect(published().filter(c => c[0]!['alertType'] === 'MOVEMENT_ENTRY')).toHaveLength(0)
  })

  it('arms again after a genuine departure, so a second trip is reported', async () => {
    await frame(FAR)
    await frame(AT_GATE)     // arrival 1
    await frame(FAR)         // out again, past the band
    await frame(AT_GATE)     // arrival 2

    expect(published().filter(c => c[0]!['alertType'] === 'MOVEMENT_ENTRY')).toHaveLength(2)
  })

  it('narrates a unit with no dispatch at all', async () => {
    // KTCC 505D's case: bound to a Wialon device, reporting, and unknown to
    // FactorySuite — zero dispatch rows. Requiring a dispatch here would
    // exclude precisely the units this exists to cover.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.dispatch.findFirst as any).mockResolvedValue(null)

    await frame(FAR)
    await frame(AT_GATE)

    const arrivals = published().filter(c => c[0]!['alertType'] === 'MOVEMENT_ENTRY')
    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]![0]['text']).toBe(
      'KTCC 870B · AUGUSTINE OWINO NYAMWOK arrived at the gate.',
    )
  })

  it('stays silent for an org with no gate recorded', async () => {
    // Kasulu today. There is deliberately no hub fallback: "came within 800 m
    // of the yard" is not an arrival, it is the coarse rule the gate replaced.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.organisation.findUnique as any).mockResolvedValue(org({ gateLat: null, gateLng: null }))
    invalidateYardCache()

    await frame(FAR)
    await frame(AT_GATE)

    expect(published().filter(c => c[0]!['alertType'] === 'MOVEMENT_ENTRY')).toHaveLength(0)
  })
})
