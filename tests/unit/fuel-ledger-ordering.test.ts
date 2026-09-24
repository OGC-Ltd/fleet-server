/**
 * The dependency between the two ledgers, and why the cycle runs them in the
 * order it does.
 *
 * `adjudicateDrain` cuts a drain's recovery window at any filling in it, EXCEPT
 * one already ruled REDISTRIBUTION — a phantom delivery must not be allowed to
 * truncate a drain's evidence. That exemption makes the drain's verdict depend
 * on the filling's, and therefore on which was judged first.
 *
 * `lib/queues/fuel-events` runs `adjudicateFillings` before
 * `adjudicatePendingDrains` in the same cycle for exactly this reason, and its
 * comment says so. Nothing tested it. This does.
 *
 * ## Why it is worth pinning
 *
 * Measured on the live ledger, 2026-09-23 — the same shape three times:
 *
 *   MUFINDI - FT 13  drain 19.4 L, fill 20.0 L 12 min later, tank 71.6 -> 90.6
 *   MUFINDI: MTR 04  drain 19.1 L, fill 16.8 L  8 min later, tank 40.7 -> 57.8
 *   MUFINDI: MTR 09  drain 20.6 L, fill 19.9 L  9 min later, tank 39.4 -> 59.3
 *
 * Judged in the right order the filling is a REFILL, it truncates, the level
 * had not recovered before it, and the drain stands. Judged in the wrong order
 * the filling is still carrying a stale REDISTRIBUTION, it does NOT truncate,
 * the refill's own rise is read as spontaneous recovery, and a real drain is
 * erased. MTR 09 is the case where that actually happened: its filling was
 * judged 390 minutes BEFORE the drain and the 20.6 L left the loss figures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(),
  publishNotificationDurable: vi.fn(async (i: unknown) => ({ item: i, published: true })),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { resetPrismaMock } from '../../src/lib/__mocks__/prisma.js'
import {
  adjudicatePendingDrains, __resetProbeProfileCache, __resetBandCache,
} from '../../src/modules/fuel/fuel-adjudication.service.js'

// MUFINDI - FT 13's shape, in millilitres, one reading a minute.
const BEGAN    = new Date('2026-09-23T09:47:00Z')
const DETECTED = new Date('2026-09-23T09:49:00Z')
const FILLED   = new Date('2026-09-23T10:01:00Z')
const NOW      = new Date('2026-09-23T11:30:00Z')   // everything ripe

const DRAIN = {
  id: 'ft_1', vehicleId: 'veh_1', beganAt: BEGAN, detectedAt: DETECTED,
  stolenMl: 19_400, initialLocation: 'Kabuga', finalFuelLevelMl: 71_600,
  vehicle: { organisationId: 'org_1', registrationPlate: 'MUFINDI - FT 13' },
}

/**
 * Readings from 09:17 (thirty minutes before the drain opens, matching
 * LOOKBEHIND_MS) at one-minute steps.
 *
 *   09:17-09:48  91 L, the tank before anything happened
 *   09:49-10:00  71.4 L, fallen and holding — the window the drain is judged on
 *   10:01+       90.6 L, the delivery, which must not count as recovery
 */
const SERIES = Array.from({ length: 120 }, (_, i) => {
  const at = new Date(Date.parse('2026-09-23T09:17:00Z') + i * 60_000)
  const ml = at < DETECTED ? 91_000 : at < FILLED ? 71_400 : 90_600
  return {
    captured_at: at, fuel_level_ml: ml,
    engine_on: false, speed_kmh: 0, ignition_known: true,
  }
})

/** The filling as the drain's evidence query would find it, with `verdict`. */
const fillingRow = (verdict: string) => ({ filledAt: FILLED, verdict })

/**
 * `$queryRaw` serves two different statements — the level series and the
 * probe's parked-swing profile — so the mock dispatches on the table name
 * rather than returning one shape for both.
 */
