/**
 * Window governance and zone-timeline shaping for GET /vehicles/:id/track.
 *
 * The repository is mocked throughout: what is under test is the decision the
 * service makes about WHICH read to issue and how it labels the answer, not the
 * SQL. The SQL's cost is the thing that forced this split in the first place
 * and is documented with its measurements in telemetry.repository.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/modules/telemetry/telemetry.repository.js', () => ({
  findTrack:          vi.fn(),
  findSampledFixes:   vi.fn(),
  findZoneTimeline:   vi.fn(),
  vehicleExistsInOrg: vi.fn(),
  // The real one; the sampled path thins with it and the test wants real
  // distances rather than a stub that always agrees.
  metresBetween: (aLat: number, aLng: number, bLat: number, bLng: number) => {
    const R = 6371000, rad = Math.PI / 180
    const dLat = (bLat - aLat) * rad
    const dLng = (bLng - aLng) * rad * Math.cos(((aLat + bLat) / 2) * rad)
    return Math.sqrt(dLat * dLat + dLng * dLng) * R
  },
  findPings: vi.fn(), findLatest: vi.fn(),
  findActiveAlerts: vi.fn(), findAlertHistoryCounts: vi.fn(),
}))

import {
  findTrack, findSampledFixes, findZoneTimeline, vehicleExistsInOrg,
} from '../../src/modules/telemetry/telemetry.repository.js'
import { getVehicleTrack } from '../../src/modules/telemetry/telemetry.service.js'
import type { TrackQuery } from '../../src/modules/telemetry/telemetry.schema.js'

const VEH = 'veh_01'
const ORG = 'org_01'
const q = (over: Partial<TrackQuery> = {}): TrackQuery =>
  ({ minSpacingM: 15, zones: false, ...over }) as TrackQuery

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)

/**
 * A window `h` hours wide ending now, from ONE read of the clock.
 *
 * The pattern this replaces — `{ from: hoursAgo(h), to: new Date() }` — reads
 * the clock TWICE, so the window is h hours plus however long those two calls
 * were apart: normally zero, and occasionally a millisecond when the process is
 * descheduled between them.
 *
 * Harmless well inside the limits, and fatal on exactly one: the 30-day case
 * below asks for the MAXIMUM, the guard rejects strictly above it, and a single
 * millisecond turns a legal window into `Track window may not exceed 30 days
 * (asked for 30)`. It failed roughly one run in twenty, always that one test,
 * and only under load — which is what made it look like a flake in the harness
 * rather than a bug in the fixture.
 *
 * The guard is right: exactly 30 days is allowed. The fixture was asking for
 * slightly more than it claimed.
 */
const windowOf = (h: number) => {
  const to = new Date()
  return { from: new Date(to.getTime() - h * 3_600_000), to }
}

const FULL_TRACK = {
  resolution: 'full' as const,
  sampleBucketSec: null, samples: null,
  points: [{ t: 1, lat: -0.36, lng: 35.28 }],
  fixes: 1, truncated: false, firstAt: 1, lastAt: 1,
  engineOffSinceMs: null, engineOffRunsPastWindow: false,
}

beforeEach(() => {
  vi.mocked(findTrack).mockResolvedValue(FULL_TRACK)
  vi.mocked(vehicleExistsInOrg).mockResolvedValue(true)
})

