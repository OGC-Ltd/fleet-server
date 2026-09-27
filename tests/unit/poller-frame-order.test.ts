/**
 * The poller and a cycle carrying several frames for one vehicle.
 *
 * Wialon deltas now arrive one frame per message, so a single cycle can hold a
 * run of fixes for one unit. Everything per vehicle downstream — the fuel and
 * speed watchers, the alert edges, the dashboard marker — reads them as a
 * sequence, so one vehicle's frames must be handled one at a time, oldest
 * first, while different vehicles still run side by side.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/modules/ingest/ingest.service.js', () => ({ processTelemetry: vi.fn() }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { processTelemetry } from '../../src/modules/ingest/ingest.service.js'
import { startPoller, framesByDevice, type PollerHandle } from '../../src/lib/poller.js'
import type { TelemetryProvider, VehicleTelemetryFrame } from '../../src/providers/telemetry-provider.js'

const T0 = Date.parse('2026-09-27T08:00:00Z')

const frame = (deviceId: string, atS: number): VehicleTelemetryFrame => ({
  deviceId, capturedAt: new Date(T0 + atS * 1000),
  lat: -8.6, lng: 35.3, altitudeM: null, headingDeg: null, accuracyM: null,
  speedKmh: 12, engineOn: true, ignitionKnown: true, engineHoursMeter: null, accelG: null,
  fuelLevelMl: 50_000, fuelUsedMl: null, cargoWeightKg: null, batteryVoltageV: null,
  doorStatus: 'UNKNOWN', panicButtonPressed: false, gpsFixQuality: null, satelliteCount: null,
  networkType: null, signalStrengthPct: null, engineTempC: null, oilLevelPct: null,
  flags: {
    overspeeding: false, fuelInconsistency: false, doorOpenWhileMoving: false, lowFuel: false,
    engineIdling: false, outsideGeofence: false, lowBattery: false, highEngineTemp: false, lowOil: false,
  },
  rawPayload: { source: 'test' },
} as VehicleTelemetryFrame)

const at = (f: VehicleTelemetryFrame) => `${f.deviceId}@${(f.capturedAt.getTime() - T0) / 1000}`

describe('framesByDevice', () => {
  it('groups a cycle per device, each oldest first, devices in the order they first appear', () => {
    const groups = framesByDevice([frame('w:1', 60), frame('w:2', 10), frame('w:1', 30), frame('w:1', 90), frame('w:2', 5)])
    expect(groups.map(g => g.map(at))).toEqual([['w:1@30', 'w:1@60', 'w:1@90'], ['w:2@5', 'w:2@10']])
  })

  it('keeps the provider order for frames at the same instant', () => {
    const a = frame('w:1', 30), b = frame('w:1', 30)
    const [group] = framesByDevice([a, b])
    expect(group![0]).toBe(a)
    expect(group![1]).toBe(b)
  })
})

describe('TelemetryPoller — one vehicle at a time', () => {
  let handle: PollerHandle | null = null
  afterEach(() => { handle?.stop(); handle = null })

  it("handles one vehicle's frames in turn, oldest first, and other vehicles alongside", async () => {
    prismaMock.vehicle.findMany.mockResolvedValue([1, 2].map(n => ({
      deviceId: `w:${n}`, organisationId: 'org_1', id: `veh_${n}`, name: `V${n}`,
      registrationPlate: `P${n}`, tankCapacityLitres: 100, vehicleType: null, assignments: [],
    })) as never)

    // The first fix of w:1 is the slowest write of the cycle: run side by side,
    // its later fixes would finish first.
    const delayMs: Record<string, number> = { 'w:1@30': 40, 'w:1@60': 1, 'w:1@90': 1, 'w:2@10': 5, 'w:2@20': 1 }
    const started: string[] = [], finished: string[] = []
    const inFlight = new Map<string, number>()
    let overlapped = false, bothVehiclesAtOnce = false
    vi.mocked(processTelemetry).mockImplementation(async (_org, dto) => {
      const key = `${dto.deviceId}@${(dto.capturedAt.getTime() - T0) / 1000}`
      started.push(key)
      const n = (inFlight.get(dto.deviceId) ?? 0) + 1
      inFlight.set(dto.deviceId, n)
      if (n > 1) overlapped = true
      if ((inFlight.get('w:1') ?? 0) > 0 && (inFlight.get('w:2') ?? 0) > 0) bothVehiclesAtOnce = true
      await new Promise(r => setTimeout(r, delayMs[key] ?? 1))
      inFlight.set(dto.deviceId, n - 1)
      finished.push(key)
      return 1n
    })

    const provider: TelemetryProvider = {
      name: 'test provider',
      fetchAll: vi.fn()
        .mockResolvedValueOnce([frame('w:1', 60), frame('w:1', 30), frame('w:2', 10), frame('w:1', 90), frame('w:2', 20)])
        .mockResolvedValue([]),
    }
    handle = startPoller(provider, { intervalMs: 3_600_000 })
    await vi.waitFor(() => expect(finished).toHaveLength(5), { timeout: 2_000 })

    expect(finished.filter(k => k.startsWith('w:1'))).toEqual(['w:1@30', 'w:1@60', 'w:1@90'])
    expect(finished.filter(k => k.startsWith('w:2'))).toEqual(['w:2@10', 'w:2@20'])
    expect(overlapped).toBe(false)
    expect(bothVehiclesAtOnce).toBe(true)
  })
})
