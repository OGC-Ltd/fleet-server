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
 * ## Every message read, at the time the tracker recorded it
 *
 * Trackers record every few seconds and upload in batches, so one `avl_evts`
 * call can carry several messages for one unit, recorded over the last minute
 * or two — or a backlog of days from a tracker back in coverage. Every message
 * is read, fuel, ignition and all, and a frame is stamped with its message's
 * own time (WialonClient.messageTime) and carries that message's readings.
 *
 * Until 2026-09-27 a batch's messages all took Wialon's batch time, so only
 * the first became a row — stamped when it arrived rather than when it was
 * true, with a fuel level up to a sweep old. Over nine live minutes that left
 * a third of positioned messages without a row, and delta rows stamped up to
 * 14 minutes late at p99; a backlog replayed three-day-old positions as the
 * present.
 *
 * A fix is stored as its own row MIN_ROW_GAP_S after the unit's last one, or
 * as soon as the engine or the motion changes — see MIN_ROW_GAP_S.
 *
 * ## Only genuinely new fixes are emitted
 *
 * A message's time advances only when the device actually reports. Emitting
 * every unit every cycle would write ~224 duplicate telemetry rows every 30 s
 * (~40 k/hour of noise) and would make dormant vehicles look like they were
 * reporting continuously. So a frame is produced only for a fix newer than the
 * unit's last one — which is also what keeps `capturedAt` honest.
 */

import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'
import type { AccelAxes, TelemetryProvider, VehicleTelemetryFrame } from '../telemetry-provider.js'
import { WialonClient, type WialonPosition } from './wialon.client.js'
import {
  readFuel, readIgnition, readFuelProbeFault, readCamera, readAccelerometer, readVoltages, type SupplyVolts, carriesFuelReading, hasFuelSensor,
  type FuelProbeFault, type CameraState, type WialonSensor, readHarshDriving,
} from './wialon.sensors.js'
import { eventBus } from '../../lib/event-bus.js'
import { noteConnection, connectionCounts } from '../../lib/connection-state.js'

/** Mirrors sync-wialon.ts — the device key a Wialon unit is registered under. */
export const wialonDeviceId = (unitId: number): string => `wialon:${unitId}`

/**
 * Least time between two stored fixes of one unit, seconds — unless the engine
 * started or stopped, or the unit started or stopped moving, in between.
 *
 * Trackers record far more often than anything downstream reads: against
 * Wialon's own history for 80 units over two daytime hours on 2026-09-26, a
 * quarter of messages came within 2–4 s of the one before. A row for every
 * message would be 1.6–1.8× the rows written today, on an RDS instance with
 * 1 GB of memory, and would quietly shorten every rule that counts frames —
 * `OVERSPEED_MIN_FRAMES` is three frames, not a duration. At 15 s, keeping
 * every ignition flip and every start and stop, it measured 0.99–1.09× today's
 * volume: the same rows, now each at its true time with its own readings.
 *
 * A message that does not earn a row still counts: its fuel and ignition are
 * read into the state the unit's next row carries.
 */
export const MIN_ROW_GAP_S = 15

export class WialonLiveAdapter implements TelemetryProvider {
  readonly name = 'Wialon Hosting (live)'

  private readonly client: WialonClient
  /**
   * unitId → newest fix time handled (unix seconds), whether it became a row
   * or was thinned out. Nothing at or before it is emitted again — and the
   * sweep reads it to tell that the events already covered a unit.
   */
  private readonly lastFixAt = new Map<number, number>()
  /** unitId → the unit's last stored fix: when, whether it was moving, its ignition. See MIN_ROW_GAP_S. */
  private readonly lastRow = new Map<number, { t: number; moving: boolean; ignitionOn: boolean | null }>()
  private initialised = false

  /** unitId → name, for the raw payload. Refreshed on each full reconcile. */
  private unitNames = new Map<number, string>()

