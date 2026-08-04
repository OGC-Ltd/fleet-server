/**
 * The provider's MOVEMENT/EXIT is paperwork, not a gate crossing.
 *
 * Measured over seven days on the live account: 281 of 283 dispatches were
 * followed by their EXIT event within one second — median 9 ms, p90 13 ms. It
 * is emitted inside the dispatch transaction, so narrating it announced a
 * departure at the instant the paperwork was raised.
 *
 * On 2026-08-04 the feed carried "KTCC 870B · AUGUSTINE OWINO NYAMWOK left the
 * yard to kwoyo u k" at 05:25:14.429, 19 ms after the dispatch, while the truck
 * stood in the compound — twenty-five minutes later it had moved 440 m at a
 * peak of 16 km/h. The Active Trip card said "not yet left the yard" and was
 * right, so the two surfaces contradicted each other in front of the operator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/event-bus.js', () => ({ eventBus: { publish: vi.fn() } }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { eventBus } from '../../src/lib/event-bus.js'
import { handleMovement } from '../../src/modules/webhooks/raifactorysuite-events.service.js'

const DISPATCHED_AT = new Date('2026-08-04T02:25:14.410Z')

const movement = (over: Record<string, unknown> = {}) => ({
  id:                'ae3961d9-56f2-40a5-8ee0-c4f8ba4589cf',
  // The provider's factory code for SUKARI — see FACTORY_TO_ORG.
  factoryCode:       'NDHIWA',
  vehicleNumberPlate: 'KTCC 870B',
  driverName:        'AUGUSTINE OWINO NYAMWOK',
  destination:       'kwoyo u k',
  direction:         'EXIT',
  // 19 ms after the dispatch — the real gap seen on the box.
  timestamp:         '2026-08-04T02:25:14.429Z',
  ...over,
}) as Parameters<typeof handleMovement>[0]

const narrated = () =>
  (eventBus.publish as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls

beforeEach(() => {
  vi.mocked(eventBus.publish).mockClear()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.organisation.findUnique as any).mockResolvedValue({ id: 'org_1' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.dispatch.findFirst as any).mockResolvedValue({ id: 'dsp_1' })
})

describe('MOVEMENT_EXIT that echoes its dispatch', () => {
  it('is not narrated', async () => {
    const ok = await handleMovement(movement())
    expect(ok).toBe(true)              // handled, deliberately silent
    expect(eventBus.publish).not.toHaveBeenCalled()
  })

  it('is still suppressed when it arrives BEFORE its dispatch', async () => {
    // One of the 283 landed 54 s early; webhook ordering is not guaranteed.
    const ok = await handleMovement(movement({ timestamp: '2026-08-04T02:24:20.000Z' }))
    expect(ok).toBe(true)
    expect(eventBus.publish).not.toHaveBeenCalled()
  })

  it('narrates a genuine exit that stands alone', async () => {
    // No dispatch anywhere near it — this is a real gate crossing and the only
    // record of it, so it must survive.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.dispatch.findFirst as any).mockResolvedValue(null)

    await handleMovement(movement())

    expect(narrated()).toHaveLength(1)
    expect(narrated()[0]![1]['text']).toBe(
      'KTCC 870B · AUGUSTINE OWINO NYAMWOK left the yard to kwoyo u k.',
    )
  })

  it('never suppresses a RETURN', async () => {
    // Nothing else observes a vehicle coming home — the provider records it at
    // the weighbridge and no telemetry rule replaces it.
    await handleMovement(movement({ direction: 'RETURN' }))

    expect(narrated()).toHaveLength(1)
    expect(narrated()[0]![1]['text']).toBe('KTCC 870B · AUGUSTINE OWINO NYAMWOK returned to the yard.')
    // The dispatch lookup is for exits only; a return must not pay for it.
    expect(prismaMock.dispatch.findFirst).not.toHaveBeenCalled()
  })

  it('checks the dispatch window against the plate, not the whole fleet', async () => {
    await handleMovement(movement())
    const where = (prismaMock.dispatch.findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where['plate']).toBe('KTCC 870B')
  })
})
