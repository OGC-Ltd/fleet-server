/**
 * FUEL RATE / FUEL DOWN as one summary a day (FUEL_RATE_ALERTS=digest).
 *
 * The text builder is pure; the job reads the fleet day that just closed off
 * the ledger and posts one warning per organisation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(),
  publishNotificationDurable: vi.fn(async (i: unknown) => ({ item: i, published: true })),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { publishNotificationDurable } from '../../src/lib/notifications/notification.store.js'
import { digestKind, fleetDayLabel, fuelRateDigestText, type DigestRow } from '../../src/modules/fuel/fuel-rate-digest.js'
import { runFuelRateDigest } from '../../src/lib/queues/fuel-rate-digest.js'

const row = (plate: string, litres: number, kind: DigestRow['kind'] = 'FUEL RATE'): DigestRow =>
  ({ plate, kind, stolenMl: litres * 1000 })

describe('digestKind', () => {
  it('files each announced reason under the headline it used to go out as', () => {
    expect(digestKind('burn-above-class-ceiling')).toBe('FUEL RATE')
    expect(digestKind('burn-far-above-band')).toBe('FUEL RATE')
    expect(digestKind('drop-while-stationary')).toBe('FUEL DOWN')
    expect(digestKind('drop-exceeds-distance')).toBe('FUEL DOWN')
    expect(digestKind('parked-siphon')).toBeNull()
    expect(digestKind(null)).toBeNull()
  })
})

describe('fleetDayLabel', () => {
  it('names the EAT day, not the UTC one it starts in', () => {
    // EAT midnight opening Saturday 26 Sep is 21:00 UTC on the Friday.
    expect(fleetDayLabel(new Date('2026-09-25T21:00:00Z'))).toBe('Sat 26 Sep')
  })
})

describe('fuelRateDigestText', () => {
  it('says nothing for a day with nothing in it', () => {
    expect(fuelRateDigestText([], 'Sat 26 Sep')).toBeNull()
  })

  it('counts the day, splits it by headline and leads with the machine that kept appearing', () => {
    const text = fuelRateDigestText([
      row('MUFINDI - EX 16', 20), row('MUFINDI - EX 16', 30), row('MUFINDI - EX 16', 25),
      row('MUFINDI - EX 22', 10), row('MUFINDI - EX 22', 12),
      row('MUFINDI: COMP 01', 40), row('MUFINDI: COMP 01', 45),
      row('MUFINDI: EX 04', 60), row('MUFINDI - EX 21', 18),
      row('KTCC 450L', 16, 'FUEL DOWN'), row('MUFINDI: DZ 09', 30, 'FUEL DOWN'),
    ], 'Sat 26 Sep')!

    expect(text).toMatch(/^FUEL RATE \/ FUEL DOWN, daily summary for Sat 26 Sep: 11 drops /)
    expect(text).toContain('(9 FUEL RATE, 2 FUEL DOWN)')
    expect(text).toContain('on 7 machines, 306 L in all')
    // Most often first; equal counts by litres.
    expect(text).toContain('By machine: MUFINDI - EX 16 ×3 (75 L), MUFINDI: COMP 01 ×2 (85 L), MUFINDI - EX 22 ×2 (22 L), '
      + 'MUFINDI: EX 04 ×1 (60 L), MUFINDI: DZ 09 ×1 (30 L), and 2 more.')
    // The live wording's rule: state what the tank did, never conclude theft.
    expect(text).not.toMatch(/theft|stolen|suspicious|loss|lost|unexplained/i)
  })

  it('reads naturally for a single drop', () => {
    expect(fuelRateDigestText([row('KCF 180A', 8, 'FUEL DOWN')], 'Sun 27 Sep'))
      .toContain(': 1 drop beyond what the machine\'s measured burn or distance accounts for (1 FUEL DOWN), on 1 machine, 8 L in all. By machine: KCF 180A ×1 (8 L).')
  })
})

describe('runFuelRateDigest', () => {
  const NOW = new Date('2026-09-27T04:00:00Z')   // 07:00 EAT, Sunday
  const published = () =>
    (publishNotificationDurable as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls

  beforeEach(() => { vi.mocked(publishNotificationDurable).mockClear() })

  const found = (org: string, plate: string, litres: number, causeReason: string) =>
    ({ stolenMl: litres * 1000, causeReason, vehicle: { organisationId: org, registrationPlate: plate } })

  it('reads the fleet day that just closed and posts one warning per organisation', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([
      found('org_kasulu', 'MUFINDI - EX 16', 22, 'burn-far-above-band'),
      found('org_kasulu', 'MUFINDI - EX 16', 18, 'burn-above-class-ceiling'),
      found('org_sukari', 'KTCC 450L', 16, 'drop-while-stationary'),
    ])

    const out = await runFuelRateDigest(NOW)

    const where = prismaMock.fuelTheft.findMany.mock.calls[0]![0]!.where!
    expect(where.beganAt).toEqual({ gte: new Date('2026-09-25T21:00:00Z'), lt: new Date('2026-09-26T21:00:00Z') })
    expect(where.dismissedAt).toBeNull()
    expect(where.drainCause).toEqual({ not: 'SIPHON' })
    expect((where.causeReason as { in: string[] }).in).toEqual(expect.arrayContaining([
      'burn-above-class-ceiling', 'burn-far-above-band', 'drop-exceeds-distance', 'drop-while-stationary',
    ]))

    expect(out).toEqual({ day: '2026-09-26', drops: 3, organisations: 2, published: 2 })
    const items = published().map(c => c[0])
    expect(items.map(i => i['id']).sort()).toEqual(['fuel-rate-digest-org_kasulu-2026-09-26', 'fuel-rate-digest-org_sukari-2026-09-26'])
    for (const i of items) {
      expect(i['severity']).toBe('warning')
      expect(i['at']).toEqual(NOW)
      expect(String(i['text'])).toContain('daily summary for Sat 26 Sep')
    }
    expect(String(items.find(i => i['orgId'] === 'org_kasulu')!['text'])).toContain('MUFINDI - EX 16 ×2 (40 L)')
  })

  it('posts nothing for a day with nothing in it', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([])
    expect(await runFuelRateDigest(NOW)).toEqual({ day: '2026-09-26', drops: 0, organisations: 0, published: 0 })
    expect(publishNotificationDurable).not.toHaveBeenCalled()
  })
})