  /**
   * unitId → the unit's configured sensors, from the last sweep — the only
   * call that returns them. Each message's raw parameters are read against
   * these, the sweep's and every delta's alike.
   */
  private readonly sensors = new Map<number, Record<string, WialonSensor>>()

  /**
   * unitId → time (unix seconds) of the newest message whose readings the
   * state below holds. Readings are taken in message order and once each: a
   * message no newer than this is not read again, so neither a late delivery
   * nor the sweep re-reading a message the deltas already had can wind a
   * reading back.
   */
  private readonly lastReadAt = new Map<number, number>()

  /**
   * unitId → last calibrated fuel reading, in millilitres.
   *
   * Read from each message's raw parameters against the unit's sensors — the
   * sweep's last message and every delta's. A message that carries no reading
   * of the probe leaves it as it was, and since the fleet snapshot reads the
   * NEWEST telemetry row, emitting null on such a frame would blank the fuel
   * gauge. The last known reading is therefore carried forward, which is
   * ordinary last-known-value telemetry semantics: a real measurement, from
   * this unit's latest message that had one.
   */
  private lastFuelMl = new Map<number, number>()

  /**
   * unitId → the probe's fault, while it has one. Read and carried forward
   * exactly like the reading above.
   *
   * Presence in this map IS the fault state, so the entry must be DELETED the
   * moment a probe reads sanely again — a stale entry would keep reporting a
   * fault on a repaired unit for as long as the process lived. A message
   * without the probe's parameter proves neither, so it leaves the entry be.
   */
  private lastProbeFault = new Map<number, FuelProbeFault>()

  /**
   * unitId → total mileage (km) from Wialon's own counter. Carried forward:
   * counters are unit properties, returned only by the full reconcile, and the
   * snapshot reads the newest row.
   */
  private lastOdometerKm = new Map<number, number>()

  /** unitId → engine-hours counter. Carried forward like mileage. */
  private lastEngineHours = new Map<number, number>()

