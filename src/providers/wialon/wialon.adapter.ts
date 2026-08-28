/**
 * Wialon Hosting → `TelemetryProvider` (live positions for KASULU).
 *
 * Plugs into the existing poller unchanged: `startPoller(new WialonLiveAdapter())`.
 * Everything downstream — persistence, SSE, the map — is provider-agnostic.
 *
 * ## Deltas, with a periodic full reconcile
 *
 * At a fast cadence (POLL_INTERVAL_MS, 2 s in production) refetching all 224
 * units every tick would be enormously wasteful, so the normal path is
 * `avl_evts`: subscribe once via `core/update_data_flags`, then each call
 * returns only what changed. That loop also keeps the session alive, which
 * Wialon drops after roughly five minutes idle.
 *
 * `avl_evts` returns strictly what the session is subscribed to, so a wrong or
 * lost subscription shows up as silence rather than an error. To make that
 * survivable, a full `search_items` sweep still runs every RECONCILE_EVERY_MS:
 * it re-subscribes, picks up units that never emitted an event, and doubles as
 * the recovery path after a session lapse.
 *
 * ## Only genuinely new fixes are emitted
 *
 * `pos.t` advances only when the device actually reports. Emitting every unit
 * every cycle would write ~224 duplicate telemetry rows every 30 s (~40 k/hour
 * of noise) and would make dormant vehicles look like they were reporting
 * continuously. So a frame is produced only when a unit's fix timestamp has
 * moved forward since the last cycle — which is also what keeps `capturedAt`
 * honest.
 */

import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'
import type { TelemetryProvider, VehicleTelemetryFrame } from '../telemetry-provider.js'
import { WialonClient, type WialonPosition } from './wialon.client.js'
import { readFuel, readIgnition, readFuelProbeFault, readCamera, type FuelProbeFault, type CameraState } from './wialon.sensors.js'
import { noteConnection, connectionCounts } from '../../lib/connection-state.js'

/** Mirrors sync-wialon.ts — the device key a Wialon unit is registered under. */
export const wialonDeviceId = (unitId: number): string => `wialon:${unitId}`

export class WialonLiveAdapter implements TelemetryProvider {
  readonly name = 'Wialon Hosting (live)'

  private readonly client: WialonClient
  /** unitId → last emitted fix time (unix seconds). */
  private readonly lastFixAt = new Map<number, number>()
  private initialised = false

  /** unitId → name, for the raw payload. Refreshed on each full reconcile. */
  private unitNames = new Map<number, string>()

  /**
   * unitId → last calibrated fuel reading, in millilitres.
   *
   * Fuel comes from the unit's sensors and the last message's raw parameters,
   * which only the full `search_items` sweep returns — an `avl_evts` delta
   * carries position alone. Since the fleet snapshot reads the NEWEST
   * telemetry row, emitting null on every delta would blank the fuel gauge two
   * seconds after each reconcile refreshed it. The last known reading is
   * therefore carried forward, which is ordinary last-known-value telemetry
   * semantics: it is a real measurement, at most one reconcile interval old.
   */
  private lastFuelMl = new Map<number, number>()

  /**
   * unitId → the probe's fault, while it has one. Carried forward between
   * reconciles exactly like the reading above, and for the same reason: the
   * sensor data it is derived from only arrives on the full sweep.
   *
   * Presence in this map IS the fault state, so the entry must be DELETED the
   * moment a probe reads sanely again — a stale entry would keep reporting a
   * fault on a repaired unit for as long as the process lived.
   */
  private lastProbeFault = new Map<number, FuelProbeFault>()

  /**
   * unitId → total mileage (km) from Wialon's own counter. Carried forward for
   * the same reason as fuel: counters arrive only on the full reconcile, and
   * the snapshot reads the newest row.
   */
  private lastOdometerKm = new Map<number, number>()

  /** unitId → engine-hours counter. Carried forward like fuel and mileage. */
  private lastEngineHours = new Map<number, number>()

