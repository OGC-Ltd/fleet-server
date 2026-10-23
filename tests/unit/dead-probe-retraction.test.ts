/**
 * A possible theft to "empty" is withdrawn only once the machine has RUN on
 * the empty probe — an emptied tank cannot do that, a dead probe can.
 *
 * The case: KTCC 872B, 30 Sep 2026. 15.2 L -> 0.1 L parked at 22:14, announced
 * as a siphon; at 05:44 the tractor started and drove still reading 0.1 L.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification.store.js', () => ({ publishNotification: vi.fn() }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { ranOnEmpty } from '../../src/modules/fuel/parked-fall.js'
import { retractDeadProbeDrains } from '../../src/modules/fuel/dead-probe-retraction.js'
import { publishNotification } from '../../src/lib/notifications/notification.store.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

const MIN = 60_000
const FALL = Date.parse('2026-09-30T19:29:00Z')  // 22:29 EAT, the first dead reading
const row = (minAfter: number, fuelMl: number, speedKmh = 0, engineOn = false, ignitionKnown = true) =>
  ({ t: FALL + minAfter * MIN, fuelMl, speedKmh, engineOn, ignitionKnown })

/** Parked all night on the dead probe, then started and driven at 05:44. */
const KTCC_872B = [
  ...Array.from({ length: 30 }, (_, i) => row(i * 15, 100)),
  row(435, 120, 0, true), row(436, 120, 7, true), row(437, 220, 14, true), row(438, 260, 13, true),
  row(461, 0, 0, true), row(462, 2_360, 0, true), row(463, 22_270, 0, true),
]

describe('ranOnEmpty', () => {
  it('proves a dropout once the machine runs on the empty probe', () => {
    expect(ranOnEmpty(KTCC_872B, FALL, null)).toBe(true)
  })

  it('starts at the first empty reading when the drain was stamped at the start of the fall', () => {
    // The ledger stamped KTCC 872B's drain at 22:14, the last reading at 15.2 L.
    const fromStart = [row(-15, 15_210), ...KTCC_872B]
    expect(ranOnEmpty(fromStart, FALL - 15 * MIN, null)).toBe(true)
  })

  it('does not reach for an empty spell long after the fall', () => {
    const late = [row(0, 15_000), row(90, 15_000), ...KTCC_872B.map(r => ({ ...r, t: r.t + 120 * MIN }))]
    expect(ranOnEmpty(late, FALL, null)).toBe(false)
  })

  it('does NOT excuse a tank genuinely drained to empty — the engine never runs again', () => {
    const drained = Array.from({ length: 60 }, (_, i) => row(i * 15, 100))
    expect(ranOnEmpty(drained, FALL, null)).toBe(false)
  })

  it('says nothing once the level is back above empty before any running', () => {
    // Refuelled first, then driven: the running proves nothing about the fall.
    const refuelled = [row(0, 100), row(60, 30_000), row(61, 30_000, 12, true), row(62, 29_900, 14, true), row(63, 29_800, 15, true)]
    expect(ranOnEmpty(refuelled, FALL, null)).toBe(false)
  })

  it('does not take the adapter\'s guessed engine state as running', () => {
    // engine_on is speed-derived where ignition is unknown; standing still it says nothing.
    const guessed = [row(0, 100, 0, true, false), row(1, 100, 0, true, false), row(2, 100, 0, true, false), row(3, 100, 0, true, false)]
    expect(ranOnEmpty(guessed, FALL, null)).toBe(false)
  })

  it('reads "empty" against the tank size', () => {
    // 8 L in a 400 L tank is under 3% — empty; in a 100 L tank it is fuel.
    const low = [row(0, 8_000, 10, true), row(1, 8_000, 10, true), row(2, 8_000, 10, true)]
    expect(ranOnEmpty(low, FALL, 400)).toBe(true)
    expect(ranOnEmpty(low, FALL, 100)).toBe(false)
  })
})

describe('retractDeadProbeDrains', () => {
  const now = new Date(FALL + 20 * 60 * MIN)
  const theft = {
    id: 'cmup3irug', vehicleId: 'v1', beganAt: new Date(FALL - 15 * MIN), detectedAt: new Date(FALL),
    stolenMl: 15_120, finalFuelLevelMl: 100,
    vehicle: { organisationId: 'org', registrationPlate: 'KTCC 872B', tankCapacityLitres: null },
  }
  const telemetry = (rows: ReturnType<typeof row>[]) => rows.map(r => ({
    capturedAt: new Date(r.t), fuelLevelMl: r.fuelMl, speedKmh: r.speedKmh, engineOn: r.engineOn, ignitionKnown: r.ignitionKnown,
  }))

  beforeEach(() => {
    vi.mocked(publishNotification).mockClear()
    ;(prismaMock.fuelTheft.updateMany as any).mockResolvedValue({ count: 1 })
  })

  it('re-judges the drain as a sensor fault, clears its cause and posts a retraction', async () => {
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([theft])
    ;(prismaMock.vehicleTelemetry.findMany as any).mockResolvedValue(telemetry(KTCC_872B))

    const out = await retractDeadProbeDrains({ now })

    expect(out).toEqual({ examined: 1, retracted: 1 })
    const upd = (prismaMock.fuelTheft.updateMany as any).mock.calls[0][0]
    expect(upd.where).toMatchObject({ id: 'cmup3irug', verdict: 'DRAIN' })
    expect(upd.data).toMatchObject({ verdict: 'SENSOR_FAULT', verdictReason: 'fsl-ran-empty', drainCause: null })
    expect(vi.mocked(publishNotification).mock.calls[0]![0]).toMatchObject({ severity: 'info', plate: 'KTCC 872B' })
    expect(vi.mocked(publishNotification).mock.calls[0]![0].text).toMatch(/^Retracted: KTCC 872B's 15\.1 L/)
  })

  it('leaves a drain alone when the machine has not run on the empty probe', async () => {
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([theft])
    ;(prismaMock.vehicleTelemetry.findMany as any).mockResolvedValue(telemetry(KTCC_872B.slice(0, 30)))

    const out = await retractDeadProbeDrains({ now })
    expect(out.retracted).toBe(0)
    expect(prismaMock.fuelTheft.updateMany).not.toHaveBeenCalled()
  })

  it('does not even read a drain that did not end empty', async () => {
    ;(prismaMock.fuelTheft.findMany as any).mockResolvedValue([{ ...theft, finalFuelLevelMl: 160_000 }])
    const out = await retractDeadProbeDrains({ now })
    expect(out.examined).toBe(0)
    expect(prismaMock.vehicleTelemetry.findMany).not.toHaveBeenCalled()
  })
})