describe('track window governance', () => {
  it('reads every fix for a short window', async () => {
    const res = await getVehicleTrack(VEH, ORG, q(windowOf(12)))

    expect(res.resolution).toBe('full')
    expect(findTrack).toHaveBeenCalled()
    expect(findSampledFixes).not.toHaveBeenCalled()
  })

  it('keeps the original cap-bounded behaviour when no `from` is given', async () => {
    await getVehicleTrack(VEH, ORG, q())

    // No window means no basis to choose sampling — the legacy path, unchanged.
    expect(findTrack).toHaveBeenCalled()
    expect(findSampledFixes).not.toHaveBeenCalled()
  })

  it('switches to sampling past the full-fidelity ceiling', async () => {
    vi.mocked(findSampledFixes).mockResolvedValue({ rows: [], bucketSec: 1728 })

    const res = await getVehicleTrack(VEH, ORG, q(windowOf(24 * 30)))

    expect(findSampledFixes).toHaveBeenCalled()
    expect(findTrack).not.toHaveBeenCalled()
    expect(res.resolution).toBe('sampled')
  })

  it('reports `fixes: null` when sampling, rather than passing off the sample count', async () => {
    vi.mocked(findSampledFixes).mockResolvedValue({
      rows: [
        { captured_at: new Date(1000), lat: -0.36, lng: 35.28, engine_on: true, gap_before: false },
      ],
      bucketSec: 600,
    })

    const res = await getVehicleTrack(VEH, ORG, q(windowOf(24 * 7)))

    // A client plotting `fixes` as "pings in this window" must not be handed a
    // number that means something else.
    expect(res.fixes).toBeNull()
    expect(res.samples).toBe(1)
    expect(res.sampleBucketSec).toBe(600)
  })

  it('refuses a window longer than the maximum instead of clamping it', async () => {
    await expect(
      getVehicleTrack(VEH, ORG, q(windowOf(24 * 45))),
    ).rejects.toThrow(/may not exceed 30 days/)

    expect(findSampledFixes).not.toHaveBeenCalled()
  })

  it('rejects an inverted window', async () => {
    await expect(
      getVehicleTrack(VEH, ORG, q({ from: new Date(), to: hoursAgo(5) })),
    ).rejects.toThrow(/must be earlier/)
  })

  it('504s the sampled read rather than hanging when Postgres cancels it', async () => {
    vi.mocked(findSampledFixes).mockResolvedValue(null)

    await expect(
      getVehicleTrack(VEH, ORG, q(windowOf(24 * 20))),
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  it('404s an unknown vehicle on the sampled path too', async () => {
    vi.mocked(vehicleExistsInOrg).mockResolvedValue(false)

    await expect(
      getVehicleTrack(VEH, ORG, q(windowOf(24 * 10))),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('keeps a thinned-away point when it is the first after a silence', async () => {
    // Three samples at the SAME coordinate: normally the 2nd and 3rd are thinned
    // as having travelled 0 m. The third follows an empty bucket, so dropping it
    // would erase the evidence that the unit went quiet.
    vi.mocked(findSampledFixes).mockResolvedValue({
      rows: [
        { captured_at: new Date(1000), lat: -0.36, lng: 35.28, engine_on: true, gap_before: false },
        { captured_at: new Date(2000), lat: -0.36, lng: 35.28, engine_on: true, gap_before: false },
        { captured_at: new Date(9000), lat: -0.36, lng: 35.28, engine_on: true, gap_before: true },
      ],
      bucketSec: 600,
    })

    const res = await getVehicleTrack(VEH, ORG, q(windowOf(24 * 5)))

    expect(res.points).toHaveLength(2)
    expect(res.points[1]).toMatchObject({ t: 9000, gapBefore: true })
  })
})

describe('zone timeline', () => {
  it('is not fetched unless asked for, and reads as null rather than empty', async () => {
    const res = await getVehicleTrack(VEH, ORG, q(windowOf(12)))

    expect(findZoneTimeline).not.toHaveBeenCalled()
    // Not `{ visits: [] }` — "nobody asked" and "visited nowhere" are different
    // claims and a client must not be able to confuse them.
    expect(res.zones).toBeNull()
  })

  it('marks a null zone as time spent outside every fence', async () => {
    vi.mocked(findZoneTimeline).mockResolvedValue({
      bucketSec: 60,
      rows: [
        { zone_id: 'z1', zone_name: 'FARM #215', zone_type: 'POLYGON', enforced: true,
          entered_at: new Date(1000), left_at: new Date(2000), samples: BigInt(4) },
        { zone_id: null, zone_name: null, zone_type: null, enforced: null,
          entered_at: new Date(3000), left_at: new Date(4000), samples: BigInt(2) },
      ],
    })

    const res = await getVehicleTrack(VEH, ORG, q({ ...windowOf(12), zones: true }))

    expect(res.zones?.visits).toEqual([
      { zoneId: 'z1', name: 'FARM #215', type: 'POLYGON', enforced: true,
        enteredAt: 1000, leftAt: 2000, samples: 4, outside: false },
      { zoneId: null, name: null, type: null, enforced: false,
        enteredAt: 3000, leftAt: 4000, samples: 2, outside: true },
    ])
    expect(res.zones?.bucketSec).toBe(60)
  })

  it('does not report an unenforced zone as enforced', async () => {
    // 99 of 107 fences are context only. A backtrack that implied a violation
    // the live map never raised would be worse than no backtrack.
    vi.mocked(findZoneTimeline).mockResolvedValue({
      bucketSec: 60,
      rows: [
        { zone_id: 'z2', zone_name: 'Wet land2', zone_type: 'POLYGON', enforced: false,
          entered_at: new Date(1000), left_at: new Date(2000), samples: BigInt(9) },
      ],
    })

    const res = await getVehicleTrack(VEH, ORG, q({ ...windowOf(12), zones: true }))

    expect(res.zones?.visits?.[0]).toMatchObject({ name: 'Wet land2', enforced: false })
  })

  it('still returns the track when the timeline times out', async () => {
    vi.mocked(findZoneTimeline).mockResolvedValue(null)

    const res = await getVehicleTrack(VEH, ORG, q({ ...windowOf(12), zones: true }))

    // The line is the thing the caller came for; the enrichment failing must
    // not take it down with it — but it must say so rather than look empty.
    expect(res.points).toHaveLength(1)
    expect(res.zones).toEqual({ timedOut: true, bucketSec: null, visits: null })
  })
})