  /**
   * unitId → last known ignition state.
   *
   * Carried forward for the same reason as fuel: the sensor's parameter lives
   * in the unit's last message, which only the full `search_items` sweep
   * returns — an `avl_evts` delta carries position alone. Without carrying it,
   * ignition would blink to unknown two seconds after every reconcile.
   */
  private lastIgnition = new Map<number, boolean>()
  /**
   * Last known recorder state per unit. Only ever populated for units that
   * HAVE one — one of 1,496 here — so this map stays effectively empty and
   * costs nothing on the units that will never fill it.
   */
  private lastCamera = new Map<number, CameraState>()

  /**
   * A full `search_items` sweep runs on init and then periodically, so a unit
   * that never emits an event (new device, missed subscription, session
   * re-established) still gets picked up. Between sweeps `avl_evts` carries
   * the deltas — the whole point of the fast cadence.
   */
  private lastReconcileAt = 0
  private static readonly RECONCILE_EVERY_MS = 2 * 60_000
  /** How often to re-read connection state on its own. See refreshConnections. */
  private static readonly CONNECTION_EVERY_MS = 30_000
  private lastConnectionAt = 0

  constructor(
    token: string = env.WIALON_TOKEN || process.env['access_token'] || '',
    baseUrl: string = env.WIALON_API_URL,
  ) {
    this.client = new WialonClient(token, baseUrl)
  }

  private async init(): Promise<void> {
    await this.client.login()
    // Wialon renders report dates in the account's locale; the raw `pos.t`
    // values this adapter uses are unix seconds and unaffected.
    await this.client.setLocale().catch(() => { /* cosmetic only */ })
    this.initialised = true
  }

  async fetchAll(): Promise<VehicleTelemetryFrame[]> {
    if (!this.initialised) await this.init()

    const dueReconcile = Date.now() - this.lastReconcileAt >= WialonLiveAdapter.RECONCILE_EVERY_MS
    if (dueReconcile) return this.reconcileAll()

    // Connection state on its own, faster cadence than the sweep. Awaited
    // rather than fired and forgotten so two refreshes can never overlap, and
    // never fatal — a failed refresh just leaves the previous verdict, which
    // lib/connection-state ages out on its own.
    await this.refreshConnections()
    return this.pollDeltas()
  }

  /**
   * Re-read every unit's `netconn`.
   *
   * The full sweep also carries this, but only every RECONCILE_EVERY_MS, and
   * connection state is the field that goes stale fastest — cross-checked
   * against Wialon, ~7% of units had flipped within one 2-minute sweep
   * window. This call is ~145× smaller than the sweep (19 KB vs 2.7 MB), so
   * running it far more often is close to free.
   */
  private async refreshConnections(): Promise<void> {
    if (Date.now() - this.lastConnectionAt < WialonLiveAdapter.CONNECTION_EVERY_MS) return
    this.lastConnectionAt = Date.now()
    try {
      for (const u of await this.client.listConnectionStates()) {
        if (typeof u.netconn === 'number') noteConnection(wialonDeviceId(u.id), u.netconn === 1)
      }
    } catch (err) {
      logger.warn({ err }, 'Wialon connection-state refresh failed — keeping the previous verdict')
    }
  }