  /**
   * unitId → last known ignition state.
   *
   * Read per message like fuel, and carried forward across messages that do
   * not carry it — without that, ignition would blink to unknown on them.
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

    // What each unit IS, before any of its messages is read: the drain below
    // reads fuel against these sensors.
    for (const u of units) {
      this.unitNames.set(u.id, u.nm)
      if (u.sens && typeof u.sens === 'object') this.sensors.set(u.id, u.sens)

      // Wialon's own connection verdict, recorded for EVERY unit — this must
      // happen before the `!u.pos` and unchanged-fix skips below, because an
      // offline unit is precisely one that emits no frame, and it is the one
      // whose connection state we most need. See lib/connection-state.
      // Keyed by the SAME deviceId the Vehicle row carries (`wialon:<id>`),
      // not the bare unit id — that is what the snapshot looks up.
      if (typeof u.netconn === 'number') {
        noteConnection(wialonDeviceId(u.id), u.netconn === 1)
      }

      // Wialon's own mileage counter — the vehicle's running total.
      if (typeof u.cnm_km === 'number' && u.cnm_km > 0) this.lastOdometerKm.set(u.id, u.cnm_km)
      // Engine hours matter more than distance for plant and tractors, which
      // work without travelling far.
      if (typeof u.cneh === 'number' && u.cneh > 0) this.lastEngineHours.set(u.id, u.cneh)
    }

    // Everything the event queue holds, BEFORE the sweep's own frames. The
    // sweep sees a unit's newest fix the moment Wialon has it, while the
    // messages the tracker sent alongside it may still be waiting in the
    // queue; a sweep frame at the newest fix would make each of them look
    // stale, and they would never get a row. Drained first, they do, and the
    // sweep only fills in where the events have nothing — a unit that never
    // emitted one, or a subscription that lapsed.
    let frames: VehicleTelemetryFrame[] = []
    try {
      frames = await this.pollDeltas()
    } catch (err) {
      logger.warn({ err }, 'Wialon event drain before the sweep failed — the sweep stands in')
    }
    const drained = frames.length

    let unchanged = 0, neverReported = 0
    for (const u of units) {
      // The unit's last message — unless a delta already read it, or a newer one.
      this.noteReadings(u.id, u.lmsg?.t, u.lmsg?.p, u.lmsg?.t === u.pos?.t ? u.pos : null)
      // On-board recorder, where one is fitted. Held per unit like every other
      // sensor read, because a frame is only emitted when the unit MOVES and
      // the camera state must not be lost on the pings in between.
      const cam = readCamera(u.sens, u.lmsg?.p)
      if (cam.hasCamera) this.lastCamera.set(u.id, cam)

      if (!u.pos) { neverReported++; continue }

      const seen = this.lastFixAt.get(u.id)
      // First sight of a unit still emits, so a restart re-seeds the map from
      // the last known position rather than waiting for the device to move.
      if (seen != null && u.pos.t <= seen) { unchanged++; continue }
      this.lastFixAt.set(u.id, u.pos.t)

      // The accelerometer describes one instant, so it rides on this frame
      // only when the last message IS the record this position came from. A
      // newer message without a fix would otherwise stamp its reading on an
      // older position.
      const accel = u.lmsg?.t === u.pos.t ? accelOf(u.lmsg?.p) : NO_ACCEL
      // Voltages as the axes: only from the message the position came from.
      const volts = u.lmsg?.t === u.pos.t ? readVoltages(u.lmsg?.p) : null

      const carried = this.carried(u.id)
      const frame = toFrame(u.id, u.nm, u.pos, carried, accel, true, volts)
      if (frame) { frames.push(frame); this.noteRow(u.id, u.pos, carried.ignitionOn) }
    }

    // A subscription only lives as long as the session, so renew it here.
    await this.client.subscribePositions(units.map(u => u.id)).catch(err =>
      logger.warn({ err }, 'Wialon position subscription failed — deltas may be empty until the next reconcile'))

    logger.debug(
      { provider: this.name, mode: 'reconcile', units: units.length, drained, swept: frames.length - drained,
        unchanged, neverReported, connection: connectionCounts() },
      'Wialon poll',
    )
    return frames
  }

  /**
   * Fast path: every message since the last call, oldest first; each fix that
   * earns a row becomes a frame.
   */
  private async pollDeltas(): Promise<VehicleTelemetryFrame[]> {
    const messages = await this.client.pollEvents()
    // Oldest first. A batch holds every message a tracker uploaded since the
    // last call, and a unit's must go out in the order it recorded them — a
    // newer one first would make the rest look stale. The sort is stable, so
    // messages from the same second keep Wialon's order.
    messages.sort((a, b) => a.t - b.t)

    const frames: VehicleTelemetryFrame[] = []
    let unchanged = 0, thinned = 0, noFix = 0

    for (const m of messages) {
      // The message's readings first, so the frame below carries its own fuel
      // and ignition. A message with no fix, or no row, still counts for them.
      this.noteReadings(m.unitId, m.t, m.params, m.pos)
      if (!m.pos) { noFix++; continue }

      const seen = this.lastFixAt.get(m.unitId)
      if (seen != null && m.pos.t <= seen) { unchanged++; continue }
      this.lastFixAt.set(m.unitId, m.pos.t)

      const carried = this.carried(m.unitId)
      if (!this.earnsRow(m.unitId, m.pos, carried.ignitionOn)) { thinned++; continue }

      // The event is the raw message itself, so its params are this fix's own.
      const frame = toFrame(m.unitId, this.unitNames.get(m.unitId) ?? String(m.unitId), m.pos, carried, accelOf(m.params), m.ownTime, readVoltages(m.params))
      if (frame) { frames.push(frame); this.noteRow(m.unitId, m.pos, carried.ignitionOn) }
    }

    if (frames.length > 0 || unchanged > 0) {
      logger.debug(
        { provider: this.name, mode: 'delta', messages: messages.length, moved: frames.length, thinned, unchanged, noFix },
        'Wialon poll',
      )
    }
    return frames
  }

