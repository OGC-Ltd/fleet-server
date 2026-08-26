/**
 * The filling SWEEP, as opposed to the pure judgement.
 *
 * `fuel-filling-adjudication.test.ts` covers `adjudicateFilling` — given a
 * claim and a level series, what verdict. This covers the layer around it: what
 * the sweep selects, what it writes, and the one thing it must refuse to do.
 *
 * It had no test at all, which is how the rejudge path came to lack the guard
 * its counterpart on the drains has carried since `readjudicate-fuel` was
 * written.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { resetPrismaMock } from '../../src/lib/__mocks__/prisma.js'
import { adjudicateFillings } from '../../src/modules/fuel/fuel-filling-adjudication.service.js'

const FILLED_AT = new Date('2026-08-26T08:00:00Z')
// Past FILL_SETTLE_MINUTES + FILL_HOLD_MINUTES (60), so the row is ripe.
const NOW       = new Date('2026-08-26T09:30:00Z')

const row = (over: Record<string, unknown> = {}) => ({
  id: 'ff_1', vehicleId: 'veh_1', filledAt: FILLED_AT, filledMl: 100_000,
  verdictReason: null as string | null,
  vehicle: { registrationPlate: 'KDL 182X' },
  ...over,
})

/** Level readings at one-minute steps from 07:40, as the service reads them. */
const levels = (mls: number[]) =>
  mls.map((fuelLevelMl, i) => ({
    capturedAt:  new Date(Date.parse('2026-08-26T07:40:00Z') + i * 60_000),
    fuelLevelMl,
    engineOn:    false,
  }))

/**
 * A real 100 L delivery, shaped around the adjudicator's own window boundaries.
 *
 * Readings run 07:40 → 09:00 at one-minute steps, so index i is 07:40 + i min:
 *
 *   i <= 20  (07:40-08:00)  baseline, the FILL_LOOKBEHIND window
 *   20 < i < 40 (08:00-08:20) the pump running — deliberately discarded, since a
 *                             tank mid-fill reads neither its old nor new level
 *   i >= 40  (08:20-09:00)  the settled level, after FILL_HOLD
 *
 * The medians either side are what decide it, which is why the ramp must not
 * reach into the after-window: 32 readings there, only six of them settled, and
 * the median stays at the pump value rather than the new level.
 */
const AROUND_A_REAL_FILL = Array.from({ length: 81 }, (_, i) =>
  i <= 20 ? 100_000
  : i >= 40 ? 200_000
  : 100_000 + Math.round((i - 20) / 20 * 100_000))

beforeEach(() => {
  resetPrismaMock()
  vi.clearAllMocks()
})

describe('the filling sweep', () => {
  it('judges a ripe filling and writes the verdict with what our tank actually saw', async () => {
    prismaMock.fuelFilling.findMany.mockResolvedValue([row()] as never)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue(
      levels(AROUND_A_REAL_FILL) as never,
    )

    const out = await adjudicateFillings({ apply: true, now: NOW })

    expect(out.examined).toBe(1)
    expect(prismaMock.fuelFilling.update).toHaveBeenCalledTimes(1)
    const written = prismaMock.fuelFilling.update.mock.calls[0]![0]!.data as Record<string, unknown>
    expect(written['verdict']).toBe('REFILL')
    expect(written['verdictReason']).toBe('level-rose')
    // The provider's claim is never touched — only our own observation is added
    // beside it, so the two stay comparable.
    expect(written).not.toHaveProperty('filledMl')
    expect(written['observedRiseMl']).toBeGreaterThan(0)
  })

  it('a dry run judges without writing', async () => {
    prismaMock.fuelFilling.findMany.mockResolvedValue([row()] as never)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue(
      levels(AROUND_A_REAL_FILL) as never,
    )

    const out = await adjudicateFillings({ apply: false, now: NOW })

    expect(out.examined).toBe(1)
    expect(prismaMock.fuelFilling.update).not.toHaveBeenCalled()
  })

  /**
   * The guard this file exists for.
   *
   * A row decided on evidence must not be re-decided as "we have no evidence".
   * Telemetry ages out; that is a fact about our retention, not about the
   * delivery. Without this, `--rejudge` run a month later quietly converts every
   * corroborated `level-rose` into `insufficient-telemetry`.
   */
  it('a re-judgement never replaces a corroborated verdict with the absence of one', async () => {
    prismaMock.fuelFilling.findMany.mockResolvedValue(
      [row({ verdictReason: 'level-rose' })] as never,
    )
    // The readings that decided it are gone.
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue([] as never)

    const out = await adjudicateFillings({ apply: true, rejudge: true, now: NOW })

    expect(out.kept).toBe(1)
    expect(prismaMock.fuelFilling.update).not.toHaveBeenCalled()
  })

  it('...but an undecided row with no telemetry is still written, because nothing is being lost', async () => {
    prismaMock.fuelFilling.findMany.mockResolvedValue([row()] as never)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue([] as never)

    const out = await adjudicateFillings({ apply: true, now: NOW })

    expect(out.kept).toBe(0)
    expect(out.refillUnchecked).toBe(1)
    expect(prismaMock.fuelFilling.update).toHaveBeenCalledTimes(1)
  })

  it('reports the claimed volume it could not corroborate, which is the figure worth watching', async () => {
    prismaMock.fuelFilling.findMany.mockResolvedValue([row()] as never)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue([] as never)

    const out = await adjudicateFillings({ apply: false, now: NOW })

    expect(out.uncorroboratedMl).toBe(100_000)
  })
})