const installQueryRaw = () =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prismaMock.$queryRaw as any).mockImplementation((strings: unknown) => {
    const sql = Array.isArray(strings) ? strings.join(' ') : String(strings)
    if (sql.includes('vehicle_telemetry_raws')) return Promise.resolve(SERIES)
    // Steady probe: the trust gate must stay silent, or it decides the case
    // instead of the ordering.
    return Promise.resolve([{ parked: BigInt(200), swinging: BigInt(0) }])
  })

/** Everything `judgeDrain` reads that is not the point of this test. */
const installFixtures = () => {
  prismaMock.fuelTheft.findMany.mockResolvedValue([DRAIN] as never)
  prismaMock.fuelTheft.update.mockResolvedValue({} as never)
  // A truck on engine hours, so the burn branch has a band and stands aside for
  // a fall with no engine time.
  prismaMock.vehicle.findMany.mockResolvedValue([
    { id: 'veh_1', registrationPlate: 'MUFINDI - FT 13', vehicleType: 'TRUCK',
      organisationId: 'org_1', organisation: { code: 'KASULU' } },
  ] as never)
  prismaMock.vehicleFuelRate.findMany.mockResolvedValue([
    { vehicleId: 'veh_1', lPerHour: 10, lPerKm: null, runs: 5 },
  ] as never)
  installQueryRaw()
}

beforeEach(() => {
  resetPrismaMock()
  __resetProbeProfileCache()
  __resetBandCache()
  vi.clearAllMocks()
  installFixtures()
})

const verdictWritten = (): Record<string, unknown> =>
  prismaMock.fuelTheft.update.mock.calls[0]![0]!.data as Record<string, unknown>

describe('a drain judged AFTER its filling — the order the cycle runs', () => {
  it('a corroborated delivery truncates the window, and the drain stands', async () => {
    // What `adjudicateFillings` leaves behind when it has run first.
    prismaMock.fuelFilling.findFirst.mockResolvedValue(fillingRow('REFILL') as never)

    await adjudicatePendingDrains({ apply: true, notify: false, now: NOW })

    const written = verdictWritten()
    expect(written['verdict']).toBe('DRAIN')
    expect(written['verdictReason']).toBe('level-stayed-down')
    // The 19.2 L that arrived at 10:01 is the pump, not the tank recovering.
    expect(Number(written['recoveredMl'] ?? 0)).toBeLessThan(1_000)
  })
})

describe('a drain judged BEFORE its filling — the failure the order prevents', () => {
  it('a stale REDISTRIBUTION does not truncate, and the drain is erased', async () => {
    // `adjudicateDrain` exempts a REDISTRIBUTION filling from truncating, so an
    // unjudged or wrongly-judged one leaves the window wide open and the
    // delivery's own rise reads as the level coming back by itself.
    prismaMock.fuelFilling.findFirst.mockResolvedValue(null as never)

    await adjudicatePendingDrains({ apply: true, notify: false, now: NOW })

    const written = verdictWritten()
    expect(written['verdict']).toBe('REDISTRIBUTION')
    expect(written['verdictReason']).toBe('level-recovered')
  })

  it('the two orders disagree on the same evidence — which is the whole point', async () => {
    prismaMock.fuelFilling.findFirst.mockResolvedValue(fillingRow('REFILL') as never)
    await adjudicatePendingDrains({ apply: true, notify: false, now: NOW })
    const right = verdictWritten()['verdict']

    resetPrismaMock()
    __resetProbeProfileCache()
    __resetBandCache()
    installFixtures()
    prismaMock.fuelFilling.findFirst.mockResolvedValue(null as never)
    await adjudicatePendingDrains({ apply: true, notify: false, now: NOW })
    const wrong = verdictWritten()['verdict']

    expect(right).toBe('DRAIN')
    expect(wrong).toBe('REDISTRIBUTION')
    expect(right).not.toBe(wrong)
  })
})