  /**
   * Whether a fix gets a row of its own: MIN_ROW_GAP_S after the unit's last
   * one, or the first to show it starting or stopping, or its engine doing so.
   */
  private earnsRow(unitId: number, pos: WialonPosition, ignitionOn: boolean | null): boolean {
    const last = this.lastRow.get(unitId)
    if (!last) return true
    if (pos.t - last.t >= MIN_ROW_GAP_S) return true
    if (((pos.s ?? 0) > 0) !== last.moving) return true
    return ignitionOn !== null && ignitionOn !== last.ignitionOn
  }

  private noteRow(unitId: number, pos: WialonPosition, ignitionOn: boolean | null): void {
    this.lastRow.set(unitId, { t: pos.t, moving: (pos.s ?? 0) > 0, ignitionOn })
  }

  /**
   * Fold one message's readings into the state carried between frames: fuel,
   * the probe's fault, ignition. Skipped for a message no newer than the last
   * one read — see lastReadAt.
   */
  private noteReadings(
    unitId: number,
    at: number | undefined,
    params: Record<string, unknown> | null | undefined,
    pos: WialonPosition | null = null,
  ): void {
    const read = this.lastReadAt.get(unitId)
    if (at != null && read != null && at <= read) return
    if (at != null) this.lastReadAt.set(unitId, at)
    if (!params) return

    // A harsh acceleration, braking or cornering the tracker reported. Read
    // here, once per message, and not from the frames: the event record is one
    // message, and the 15 s row spacing (MIN_ROW_GAP_S) would drop most of them
    // before they became a row. Recorded by harsh-driving.worker.
    const harsh = at != null ? readHarshDriving(params) : null
    if (harsh && at != null) {
      eventBus.publish('driving:harsh', {
        deviceId: wialonDeviceId(unitId),
        unitName: this.unitNames.get(unitId) ?? String(unitId),
        at:       new Date(at * 1000),
        kind:     harsh.kind,
        ms2:      harsh.ms2,
        lat:      pos && Number.isFinite(pos.y) ? pos.y : null,
        lng:      pos && Number.isFinite(pos.x) ? pos.x : null,
        speedKmh: pos?.s ?? null,
      })
    }

    const sensors = this.sensors.get(unitId)
    if (carriesFuelReading(sensors, params)) {
      // Calibrated fuel from the probe's own table — see wialon.sensors.
      const fuel = readFuel(sensors, params)
      if (fuel) this.lastFuelMl.set(unitId, Math.round(fuel.litres * 1000))
      // Why there is no reading, when there is none. Set AND cleared on each
      // reading so a repaired probe stops reporting a fault; see lastProbeFault.
      const probeFault = readFuelProbeFault(sensors, params)
      if (probeFault) {
        const prev = this.lastProbeFault.get(unitId)
        this.lastProbeFault.set(unitId, probeFault)
        if (!prev) {
          logger.warn(
            { unit: this.unitNames.get(unitId) ?? String(unitId), raw: probeFault.raw, calibratedMax: probeFault.calibratedMax, reason: probeFault.reason },
            'Fuel probe reporting outside its calibrated range — no level available',
          )
        }
      } else {
        this.lastProbeFault.delete(unitId)
      }
    } else if (sensors && !hasFuelSensor(sensors)) {
      // No probe configured any more, so no probe to be faulty.
      this.lastProbeFault.delete(unitId)
    }

    // Ignition — `io_239` where the unit sends it, whatever the configured
    // sensor points at, else a sensor that decodes to a genuine digital line.
    // Readable on 174 of 211 KASULU units as of 2026-09-24; see readIgnition.
    // The only way to distinguish idling from parked.
    const ign = readIgnition(sensors, params)
    if (ign !== null) this.lastIgnition.set(unitId, ign)
  }

