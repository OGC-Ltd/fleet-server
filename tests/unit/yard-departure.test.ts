import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(async () => undefined),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { publishNotification } from '../../src/lib/notifications/notification.store.js'
import { trackYardDeparture, invalidateYardCache, resetYardPresence } from '../../src/lib/yard-departure.js'

// SUKARI's hub, and a point ~1.4 km away — comfortably outside YARD_RADIUS_M.
const YARD    = { lat: -0.8223, lng: 34.3850 }
const OUTSIDE = { lat: -0.8350, lng: 34.3850 }
const INSIDE  = { lat: -0.8226, lng: 34.3853 }   // ~40 m out, i.e. still in the compound

const AT = '2026-08-04T02:50:00.000Z'

const input = (pos: { lat: number; lng: number }, at = AT) => ({
  orgId: 'org_1', vehicleId: 'veh_1', plate: 'KTCC 870B',
  driverName: 'AUGUSTINE OWINO NYAMWOK',
  lat: pos.lat, lng: pos.lng, capturedAt: at,
})

const published = () =>
  (publishNotification as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls

beforeEach(() => {
  invalidateYardCache()
  resetYardPresence()
  vi.mocked(publishNotification).mockClear()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.organisation.findUnique as any).mockResolvedValue({ hubLat: YARD.lat, hubLng: YARD.lng })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.dispatch.findFirst as any).mockResolvedValue({
    id: 'dsp_1', destination: 'kwoyo u k', dispatchedAt: new Date('2026-08-04T02:25:14.410Z'),
  })
})

describe('trackYardDeparture', () => {
  it('says nothing on the first frame, wherever the vehicle is', async () => {
    // A restart must not announce a departure for every vehicle already out.
    await trackYardDeparture(input(OUTSIDE))
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('publishes once when the vehicle crosses out of the yard', async () => {
    await trackYardDeparture(input(INSIDE))    // seed: in the compound
    await trackYardDeparture(input(OUTSIDE))   // crossed

    expect(published()).toHaveLength(1)
    const item = published()[0]![0]
    expect(item['text']).toBe(
      'KTCC 870B · AUGUSTINE OWINO NYAMWOK left the yard to kwoyo u k 25 min after dispatch.',
    )
    // The wait is the whole point: the provider's version fired at zero.
    expect(item['alertType']).toBe('MOVEMENT_EXIT')
    expect(item['source']).toBe('telemetry')
  })

  it('stays silent while the vehicle is still in the compound', async () => {
    // KTCC 870B's real case: 440 m from where it was dispatched, 16 km/h peak,
    // and the old feed had already called it a departure.
    await trackYardDeparture(input(INSIDE))
    await trackYardDeparture(input(INSIDE))
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('keys on the dispatch, so noise on the boundary cannot narrate a convoy', async () => {
    await trackYardDeparture(input(INSIDE))
    await trackYardDeparture(input(OUTSIDE))
    await trackYardDeparture(input(INSIDE))
    await trackYardDeparture(input(OUTSIDE))

    const ids = published().map(c => c[0]['id'])
    expect(ids).toEqual(['yd-dsp_1', 'yd-dsp_1'])   // one row, upserted
  })

  it('does not call a vehicle with no open dispatch a departure', async () => {
    // Moving is not the same as going somewhere.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.dispatch.findFirst as any).mockResolvedValue(null)
    await trackYardDeparture(input(INSIDE))
    await trackYardDeparture(input(OUTSIDE))
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('says nothing when the organisation has no yard recorded', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.organisation.findUnique as any).mockResolvedValue({ hubLat: null, hubLng: null })
    await trackYardDeparture(input(INSIDE))
    await trackYardDeparture(input(OUTSIDE))
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('ignores a frame with no fix', async () => {
    await trackYardDeparture({ ...input(INSIDE), lat: null, lng: null })
    await trackYardDeparture(input(OUTSIDE))
    // The null frame was not a seed, so the first real frame only seeds.
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it('omits the wait when the vehicle leaves promptly', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.dispatch.findFirst as any).mockResolvedValue({
      id: 'dsp_2', destination: 'OPAPO', dispatchedAt: new Date('2026-08-04T02:49:40.000Z'),
    })
    await trackYardDeparture(input(INSIDE))
    await trackYardDeparture(input(OUTSIDE))
    expect(published()[0]![0]['text']).toBe('KTCC 870B · AUGUSTINE OWINO NYAMWOK left the yard to OPAPO.')
  })
})
