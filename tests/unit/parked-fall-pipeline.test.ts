/**
 * The parked-fall rule's database halves: stage one's gates, record and feed
 * item (`fuel-watch.worker`), and stage two's pass (`lib/queues/parked-falls`).
 *
 * The verdict logic itself is `parked-fall.test.ts`; these pin what gets
 * written and what an operator is told, and that neither happens twice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(),
}))
vi.mock('../../src/modules/fuel/fuel-adjudication.service.js', () => ({
  getProbeProfile: vi.fn(),
}))

import { prismaMock } from '../helpers/prisma.mock.js'
import { publishNotification } from '../../src/lib/notifications/notification.store.js'
import { getProbeProfile } from '../../src/modules/fuel/fuel-adjudication.service.js'
import { recordParkedFall } from '../../src/lib/workers/fuel-watch.worker.js'
import { runParkedFallVerdicts } from '../../src/lib/queues/parked-falls.js'
import type { LiveFuelDrop } from '../../src/lib/fuel-drop-watch.js'

const SETTLED = new Date('2026-09-25T12:24:33Z')
const NOW = new Date('2026-09-25T12:30:00Z')

const DROP: LiveFuelDrop = {
  orgId: 'org_1', vehicleId: 'veh_1', plate: 'MUFINDI: CTR 12',
  baselineMl: 215_300, troughMl: 210_000, droppedMl: 5_300,
  settledAt: SETTLED, fallStartedAt: new Date(SETTLED.getTime() - 15 * 60_000), stillBeforeFallMs: 16 * 60_000,
  stillForMs: 31 * 60_000, engineOnMs: 118_000,
  engineEvidence: 'sensor', meterAdvanceH: 0.03, attitudeShiftG: null,
  confirmedAt: new Date(SETTLED.getTime() + 5 * 60_000), tankCapacityMl: 385_000,
}

const publishedCalls = () =>
  (publishNotification as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls

beforeEach(() => {
  vi.mocked(publishNotification).mockClear()
  vi.mocked(getProbeProfile).mockResolvedValue({ parkedWindows: 40, swingWindows: 0, fillRatio: 0.6 })
  prismaMock.parkedFuelFall.findUnique.mockResolvedValue(null)
  prismaMock.parkedFuelFall.create.mockResolvedValue({} as never)
  // The frozen-probe gate reads the hours before the fall; none by default.
  prismaMock.vehicleTelemetry.findMany.mockResolvedValue([])
})

describe('stage one — record and announce', () => {
  it('writes a PENDING row and posts the possible-theft call at once, as critical', async () => {
    // The operator's requirement: a verdict within ten minutes, not at the next start.
    await recordParkedFall(DROP, NOW)
    expect(prismaMock.parkedFuelFall.create).toHaveBeenCalledTimes(1)
    const data = prismaMock.parkedFuelFall.create.mock.calls[0]![0].data
    expect(data).toMatchObject({ verdict: 'PENDING', droppedMl: 5_300, engineEvidence: 'sensor', flaggedAt: DROP.confirmedAt })
    const [item] = publishedCalls()[0]!
    expect(item.id).toBe(`fuel-watch-veh_1-${SETTLED.getTime()}`)
    expect(item.severity).toBe('critical')
    expect(String(item.text)).toMatch(/^POSSIBLE THEFT — FUEL DRAINED FROM A PARKED MACHINE: MUFINDI: CTR 12 lost 5\.3 L/)
    expect(String(item.text)).toMatch(/standing still for 16 minutes with the engine off/)
  })

  it('withholds a fall on a probe reading empty — recorded, never announced', async () => {
    await recordParkedFall({ ...DROP, troughMl: 0, droppedMl: 281_000, baselineMl: 281_000 }, NOW)
    expect(prismaMock.parkedFuelFall.create.mock.calls[0]![0].data).toMatchObject({ verdict: 'WITHHELD' })
    expect(publishedCalls()).toHaveLength(0)
  })

  it("withholds a fall on a probe whose 30-day profile swings — the adjudicator's own gate", async () => {
    vi.mocked(getProbeProfile).mockResolvedValue({ parkedWindows: 20, swingWindows: 9, fillRatio: 0.6 })
    await recordParkedFall(DROP, NOW)
    const data = prismaMock.parkedFuelFall.create.mock.calls[0]![0].data
    expect(data.verdict).toBe('WITHHELD')
    expect(data.verdictReason).toMatch(/swings/)
    expect(publishedCalls()).toHaveLength(0)
  })

  it('withholds a counter-judged fall when that counter does not track the engine', async () => {
    // Flat for three days: "the counter did not move" says nothing about the engine.
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ capturedAt: new Date(NOW.getTime() - i * 60_000), speedKmh: 0, engineHoursMeter: 900 })) as never,
    )
    await recordParkedFall({ ...DROP, engineEvidence: 'counter' }, NOW)
    const data = prismaMock.parkedFuelFall.create.mock.calls[0]![0].data
    expect(data.verdict).toBe('WITHHELD')
    expect(data.verdictReason).toMatch(/counter does not track the engine/)
    expect(publishedCalls()).toHaveLength(0)
  })

  it('announces a counter-judged fall when the counter runs while the machine stands', async () => {
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ capturedAt: new Date(NOW.getTime() - (200 - i) * 60_000), speedKmh: 0, engineHoursMeter: 900 + i / 60 })) as never,
    )
    await recordParkedFall({ ...DROP, engineEvidence: 'counter' }, NOW)
    expect(prismaMock.parkedFuelFall.create.mock.calls[0]![0].data.verdict).toBe('PENDING')
    expect(String(publishedCalls()[0]![0].text)).toMatch(/engine-hours counter/)
  })

  it('withholds a fall that follows a frozen probe — the catch-up, not a siphon (MTR 18, 26 Sep)', async () => {
    // The level held at 46.3 L to the millilitre through six hours, four of them working.
    const start = DROP.fallStartedAt.getTime() - 6 * 3_600_000
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue(
      Array.from({ length: 73 }, (_, i) => {
        const t = start + i * 5 * 60_000
        const working = t < start + 4 * 3_600_000
        return { capturedAt: new Date(t), fuelLevelMl: 46_300, speedKmh: working ? 12 : 0, engineOn: working, ignitionKnown: true, engineHoursMeter: null }
      }) as never,
    )
    await recordParkedFall({ ...DROP, baselineMl: 46_300, troughMl: 20_800, droppedMl: 25_500 }, NOW)
    const data = prismaMock.parkedFuelFall.create.mock.calls[0]![0].data
    expect(data.verdict).toBe('WITHHELD')
    expect(data.verdictReason).toMatch(/held 46\.3 L to the millilitre/)
    expect(publishedCalls()).toHaveLength(0)
  })

  it('says the machine did not tilt, where its tracker has an accelerometer', async () => {
    await recordParkedFall({ ...DROP, attitudeShiftG: 0.004 }, NOW)
    expect(String(publishedCalls()[0]![0].text)).toMatch(/without tilting, by its accelerometer/)
  })

  it('does nothing for a fall it has already recorded — a replay cannot announce twice', async () => {
    prismaMock.parkedFuelFall.findUnique.mockResolvedValue({ id: 'pf_1' } as never)
    await recordParkedFall(DROP, NOW)
    expect(prismaMock.parkedFuelFall.create).not.toHaveBeenCalled()
    expect(publishedCalls()).toHaveLength(0)
  })
})

describe('stage two — the verdict pass', () => {
  const S = SETTLED.getTime()
  const FALL = {
    id: 'pf_1', organisationId: 'org_1', vehicleId: 'veh_1', settledAt: SETTLED,
    troughMl: 40_000, droppedMl: 20_000, engineEvidence: 'sensor',
    vehicle: { registrationPlate: 'MUFINDI: CTR 19' },
  }
  /** Parked and down for three hours, then working, still down. */
  const rows = (until: number) => {
    const out = []
    for (let t = S - 10 * 60_000; t <= until; t += 60_000) {
      const working = t >= S + 3 * 3_600_000
      out.push({
        capturedAt: new Date(t), speedKmh: 0, engineOn: working, ignitionKnown: true,
        fuelLevelMl: working ? 40_000 - Math.round((t - S - 3 * 3_600_000) / 720) : 40_000, engineHoursMeter: null,
      })
    }
    return out
  }

  beforeEach(() => {
    prismaMock.parkedFuelFall.findMany.mockResolvedValue([FALL] as never)
    prismaMock.fuelFilling.findMany.mockResolvedValue([])
    prismaMock.parkedFuelFall.updateMany.mockResolvedValue({ count: 1 })
  })

  it('decides CONFIRMED, guarded on PENDING, and announces possible theft', async () => {
    const now = new Date(S + 5.2 * 3_600_000)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue(rows(now.getTime()) as never)
    const out = await runParkedFallVerdicts(now)
    expect(out.decided).toEqual({ CONFIRMED: 1 })
    const update = prismaMock.parkedFuelFall.updateMany.mock.calls[0]![0]
    expect(update.where).toEqual({ id: 'pf_1', verdict: 'PENDING' })
    expect(update.data).toMatchObject({ verdict: 'CONFIRMED', nextStartBy: 'engine' })
    const [item] = publishedCalls()[0]!
    expect(item.id).toBe('fuel-parked-pf_1')
    expect(item.severity).toBe('critical')
    expect(String(item.text)).toMatch(/^POSSIBLE THEFT — FUEL STILL MISSING: MUFINDI: CTR 19 lost 20\.0 L while parked with the engine off, and the level had not come back as fuel/)
  })

  it('announces fuel put back while the machine stood as drained and topped up', async () => {
    const pour = S + 90 * 60_000
    const now = new Date(pour + 5 * 60_000)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue(rows(now.getTime()).map(r =>
      (r.capturedAt.getTime() >= pour ? { ...r, fuelLevelMl: 59_000 } : r)) as never)
    const out = await runParkedFallVerdicts(now)
    expect(out.decided).toEqual({ TOPPED_UP: 1 })
    const [item] = publishedCalls()[0]!
    expect(item.severity).toBe('critical')
    expect(String(item.text)).toMatch(/^POSSIBLE THEFT — DRAINED AND TOPPED UP: MUFINDI: CTR 19 lost 20\.0 L while parked, then 1\.5 h later the level came back to the old level while the machine stood with the engine off\./)
  })

  it('leaves a fall alone while its verdict is still pending', async () => {
    const now = new Date(S + 2 * 3_600_000)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue(rows(now.getTime()) as never)
    const out = await runParkedFallVerdicts(now)
    expect(out.decided).toEqual({})
    expect(prismaMock.parkedFuelFall.updateMany).not.toHaveBeenCalled()
    expect(publishedCalls()).toHaveLength(0)
  })

  it('does not announce a fall another pass already decided', async () => {
    const now = new Date(S + 5.2 * 3_600_000)
    prismaMock.vehicleTelemetry.findMany.mockResolvedValue(rows(now.getTime()) as never)
    prismaMock.parkedFuelFall.updateMany.mockResolvedValue({ count: 0 })
    const out = await runParkedFallVerdicts(now)
    expect(out.decided).toEqual({})
    expect(publishedCalls()).toHaveLength(0)
  })
})
