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
import { Prisma }          from '../../../generated/prisma/client.js'
import { logger }          from '../../lib/logger.js'
import { env }             from '../../config/env.js'
import { getSimFleetVehicles } from '../../lib/sim-fleet.js'
import type { TelemetryProvider, VehicleTelemetryFrame, DoorStatus, NetworkType } from '../telemetry-provider.js'
import type { CtDeviceSnapshot }   from './controltech.types.js'
import { initVehicleState, tickVehicle, renderSnapshot, initSimClock, advanceSimClock, simNow } from './controltech.simulator.js'
import type { VehicleSimState, RoutingProfile } from './controltech.simulator.js'

// ─── normaliser — CtDeviceSnapshot → VehicleTelemetryFrame ────────────────
// Shared by both mock and future live adapters.

const DOOR_MAP: Record<0 | 1 | 2, DoorStatus> = { 0: 'CLOSED', 1: 'OPEN', 2: 'AJAR' }
const SPEED_LIMIT_KMH              = 100
const FUEL_INCONSISTENCY_THRESHOLD_ML = 30_000   // 30 L sudden drop = suspect
const LOW_FUEL_PCT                 = 0.20
const HIGH_ENGINE_TEMP_C           = 105          // °C — overheat threshold
const LOW_OIL_PCT                  = 10           // % — critically low oil