  /**
   * Full sweep: every unit's last-known position, and re-subscribe so
   * `avl_evts` keeps delivering. Also the recovery path — if the session
   * lapsed, the client re-authenticates and the subscription is rebuilt here.
   */
  private async reconcileAll(): Promise<VehicleTelemetryFrame[]> {
    const units = await this.client.listUnits()
    this.lastReconcileAt = Date.now()
    // The sweep carries netconn too, so the standalone refresh restarts its
    // clock from here rather than firing again moments later.
    this.lastConnectionAt = Date.now()

    const frames: VehicleTelemetryFrame[] = []
    let unchanged = 0, neverReported = 0

    for (const u of units) {
      this.unitNames.set(u.id, u.nm)

      // Wialon's own connection verdict, recorded for EVERY unit — this must
      // happen before the `!u.pos` and unchanged-fix skips below, because an
      // offline unit is precisely one that emits no frame, and it is the one
      // whose connection state we most need. See lib/connection-state.
      // Keyed by the SAME deviceId the Vehicle row carries (`wialon:<id>`),
      // not the bare unit id — that is what the snapshot looks up.
      if (typeof u.netconn === 'number') {
        noteConnection(wialonDeviceId(u.id), u.netconn === 1)
      }

      // Calibrated fuel from the probe's own table — see wialon.sensors.
      const fuel = readFuel(u.sens, u.lmsg?.p)
      if (fuel) this.lastFuelMl.set(u.id, Math.round(fuel.litres * 1000))
      // Why there is no reading, when there is none. Set AND cleared every
      // sweep so a repaired probe stops reporting a fault; see lastProbeFault.
      const probeFault = readFuelProbeFault(u.sens, u.lmsg?.p)
      if (probeFault) {
        const prev = this.lastProbeFault.get(u.id)
        this.lastProbeFault.set(u.id, probeFault)
        if (!prev) {
          logger.warn(
            { unit: u.nm, raw: probeFault.raw, calibratedMax: probeFault.calibratedMax, reason: probeFault.reason },
            'Fuel probe reporting outside its calibrated range — no level available',
          )
        }
      } else {
        this.lastProbeFault.delete(u.id)
      }
      // Ignition (`engine operation` → io_239). Present on 222/224 units and
      // the only way to distinguish idling from parked.
      const ign = readIgnition(u.sens, u.lmsg?.p)
      if (ign !== null) this.lastIgnition.set(u.id, ign)
      // On-board recorder, where one is fitted. Held per unit like every other
      // sensor read, because a frame is only emitted when the unit MOVES and
      // the camera state must not be lost on the pings in between.
      const cam = readCamera(u.sens, u.lmsg?.p)
      if (cam.hasCamera) this.lastCamera.set(u.id, cam)
      // Wialon's own mileage counter — the vehicle's running total.
      if (typeof u.cnm_km === 'number' && u.cnm_km > 0) this.lastOdometerKm.set(u.id, u.cnm_km)
      // Engine hours matter more than distance for plant and tractors, which
      // work without travelling far.
      if (typeof u.cneh === 'number' && u.cneh > 0) this.lastEngineHours.set(u.id, u.cneh)

      if (!u.pos) { neverReported++; continue }

      const seen = this.lastFixAt.get(u.id)
      // First sight of a unit still emits, so a restart re-seeds the map from
      // the last known position rather than waiting for the device to move.
      if (seen != null && u.pos.t <= seen) { unchanged++; continue }
      this.lastFixAt.set(u.id, u.pos.t)

      const frame = toFrame(u.id, u.nm, u.pos, this.lastFuelMl.get(u.id) ?? null, this.lastOdometerKm.get(u.id) ?? null, this.lastEngineHours.get(u.id) ?? null, this.lastIgnition.get(u.id) ?? null, this.lastProbeFault.has(u.id), this.lastCamera.get(u.id) ?? null)
      if (frame) frames.push(frame)
    }

    // A subscription only lives as long as the session, so renew it here.
    await this.client.subscribePositions(units.map(u => u.id)).catch(err =>
      logger.warn({ err }, 'Wialon position subscription failed — deltas may be empty until the next reconcile'))

    logger.debug(
      { provider: this.name, mode: 'reconcile', units: units.length, moved: frames.length, unchanged, neverReported,
        connection: connectionCounts() },
      'Wialon poll',
    )
    return frames
  }

  /** Fast path: only what changed since the last call. */
  private async pollDeltas(): Promise<VehicleTelemetryFrame[]> {
    const events = await this.client.pollEvents()
    const frames: VehicleTelemetryFrame[] = []
    let unchanged = 0

    for (const { unitId, pos } of events) {
      const seen = this.lastFixAt.get(unitId)
      if (seen != null && pos.t <= seen) { unchanged++; continue }
      this.lastFixAt.set(unitId, pos.t)

      const frame = toFrame(unitId, this.unitNames.get(unitId) ?? String(unitId), pos, this.lastFuelMl.get(unitId) ?? null, this.lastOdometerKm.get(unitId) ?? null, this.lastEngineHours.get(unitId) ?? null, this.lastIgnition.get(unitId) ?? null, this.lastProbeFault.has(unitId), this.lastCamera.get(unitId) ?? null)
      if (frame) frames.push(frame)
    }

    if (frames.length > 0 || unchanged > 0) {
      logger.debug(
        { provider: this.name, mode: 'delta', events: events.length, moved: frames.length, unchanged },
        'Wialon poll',
      )
    }
    return frames
  }
}

