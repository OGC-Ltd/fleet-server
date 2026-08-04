import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(),
  publishNotificationDurable: vi.fn(async (i: unknown) => ({ item: i, published: true })),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { publishNotificationDurable } from '../../src/lib/notifications/notification.store.js'
import { adjudicatePendingDrains } from '../../src/modules/fuel/fuel-adjudication.service.js'

const BEGAN    = new Date('2026-08-04T13:00:00Z')
const DETECTED = new Date('2026-08-04T13:05:00Z')
const NOW      = new Date('2026-08-04T13:40:00Z')   // past the settle window

const DRAIN = {
  id: 'ft_1', vehicleId: 'veh_1', beganAt: BEGAN, detectedAt: DETECTED,
  stolenMl: 40_000, initialLocation: 'Nyalulanga', finalFuelLevelMl: 160_000,
  vehicle: { organisationId: 'org_1', registrationPlate: 'CTR 03' },
}

/** Readings at one-minute steps from 12:55, spanning the whole event. */
const levels = (mls: number[]) =>
  mls.map((fuelLevelMl, i) => ({
    capturedAt: new Date(Date.parse('2026-08-04T12:55:00Z') + i * 60_000),
    fuelLevelMl,
  }))

const STEADY = [200_000, 200_000, 200_000, 200_000, 200_000, 200_000]
const DRAINING = [180_000, 170_000, 160_000, 160_000, 160_000]

const published = () =>
  (publishNotificationDurable as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls

const setLevels = (mls: number[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prismaMock.vehicleTelemetry.findMany as any).mockResolvedValue(levels(mls))

beforeEach(() => {
  vi.mocked(publishNotificationDurable).mockClear()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([DRAIN])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelTheft.update as any).mockResolvedValue({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelFilling.findFirst as any).mockResolvedValue(null)
})

describe('adjudicatePendingDrains', () => {
  it('reclassifies a recovered drain and never announces it', async () => {
    // The operator's case. This is the notification that should not exist.
    setLevels([...STEADY, ...DRAINING, 190_000, 198_000, 200_000, 200_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ redistribution: 1, loss: 0, published: 0 })
    expect(out.recoveredMl).toBe(40_000)
    expect(publishNotificationDurable).not.toHaveBeenCalled()
    expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ft_1' },
      data:  expect.objectContaining({ verdict: 'REDISTRIBUTION', verdictReason: 'level-recovered' }),
    }))
  })

  it('announces a drain whose level stayed down, with volume and place', async () => {
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ loss: 1, redistribution: 0, published: 1 })
    const item = published()[0]![0]
    expect(item['severity']).toBe('critical')
    expect(item['alertType']).toBe('fuelInconsistency')
    expect(item['text']).toContain('FUEL DROP: CTR 03')
    expect(item['text']).toContain('40 L lost')
    expect(item['text']).toContain('Nyalulanga')
    expect(item['text']).toContain('Tank now 160 L')
    // The event's own time, never the moment we got round to judging it.
    expect(item['at']).toEqual(BEGAN)
  })

  it('says so plainly when it could not check the claim', async () => {
    // The provider saw something and our telemetry cannot speak to it. The
    // feed must not sound as certain as it does for a confirmed loss.
    setLevels([200_000, 160_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ unverified: 1, loss: 0 })
    const item = published()[0]![0]
    expect(item['severity']).toBe('warning')
    expect(item['text']).toContain('reported lost')
    expect(item['text']).toContain('unconfirmed')
  })

  it('makes no claim of escalation', async () => {
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])
    await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })
    expect(String(published()[0]![0]['text'])).not.toMatch(/security|alerted|notified|dispatched/i)
  })

  it('writes nothing on a dry run', async () => {
    setLevels([...STEADY, ...DRAINING, 200_000, 200_000, 200_000, 200_000])

    const out = await adjudicatePendingDrains({ apply: false, notify: true, now: NOW })

    expect(out.redistribution).toBe(1)          // still counted, so it can be previewed
    expect(prismaMock.fuelTheft.update).not.toHaveBeenCalled()
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })

  it('stays quiet when notify is off, but still records the verdict', async () => {
    // The history backfill: judging weeks-old drains must not replay them onto
    // a feed that is meant to show what is happening now.
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: false, now: NOW })

    expect(out.loss).toBe(1)
    expect(prismaMock.fuelTheft.update).toHaveBeenCalled()
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })
})
