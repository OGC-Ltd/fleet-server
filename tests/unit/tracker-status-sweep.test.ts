/**
 * The tracker's status codes as fault records (operator, 2026-11-27): carried once they have lasted
 * 10 minutes, opened from when they began, closed only on the tracker's word that the sensor is
 * healthy again.
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
import { sweepSensorFaults, trackerStatusStates } from '../../src/modules/telemetry/sensor-fault-sweep.service.js'
import { trackerStatusCarried, TRACKER_STATUS_MIN_S } from '../../src/providers/wialon/wialon.adapter.js'
import { PROBE_FAULT_KINDS } from '../../src/modules/reports/range-reports.service.js'

const published = (topic: string) => vi.mocked(eventBus.publish).mock.calls.filter((c) => c[0] === topic).map((c) => c[1] as { vehicleId: string; kind: string; detail?: string; startedAt?: Date })
const SINCE = '2026-11-27T05:00:00.000Z'

beforeEach(() => {
  env.INCIDENT_CAPTURE_ENABLED = true
  vi.mocked(eventBus.publish).mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.sensorFaultEpisode.findMany as any).mockResolvedValue([])
  vi.mocked(getFleetSnapshot).mockResolvedValue([] as never)
})

describe('what the adapter carries', () => {
  const now = Date.parse('2026-11-27T06:00:00Z') / 1000
  const held = new Map([
    ['fuel_probe_status', { since: now - TRACKER_STATUS_MIN_S, reason: 'Fuel probe: Status Error', raw: 3 }],
    ['gnss_fault', { since: now - TRACKER_STATUS_MIN_S + 1, reason: 'GPS: On without Fix', raw: 2 }],
  ] as const)
  it('a fault from 10 minutes on, with when it began; a younger one not yet', () => {
    const c = trackerStatusCarried(new Map(held), new Set(['fuel_probe_battery'] as const), now)
    expect(c.trackerFaults).toEqual([{ kind: 'fuel_probe_status', reason: 'Fuel probe: Status Error', raw: 3, since: new Date((now - 600) * 1000).toISOString() }])
    expect(c.trackerOk).toEqual(['fuel_probe_battery'])
  })
  it('nothing for a unit without status sensors', () => {
    expect(trackerStatusCarried(undefined, undefined, now)).toEqual({ trackerFaults: [], trackerOk: [] })
  })
})

describe('the snapshot as fault states', () => {
  it('keeps only the three kinds, with their start', () => {
    const s = trackerStatusStates([
      { vehicleId: 'v1', trackerFaults: [{ kind: 'fuel_probe_status', reason: 'Fuel probe: Status Error', raw: 3, since: SINCE }, { kind: 'other', reason: 'x' }], trackerOk: ['gnss_fault', 'nonsense'] },
      { vehicleId: 'v2' },
    ])
    expect(s.faulty.get('v1')).toEqual([{ kind: 'fuel_probe_status', reason: 'Fuel probe: Status Error', raw: 3, since: new Date(SINCE) }])
    expect([...s.healthy.get('v1')!]).toEqual(['gnss_fault'])
    expect(s.faulty.has('v2')).toBe(false)
  })
})

describe('the sweep', () => {
  it('opens a record from when the fault began, in the tracker’s words', async () => {
    vi.mocked(getFleetSnapshot).mockResolvedValue([{ vehicleId: 'v1', trackerFaults: [{ kind: 'gnss_fault', reason: 'GPS: On without Fix', raw: 2, since: SINCE }] }] as never)
    await sweepSensorFaults('org')
    expect(published('sensorFault:open')).toMatchObject([{ vehicleId: 'v1', kind: 'gnss_fault', detail: 'GPS: On without Fix', startedAt: new Date(SINCE) }])
  })
  it('closes it once the tracker shows the sensor healthy, and not before', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.sensorFaultEpisode.findMany as any).mockResolvedValue([{ id: 'e1', vehicleId: 'v1', kind: 'fuel_probe_status' }, { id: 'e2', vehicleId: 'v2', kind: 'fuel_probe_battery' }])
    vi.mocked(getFleetSnapshot).mockResolvedValue([{ vehicleId: 'v1', trackerOk: ['fuel_probe_status'] }, { vehicleId: 'v2' }] as never)
    await sweepSensorFaults('org')
    expect(published('sensorFault:close').map((c) => [c.vehicleId, c.kind])).toEqual([['v1', 'fuel_probe_status']])
  })
  it('leaves open records alone when the snapshot cannot be read', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.sensorFaultEpisode.findMany as any).mockResolvedValue([{ id: 'e1', vehicleId: 'v1', kind: 'gnss_fault' }])
    vi.mocked(getFleetSnapshot).mockRejectedValue(new Error('down'))
    await sweepSensorFaults('org')
    expect(published('sensorFault:close')).toEqual([])
  })
})

describe('the Fuel Consumption Rate note', () => {
  it('counts a probe status fault, not a low probe battery', () => {
    expect(PROBE_FAULT_KINDS).toContain('fuel_probe_status')
    expect(PROBE_FAULT_KINDS).not.toContain('fuel_probe_battery')
  })
})