  /** The unit's carried-forward state, for its next frame. */
  private carried(unitId: number): Carried {
    return {
      fuelLevelMl:    this.lastFuelMl.get(unitId) ?? null,
      odometerKm:     this.lastOdometerKm.get(unitId) ?? null,
      engineHours:    this.lastEngineHours.get(unitId) ?? null,
      ignitionOn:     this.lastIgnition.get(unitId) ?? null,
      fuelProbeFault: this.lastProbeFault.has(unitId),
      camera:         this.lastCamera.get(unitId) ?? null,
    }
  }
}

/** What a frame takes from the unit's latest readings rather than from its own message. */
interface Carried {
  fuelLevelMl:    number | null
  odometerKm:     number | null
  engineHours:    number | null
  ignitionOn:     boolean | null
  fuelProbeFault: boolean
  camera:         CameraState | null
}

/** A message's accelerometer axes in g, with the raw values they were read from. */
interface AccelRead {
  axes: AccelAxes | null
  /** The params as received, kept in the raw payload so the unit conversion can be audited. */
  raw: Record<string, unknown> | null
}

const NO_ACCEL: AccelRead = { axes: null, raw: null }

function accelOf(params: Record<string, unknown> | null | undefined): AccelRead {
  const axes = readAccelerometer(params)
  if (!axes || !params) return NO_ACCEL
  const raw: Record<string, unknown> = {}
  for (const k of ['io_17', 'io_18', 'io_19']) if (params[k] != null) raw[k] = params[k]
  return { axes, raw }
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
  c: Carried,
  accel: AccelRead = NO_ACCEL,
  ownTime = true,
  volts: SupplyVolts | null = null,
): VehicleTelemetryFrame | null {
  if (!p || !Number.isFinite(p.y) || !Number.isFinite(p.x)) return null
  // A frame without a usable timestamp is unwritable (capturedAt is part of
  // the telemetry key) — reject it here rather than at the database.
  const capturedAt = new Date((p.t ?? NaN) * 1000)
  if (Number.isNaN(capturedAt.getTime())) return null

  const { fuelLevelMl, odometerKm, engineHours, ignitionOn, fuelProbeFault, camera } = c
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
    // Real ignition when the unit reports one. Only where it is genuinely
    // unknown does this fall back to the old speed heuristic — which cannot see
    // idling at all, since it makes "engine on" and "moving" the same signal.
    engineOn:   ignitionOn ?? ((speedKmh ?? 0) > 0),
    // Whether that was a reading or a guess. `readIgnition` returns null when
    // the unit has no usable ignition line: 37 of 211 KASULU units as of
    // 2026-09-24, down from 107 before io_239 was read ahead of the configured
    // sensor. This column is what `engineEvidence` counts, and `engineEvidence`
    // gates the parked branch — the only route to a SIPHON verdict — so a unit
    // reading false here can raise no fuel-theft alert at all.
    ignitionKnown:    ignitionOn !== null,
    engineHoursMeter: engineHours,
    // This message's own accelerometer, never a carried-forward one.
    accelG:           accel.axes,
    // This message's own supply voltages, never carried forward.
    extVoltageV:      volts?.ext ?? null,
    intVoltageV:      volts?.int ?? null,

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
    // config, then carried in alongside the fuel reading it explains the
    // absence of.
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
    // `accel_raw` is the axis params exactly as received, only on units that
    // send them — the columns hold the values converted to g. `time: 'batch'`
    // marks the rare frame whose own time could not be believed, so Wialon's
    // batch time stands in (see WialonClient.messageTime).
    rawPayload: { source: 'wialon', unitId, name: unitName, pos: p, odometer_km: odometerKm, engine_hours: engineHours, ignition_known: ignitionOn !== null,
      ...(accel.raw ? { accel_raw: accel.raw } : {}),
      ...(ownTime ? {} : { time: 'batch' }) },
  }
}
