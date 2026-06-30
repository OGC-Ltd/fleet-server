/**
 * Controltech EA adapter — mock implementation.
 *
 * Implements `TelemetryProvider` using the in-process simulator so the server
 * behaves identically to production without a live Controltech endpoint.
 *
 * ── Integrating the live Controltech API ──────────────────────────────────
 * Create `controltech-live.adapter.ts` next to this file:
 *
 *   export class ControltechLiveAdapter implements TelemetryProvider {
 *     readonly name = 'Controltech EA (live)'
 *     constructor(private readonly apiUrl: string, private readonly apiKey: string) {}
 *
 *     async fetchAll(): Promise<VehicleTelemetryFrame[]> {
 *       const res  = await fetch(`${this.apiUrl}/api/v2/devices/snapshot`, {
 *         headers: { 'X-Api-Key': this.apiKey },
 *       })
 *       const body = await res.json() as CtApiResponse
 *       return body.data.devices.map(normaliseCtSnapshot)
 *     }
 *   }
 *
 * Then in `src/lib/poller.ts` swap:
 *   new ControltechMockAdapter(vehicles)
 *   → new ControltechLiveAdapter(env.CONTROLTECH_URL, env.CONTROLTECH_KEY)
 * ─────────────────────────────────────────────────────────────────────────
 */

import { prisma }          from '../../lib/prisma.js'
import { logger }          from '../../lib/logger.js'
import type { TelemetryProvider, VehicleTelemetryFrame, DoorStatus, NetworkType } from '../telemetry-provider.js'
import type { CtDeviceSnapshot }   from './controltech.types.js'
import { initVehicleState, tickVehicle, renderSnapshot } from './controltech.simulator.js'
import type { VehicleSimState }    from './controltech.simulator.js'

// ─── normaliser — CtDeviceSnapshot → VehicleTelemetryFrame ────────────────
// Shared by both mock and future live adapters.

const DOOR_MAP: Record<0 | 1 | 2, DoorStatus> = { 0: 'CLOSED', 1: 'OPEN', 2: 'AJAR' }
const SPEED_LIMIT_KMH = 100
const FUEL_INCONSISTENCY_THRESHOLD_ML = 30_000   // 30 L sudden drop = suspect
const LOW_FUEL_PCT = 0.10

export function normaliseCtSnapshot(
  raw: CtDeviceSnapshot,
  tankCapacityMl: number,
): VehicleTelemetryFrame {
  const fuelUsedMl  = raw.fuel_used_ml ?? 0
  const fuelLevelMl = raw.fuel_level_ml ?? null

  const flags = {
    overspeeding:        raw.speed_kmh > SPEED_LIMIT_KMH,
    fuelInconsistency:   fuelUsedMl < -FUEL_INCONSISTENCY_THRESHOLD_ML,  // large negative delta
    doorOpenWhileMoving: raw.door_state !== 0 && raw.speed_kmh > 5,
    lowFuel:             fuelLevelMl != null && fuelLevelMl < tankCapacityMl * LOW_FUEL_PCT,
    engineIdling:        raw.engine_on === 1 && raw.speed_kmh < 2,
    outsideGeofence:     (raw as unknown as Record<string, unknown>)['_sim'] != null
                           ? Boolean(((raw as unknown as Record<string, unknown>)['_sim'] as Record<string, unknown>)['outsideFence'])
                           : false,
    lowBattery:          raw.battery_v < 11.5,
  }

  return {
    deviceId:           raw.device_id,
    capturedAt:         new Date(raw.timestamp_utc),
    lat:                raw.lat,
    lng:                raw.lng,
    altitudeM:          raw.altitude_m,
    headingDeg:         raw.heading_deg,
    accuracyM:          raw.gps_accuracy_m,
    speedKmh:           raw.speed_kmh,
    engineOn:           raw.engine_on === 1,
    fuelLevelMl,
    fuelUsedMl:         raw.fuel_used_ml,
    cargoWeightKg:      raw.cargo_weight_kg,
    batteryVoltageV:    raw.battery_v,
    doorStatus:         DOOR_MAP[raw.door_state] ?? 'UNKNOWN',
    panicButtonPressed: raw.panic === 1,
    gpsFixQuality:      raw.gps_fix,
    satelliteCount:     raw.sat_count,
    networkType:        raw.network as NetworkType,
    signalStrengthPct:  raw.signal_pct,
    flags,
    rawPayload: {
      vendor:       'Controltech EA',
      imei:         raw.imei,
      protocol:     'HTTPS/REST',
      io_inputs:    raw.io_inputs,
      io_outputs:   raw.io_outputs,
      odometer_km:  raw.odometer_km,
      _sim:         (raw as unknown as Record<string, unknown>)['_sim'],
    },
  }
}

// ─── mock adapter ─────────────────────────────────────────────────────────

export class ControltechMockAdapter implements TelemetryProvider {
  readonly name = 'Controltech EA (mock)'

  /** deviceId → sim state; populated on first fetchAll() call */
  private states = new Map<string, VehicleSimState & { tankCapacityMl: number }>()
  private initialised = false

  /** Pre-load all vehicles from DB so we can simulate every registered device. */
  private async init(): Promise<void> {
    const vehicles = await prisma.vehicle.findMany({
      select: { deviceId: true, tankCapacityLitres: true },
    })

    vehicles.forEach((v, idx) => {
      const tankLitres = v.tankCapacityLitres ?? 200
      const state      = initVehicleState(v.deviceId, idx, tankLitres)
      this.states.set(v.deviceId, { ...state, tankCapacityMl: tankLitres * 1000 })
    })

    logger.info(
      { adapter: this.name, deviceCount: this.states.size },
      'Controltech mock adapter initialised',
    )
    this.initialised = true
  }

  async fetchAll(): Promise<VehicleTelemetryFrame[]> {
    if (!this.initialised) await this.init()

    const frames: VehicleTelemetryFrame[] = []

    for (const state of this.states.values()) {
      try {
        tickVehicle(state)
        const raw   = renderSnapshot(state)
        const frame = normaliseCtSnapshot(raw, state.tankCapacityMl)
        frames.push(frame)
      } catch (err) {
        logger.warn({ err, deviceId: state.deviceId }, 'Simulator tick failed — skipping device')
      }
    }

    return frames
  }
}
