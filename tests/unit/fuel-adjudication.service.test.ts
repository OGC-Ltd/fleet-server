import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(),
  publishNotificationDurable: vi.fn(async (i: unknown) => ({ item: i, published: true })),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { publishNotificationDurable } from '../../src/lib/notifications/notification.store.js'
import {
  adjudicatePendingDrains, __resetProbeProfileCache,
} from '../../src/modules/fuel/fuel-adjudication.service.js'

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

/**
 * The vehicle's parked-swing profile, which the trust gate reads for any drain
 * that reaches LOSS. Steady by default — the gate is meant to be silent on the
 * 97 of 139 machines that never swing.
 */
const setProbeProfile = (parked: number, swinging: number) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prismaMock.$queryRaw as any).mockResolvedValue([{ parked: BigInt(parked), swinging: BigInt(swinging) }])

beforeEach(() => {
  vi.mocked(publishNotificationDurable).mockClear()
  __resetProbeProfileCache()   // module-global, keyed by vehicle — would leak between cases
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([DRAIN])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelTheft.update as any).mockResolvedValue({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.fuelFilling.findFirst as any).mockResolvedValue(null)   // no refuel unless a case sets one
  setProbeProfile(200, 0)
})

describe('adjudicatePendingDrains', () => {
  it('reclassifies a recovered drain and never announces it', async () => {
    // The operator's case. This is the notification that should not exist.
    setLevels([...STEADY, ...DRAINING, 190_000, 198_000, 200_000, 200_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ redistribution: 1, drain: 0, published: 0 })
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

    expect(out).toMatchObject({ drain: 1, drainConfirmed: 1, redistribution: 0, published: 1 })
    const item = published()[0]![0]
    expect(item['severity']).toBe('critical')
    expect(item['alertType']).toBe('fuelInconsistency')
    expect(item['text']).toContain('FUEL DRAIN: CTR 03')
    // The level fell and did not come back. That is all this says — where the
    // fuel went is not something a probe can see, so the words "loss",
    // "theft", "stolen" and "suspicious" appear nowhere.
    expect(item['text']).toContain('40 L down and not recovered')
    expect(item['text']).not.toMatch(/loss|lost|theft|stolen|suspicious/i)
    expect(item['text']).toContain('Nyalulanga')
    expect(item['text']).toContain('Tank now 160 L')
    // The event's own time, never the moment we got round to judging it.
    expect(item['at']).toEqual(BEGAN)
  })

  it('does not sound as certain about a claim it could not check', async () => {
    // The provider saw something and our telemetry cannot speak to it. The
    // distinction is carried by the wording and the severity — not by a
    // trailing explanation, which on this fleet followed a place string long
    // enough that nobody reached the end of it.
    setLevels([200_000, 160_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ drain: 1, drainConfirmed: 0 })
    const item = published()[0]![0]
    expect(item['severity']).toBe('warning')          // a confirmed drain is 'critical'
    expect(item['text']).toContain('reported, not confirmed')
    expect(item['text']).not.toMatch(/loss|lost|theft|stolen|suspicious/i)
  })

  it('makes no claim of escalation', async () => {
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])
    await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })
    expect(String(published()[0]![0]['text'])).not.toMatch(/security|alerted|notified|dispatched/i)
  })

  it('still judges a drain when a refuel happens LATER in the window', async () => {
    // A filling two hours after the event cannot explain a level that came
    // back five minutes in. 29-35% of live drains have a filling somewhere in
    // the window; discarding them all would forfeit most of what is decidable.
    setLevels([...STEADY, ...DRAINING, 190_000, 198_000, 200_000, 200_000])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelFilling.findFirst as any).mockResolvedValue({
      filledAt: new Date('2026-08-04T15:00:00Z'),
    })

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ redistribution: 1, refill: 0, drain: 0 })
  })

  it('does not narrate a backlog onto the live feed', async () => {
    // The ledger holds 30 days. The first pass over it must record verdicts
    // without replaying every old drain as though it just happened.
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])

    const out = await adjudicatePendingDrains({
      apply: true, notify: true, now: NOW,
      notifyCutoff: new Date('2026-08-04T13:30:00Z'),   // after this drain began
    })

    expect(out.drain).toBe(1)                       // still judged
    expect(prismaMock.fuelTheft.update).toHaveBeenCalled()
    expect(publishNotificationDurable).not.toHaveBeenCalled()   // but not announced
  })

  it('will not confirm a drain on a probe that swings while parked', async () => {
    // The operator's DZ 07 case, reached by the route that survives
    // measurement: not "the tank was part full" but "this probe moves 25 L on a
    // machine standing still, in 9 of its 12 parked half-hours".
    setLevels([...STEADY, ...DRAINING, 160_000, 159_000, 158_000, 158_000])
    setProbeProfile(40, 30)

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out).toMatchObject({ drain: 1, drainConfirmed: 0 })
    // Still a DRAIN — the level fell and stayed down. What the gate withdraws
    // is the claim that our own telemetry settles it.
    expect(prismaMock.fuelTheft.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ verdict: 'DRAIN', verdictReason: 'probe-swings' }),
    }))
    // Announced at warning severity rather than critical, so it stops reading
    // as an accusation against whoever was driving.
    const item = published()[0]![0]
    expect(item['severity']).toBe('warning')
    expect(item['text']).toContain('reported, not confirmed')
  })

  it('does not ask about the probe unless the drain was confirmed', async () => {
    // The profile costs a second query per drain and only a CONFIRMED drain
    // can be downgraded by it — 417 of 2,571 rows on the live ledger.
    setLevels([...STEADY, ...DRAINING, 190_000, 198_000, 200_000, 200_000])

    const out = await adjudicatePendingDrains({ apply: true, notify: true, now: NOW })

    expect(out.redistribution).toBe(1)
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
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

    expect(out.drain).toBe(1)
    expect(prismaMock.fuelTheft.update).toHaveBeenCalled()
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })
})
