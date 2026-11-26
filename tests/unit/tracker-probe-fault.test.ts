/**
 * The tracker's own word on the fuel probe (operator, 2026-11-25): a BLE probe's fault code, with the
 * account's label, recorded as a fault episode, and the Fuel Consumption Rate report's comment read
 * from it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../../src/lib/event-bus.js', () => ({ eventBus: { publish: vi.fn(), subscribe: vi.fn() } }))
vi.mock('../../src/modules/fuel/probe-report.service.js', () => ({ getProbeReport: vi.fn(async () => []) }))
vi.mock('../../src/modules/telemetry/telemetry.service.js', () => ({ getFleetSnapshot: vi.fn(async () => []) }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { env } from '../../src/config/env.js'
import { eventBus } from '../../src/lib/event-bus.js'
import { getFleetSnapshot } from '../../src/modules/telemetry/telemetry.service.js'
import { sweepSensorFaults, trackerProbeStates, TRACKER_PROBE_KIND } from '../../src/modules/telemetry/sensor-fault-sweep.service.js'
import { probeFaultWords } from '../../src/providers/wialon/wialon.adapter.js'
import { probeFaultText } from '../../src/modules/reports/range-reports.service.js'

const LOST = 'Lost Contact with Tubes Error - Needs Replacement'
const open = (vehicleId: string, kind = TRACKER_PROBE_KIND) => ({ id: `e_${vehicleId}`, vehicleId, kind })
const published = (topic: string) => vi.mocked(eventBus.publish).mock.calls.filter((c) => c[0] === topic).map((c) => c[1] as { vehicleId: string; kind: string; detail?: string })

beforeEach(() => {
  env.INCIDENT_CAPTURE_ENABLED = true
  vi.mocked(eventBus.publish).mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.sensorFaultEpisode.findMany as any).mockResolvedValue([])
})

describe('the probe fault in words', () => {
  it('the account’s own label where it has one, else what the value means', () => {
    expect(probeFaultWords({ raw: 6500, calibratedMax: 3980, reason: LOST })).toBe(LOST)
    expect(probeFaultWords({ raw: 4095, calibratedMax: 3980, reason: null })).toBe('Reading 4095, above its calibrated range of 3980')
    expect(probeFaultWords(undefined)).toBeNull()
  })
  it('the report drops the "Fuel probe:" prefix the episode carries', () => {
    expect(probeFaultText(`Fuel probe: ${LOST}`)).toBe(LOST)
    expect(probeFaultText('Fuel probe: stopped-reporting')).toBe('stopped-reporting')
    expect(probeFaultText('')).toBe('fuel probe fault')
  })
})

describe('which units the tracker says are faulty, and which read true', () => {
  it('faulty with its reason; reading only with a real level and no fault; unknown otherwise', () => {
    const s = trackerProbeStates([
      { vehicleId: 'a', fuelProbeFault: true, fuelProbeFaultReason: LOST, fuelLevelMl: 50_000 },
      { vehicleId: 'b', fuelProbeFault: false, fuelLevelMl: 80_000 },
      { vehicleId: 'c', fuelProbeFault: false, fuelLevelMl: null },
    ])
    expect([...s.faulty]).toEqual([['a', LOST]])
    expect([...s.reading]).toEqual(['b'])
  })
})

describe('the sweep, for the tracker’s probe faults', () => {
  it('opens one where the tracker reports a fault, with its reason', async () => {
    vi.mocked(getFleetSnapshot).mockResolvedValue([{ vehicleId: 'a', fuelProbeFault: true, fuelProbeFaultReason: LOST, fuelLevelMl: 40_000 }] as never)
    await sweepSensorFaults('org_1', new Date('2026-11-25T18:00:00Z'))
    expect(published('sensorFault:open')).toMatchObject([{ vehicleId: 'a', kind: TRACKER_PROBE_KIND, detail: `Fuel probe: ${LOST}` }])
  })
  it('does not open a second while one is open', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.sensorFaultEpisode.findMany as any).mockResolvedValue([open('a')])
    vi.mocked(getFleetSnapshot).mockResolvedValue([{ vehicleId: 'a', fuelProbeFault: true, fuelProbeFaultReason: LOST }] as never)
    await sweepSensorFaults('org_1')
    expect(published('sensorFault:open')).toEqual([])
    expect(published('sensorFault:close')).toEqual([])
  })
  it('closes it only once the unit reads a real level with no fault; an absent flag alone (after a restart) is not a repair', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.sensorFaultEpisode.findMany as any).mockResolvedValue([open('a'), open('b')])
    vi.mocked(getFleetSnapshot).mockResolvedValue([
      { vehicleId: 'a', fuelProbeFault: false, fuelLevelMl: 61_000 },  // repaired: reads true
      { vehicleId: 'b', fuelProbeFault: false, fuelLevelMl: null },    // not known yet
    ] as never)
    await sweepSensorFaults('org_1')
    expect(published('sensorFault:close').map((c) => c.vehicleId)).toEqual(['a'])
  })
  it('leaves them all as they are when the snapshot cannot be read', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.sensorFaultEpisode.findMany as any).mockResolvedValue([open('a')])
    vi.mocked(getFleetSnapshot).mockRejectedValue(new Error('timeout'))
    await sweepSensorFaults('org_1')
    expect(published('sensorFault:close')).toEqual([])
  })
})