export function normaliseCtSnapshot(
  raw: CtDeviceSnapshot,
  tankCapacityMl: number,
): VehicleTelemetryFrame {
  const fuelUsedMl  = raw.fuel_used_ml ?? 0
  const fuelLevelMl = raw.fuel_level_ml ?? null

  // Sensor channels are powered by the engine — no alerts fire when engine is off.
  const engineOn = raw.engine_on === 1
  const flags = {
    overspeeding:        engineOn && raw.speed_kmh > SPEED_LIMIT_KMH,
    fuelInconsistency:   engineOn && fuelUsedMl < -FUEL_INCONSISTENCY_THRESHOLD_ML,
    doorOpenWhileMoving: engineOn && raw.door_state !== 0 && raw.speed_kmh > 5,
    lowFuel:             engineOn && fuelLevelMl != null && fuelLevelMl < tankCapacityMl * LOW_FUEL_PCT,
    engineIdling:        engineOn && raw.speed_kmh < 2,
    outsideGeofence:     engineOn && (raw as unknown as Record<string, unknown>)['_sim'] != null
                           ? Boolean(((raw as unknown as Record<string, unknown>)['_sim'] as Record<string, unknown>)['outsideFence'])
                           : false,
    lowBattery:          engineOn && raw.battery_v < 11.5,
    highEngineTemp:      engineOn && raw.engine_temp_c != null && raw.engine_temp_c > HIGH_ENGINE_TEMP_C,
    lowOil:              engineOn && raw.oil_level_pct != null && raw.oil_level_pct < LOW_OIL_PCT,
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
    engineTempC:        raw.engine_temp_c ?? null,
    oilLevelPct:        raw.oil_level_pct ?? null,
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

type SimEntry = VehicleSimState & { tankCapacityMl: number }

export class ControltechMockAdapter implements TelemetryProvider {
  readonly name = 'Controltech EA (mock)'

  /** deviceId → sim state; populated on first fetchAll() call */
  private states = new Map<string, SimEntry>()
  /** deviceId → owning organisation, captured at init for state persistence */
  private orgByDevice = new Map<string, string>()
  private initialised = false

  /**
   * Pre-load all vehicles from DB so we can simulate every registered device.
   *
   * Simulation state is persisted to `simulation_states` each cycle, so on a
   * fresh start we HYDRATE each device from its saved row and only cold-start
   * (initVehicleState) devices that have never run before. This is what makes
   * the simulation pause on stop and resume exactly where it left off.
   */
  private async init(): Promise<void> {
    // Only the live-simulation fleet is ticked — per-org compositions in
    // lib/sim-fleet; the rest of each org's vehicles remain in the DB but idle.
    const [allVehicles, saved, meta] = await Promise.all([
      getSimFleetVehicles(),
      prisma.simulationState.findMany(),
      prisma.simulationMeta.findUnique({ where: { id: 'singleton' }, select: { simClockMs: true } }),
    ])

    // SIM_ORGS (comma-separated org codes) restricts which orgs THIS instance
    // simulates — lets a dev server tick only newly added orgs while another
    // deployment keeps simulating the rest against the same DB, with no
    // double-writing. Unset = simulate every org in the composition. The
    // fleet SNAPSHOT is deliberately not filtered (see lib/sim-fleet).
    const simOrgs = env.SIM_ORGS
      ? new Set(env.SIM_ORGS.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))
      : null
    const vehicles = simOrgs ? allVehicles.filter(v => simOrgs.has(v.orgCode)) : allVehicles
    if (simOrgs) {
      logger.warn({ simOrgs: [...simOrgs], ticked: vehicles.length, excluded: allVehicles.length - vehicles.length },
        'SIM_ORGS set — simulating a subset of the fleet')
    }

    // Resume the sim clock from where it paused (or start at real "now").
    initSimClock(meta?.simClockMs != null ? Number(meta.simClockMs) : null)

    const savedByDevice = new Map(saved.map(r => [r.deviceId, r.state as unknown as SimEntry]))
    let hydrated = 0, coldStarted = 0

    vehicles.forEach((v, idx) => {
      this.orgByDevice.set(v.deviceId, v.organisationId)
      const tankLitres = v.tankCapacityLitres ?? 200
      const prior      = savedByDevice.get(v.deviceId)
      // Routing profile — which organisation's logistics cycle this vehicle
      // runs. Direct-delivery orgs use their own org code as the profile key
      // (see DIRECT_PROFILES in the simulator); anything unknown falls back to
      // the Sukari haulage cycle.
      const DIRECT_ORG_CODES = ['AQUAMIST', 'MENENGAI', 'TIMSALES', 'KABRAS'] as const
      const profile = (DIRECT_ORG_CODES as readonly string[]).includes(v.orgCode)
        ? (v.orgCode as RoutingProfile)
        : 'SUKARI' as const

      if (prior && typeof prior.lat === 'number') {
        // Resume: trust the persisted state, refresh derived tank capacity.
        // Defaults are spread FIRST and prior OVER them, so any field added to
        // VehicleSimState after this row was last persisted (e.g. the garage-
        // redirect / maintenanceResetOdoKm fields) gets a sane fallback
        // instead of `undefined` — otherwise the very next renderSnapshot()
        // throws on the missing field for every vehicle hydrated from an
        // older save.
        const defaults = initVehicleState(v.deviceId, idx, tankLitres, v.vehicleType, profile)
        // `profile` is pinned AFTER the prior spread — states persisted before
        // the org-aware fleet existed have no profile key (fine, defaults win),
        // but a stale/wrong persisted value must never override the vehicle's
        // actual organisation.
        this.states.set(v.deviceId, { ...defaults, ...prior, profile, tankCapacityMl: tankLitres * 1000 })
        hydrated++
      } else {
        const state = initVehicleState(v.deviceId, idx, tankLitres, v.vehicleType, profile)
        this.states.set(v.deviceId, { ...state, tankCapacityMl: tankLitres * 1000 })
        coldStarted++
      }
    })

    logger.info(
      { adapter: this.name, deviceCount: this.states.size, hydrated, coldStarted },
      'Controltech mock adapter initialised',
    )
    this.initialised = true
  }

  async fetchAll(): Promise<VehicleTelemetryFrame[]> {
    if (!this.initialised) await this.init()

    // Advance the sim clock once per cycle (before ticking) so all vehicles
    // share the same simulated time step.
    advanceSimClock()

    const frames: VehicleTelemetryFrame[] = []

    for (const state of this.states.values()) {
      try {
        tickVehicle(state)
        const raw   = renderSnapshot(state)
        const frame = normaliseCtSnapshot(raw, state.tankCapacityMl)
        frames.push(frame)
        // One-shot lifecycle events have now been copied into the frame; clear
        // them so each completed trip / theft / refuel is persisted exactly once
        // and never re-snapshotted to the DB on the next persist().
        state.eventTripCompleted       = null
        state.eventFuelTheft           = null
        state.eventRefuel             = null
        state.eventServiceCompleted    = null
        state.eventGarageVisitCompleted = null
      } catch (err) {
        logger.warn({ err, deviceId: state.deviceId }, 'Simulator tick failed — skipping device')
      }
    }

    // Snapshot the advanced state so a restart resumes from here. Fire-and-forget
    // so a slow DB never delays telemetry delivery to the poller.
    void this.persist()

    return frames
  }

  /**
   * Persist every device's current sim state in ONE bulk statement.
   *
   * A 100-row interactive transaction blows past the pooler's 5 s timeout, so
   * we use a single multi-row `INSERT … ON CONFLICT DO UPDATE` — one round trip,
   * no interactive transaction, negligible pool pressure per cycle.
   */
  async persist(): Promise<void> {
    if (this.states.size === 0) return
    const now = new Date()
    try {
      const rows = [...this.states.values()].map((s) => {
        const { tankCapacityMl: _tank, ...state } = s   // don't persist derived field
        return Prisma.sql`(${s.deviceId}, ${this.orgByDevice.get(s.deviceId) ?? null}, ${JSON.stringify(state)}::jsonb, ${now})`
      })
      await prisma.$executeRaw`
        INSERT INTO simulation_states (device_id, organisation_id, state, updated_at)
        VALUES ${Prisma.join(rows)}
        ON CONFLICT (device_id) DO UPDATE
          SET state           = EXCLUDED.state,
              organisation_id = EXCLUDED.organisation_id,
              updated_at      = EXCLUDED.updated_at
      `
      await prisma.$executeRaw`
        INSERT INTO simulation_meta (id, last_tick_at, sim_clock_ms) VALUES ('singleton', ${now}, ${BigInt(simNow())})
        ON CONFLICT (id) DO UPDATE SET last_tick_at = EXCLUDED.last_tick_at, sim_clock_ms = EXCLUDED.sim_clock_ms
      `
    } catch (err) {
      logger.warn({ err, adapter: this.name }, 'Failed to persist simulation state')
    }
  }
}