/**
 * One Wialon unit → one telemetry frame.
 *
 * Only what Wialon actually provides is filled in. Fuel, cargo, door state,
 * battery, engine temperature and oil are NOT in the position payload, so they
 * stay null rather than being invented — the dashboard renders "—" for them.
 */
function toFrame(
  unitId: number,
  unitName: string,
  p: WialonPosition | null | undefined,
  fuelLevelMl: number | null,
  odometerKm: number | null,
  engineHours: number | null,
  ignitionOn: boolean | null,
  fuelProbeFault: boolean,
  camera: CameraState | null,
): VehicleTelemetryFrame | null {
  if (!p || !Number.isFinite(p.y) || !Number.isFinite(p.x)) return null
  // A frame without a usable timestamp is unwritable (capturedAt is part of
  // the telemetry key) — reject it here rather than at the database.
  const capturedAt = new Date((p.t ?? NaN) * 1000)
  if (Number.isNaN(capturedAt.getTime())) return null

  const speedKmh = p.s ?? null

  return {
    deviceId:   wialonDeviceId(unitId),
    // `pos.t` is unix SECONDS, and it is the moment the DEVICE reported —
    // never "now". A nine-day-old fix must stay nine days old.
    capturedAt,

    lat:        p.y,
    lng:        p.x,
    altitudeM:  p.z ?? null,
    headingDeg: p.c ?? null,
    accuracyM:  null,

    speedKmh,
    // Real ignition when the unit reports one (`engine operation` → io_239,
    // fitted on 222/224 units). Only where it is genuinely unknown does this
    // fall back to the old speed heuristic — which cannot see idling at all,
    // since it makes "engine on" and "moving" the same signal.
    engineOn:   ignitionOn ?? ((speedKmh ?? 0) > 0),
    // Whether that was a reading or a guess. `readIgnition` returns null when
    // the unit has no usable ignition line, and on this fleet that is most of
    // them — 78% of fuel falls carry no measured engine state.
    ignitionKnown:    ignitionOn !== null,
    engineHoursMeter: engineHours,

    // Calibrated probe reading; null when the unit has no fuel sensor or no
    // calibration table — never a raw ADC value.
    fuelLevelMl,
    fuelUsedMl:         null,
    cargoWeightKg:      null,
    batteryVoltageV:    null,
    doorStatus:         'UNKNOWN',
    panicButtonPressed: false,
    gpsFixQuality:      null,
    satelliteCount:     p.sc ?? null,
    networkType:        null,
    signalStrengthPct:  null,
    engineTempC:        null,
    oilLevelPct:        null,

    // Every flag needs an input we do not have from this payload: there are no
    // per-unit speed limits, fuel readings or door channels here. Raising them
    // on guesses would fabricate alerts. Wialon's own Notifications are the
    // correct source for speeding/geofence events — it computes them against
    // real per-unit limits and can POST them to /webhook/rai.
    //
    // fuelProbeFault is the exception, and legitimately so: it is not inferred
    // from the position payload at all but measured off the unit's own sensor
    // config during the reconcile sweep, then carried in alongside the fuel
    // reading it explains the absence of.
    flags: {
      overspeeding:        false,
      fuelInconsistency:   false,
      doorOpenWhileMoving: false,
      lowFuel:             false,
      engineIdling:        false,
      outsideGeofence:     false,
      lowBattery:          false,
      highEngineTemp:      false,
      lowOil:              false,
      fuelProbeFault,
      // Omitted entirely rather than set to a false-y object on the 1,495 units
      // with no recorder — see the field's note in telemetry-provider.
      ...(camera?.hasCamera
        ? { camera: {
              hasCamera:  true,
              streamUrl:  camera.streamUrl,
              recording:  camera.recording,
              signalLost: camera.signalLost,
            } }
        : {}),
    },

    // odometer_km rides in the raw payload because that is where the fleet
    // snapshot reads it from (telemetry.repository's LATERAL join).
    // `ignition_known` lets consumers distinguish a measured engine state from
    // the speed-derived fallback — idling can only be claimed for the former.
    rawPayload: { source: 'wialon', unitId, name: unitName, pos: p, odometer_km: odometerKm, engine_hours: engineHours, ignition_known: ignitionOn !== null },
  }
}
