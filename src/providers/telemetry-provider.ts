/**
 * Vendor-agnostic telemetry provider interface.
 *
 * To integrate a live provider (e.g. real RaiFactorySuite REST API):
 *   1. Create `src/providers/raifactorysuite/raifactorysuite-live.adapter.ts`
 *   2. Implement `TelemetryProvider` — fetch from their API, normalise the
 *      response into `VehicleTelemetryFrame[]`, return it.
 *   3. In `src/lib/poller.ts` swap `RaiFactorySuiteMockAdapter` for the live one.
 *   Nothing else changes.
 */

export type DoorStatus = 'CLOSED' | 'OPEN' | 'AJAR' | 'UNKNOWN'
export type NetworkType = 'GSM' | '3G' | '4G' | '5G' | null

/**
 * Accelerometer axes at one instant, in g. Each axis is independently nullable
 * because units exist that send only some of them (MUFINDI - FT 05 sends Y and
 * Z, never X). A reading belongs to one message: carrying it onto a later fix
 * would claim an attitude nobody measured.
 */
export interface AccelAxes {
  x: number | null
  y: number | null
  z: number | null
}

/** One normalised telemetry snapshot per device per poll cycle. */
export interface VehicleTelemetryFrame {
  // ── Core identity ──────────────────────────────────────────────────────────
  deviceId:          string
  capturedAt:        Date

  // ── Position ───────────────────────────────────────────────────────────────
  lat:               number | null
  lng:               number | null
  altitudeM:         number | null
  headingDeg:        number | null
  accuracyM:         number | null

  // ── Motion ────────────────────────────────────────────────────────────────
  speedKmh:          number | null
  engineOn:          boolean
  /**
   * Was `engineOn` MEASURED, or inferred from speed?
   *
   * Required, not optional, because the difference decides what may be claimed.
   * An adapter with no ignition line falls back to `speed > 0`, which makes
   * "engine on" and "moving" the same signal and cannot see idling at all — so
   * a digging excavator and a parked one are indistinguishable, which is the
   * single limit capping SIPHON. A provider must therefore say which it is
   * rather than inherit a default that flatters it.
   */
  ignitionKnown:     boolean
  /**
   * The unit's cumulative engine-hours counter at this fix, in HOURS — an
   * absolute odometer-like reading, not a duration. Null where the unit has no
   * counter.
   *
   * Persisted per fix rather than only as the daily rollup on FuelDailyTrend,
   * because `dayEngineSeconds` reads its two endpoints and derives a day's
   * engine time exactly where integration over-counts. Note the counter ticks
   * about every five minutes, so it is a good measure of a day and a poor one
   * of a twenty-minute run — see fuel-rate.service.
   */
  engineHoursMeter:  number | null

  /**
   * The tracker's accelerometer at this fix, in g, from the same message as
   * the position. Absent or null when the unit sends no axes — most of the
   * fleet. Never carried forward from an earlier message: see AccelAxes.
   */
  accelG?:           AccelAxes | null

  /**
   * The tracker's external supply and internal battery voltages at this fix,
   * in volts, from the same message as the position. Absent where the unit
   * sends none. Not `batteryVoltageV`, which another provider fills.
   */
  extVoltageV?:      number | null
  intVoltageV?:      number | null

  // ── Fuel / FLS sensor ─────────────────────────────────────────────────────
  fuelLevelMl:       number | null
  fuelUsedMl:        number | null     // delta since last ping; negative = suspect theft

  // ── Cargo weight ──────────────────────────────────────────────────────────
  cargoWeightKg:     number | null

  // ── Extended RaiFactorySuite sensor channels ──────────────────────────────────
  batteryVoltageV:   number | null     // vehicle chassis battery (e.g. 12.4 V)
  doorStatus:        DoorStatus
  panicButtonPressed: boolean
  gpsFixQuality:     number | null     // 0 = no fix, 1 = GPS, 2 = DGPS, 3 = RTK
  satelliteCount:    number | null
  networkType:       NetworkType
  signalStrengthPct: number | null     // 0–100
  engineTempC:       number | null     // engine coolant temperature in °C
  oilLevelPct:       number | null     // engine oil level as % of max fill (0–100)

  // ── Derived / diagnostic flags ────────────────────────────────────────────
  flags: {
    overspeeding:        boolean   // speedKmh > speedLimitKmh
    fuelInconsistency:   boolean   // sudden unexplained drop > threshold
    doorOpenWhileMoving: boolean
    lowFuel:             boolean   // fuelLevelMl < 20 % of tank capacity
    engineIdling:        boolean   // engineOn && speedKmh === 0
    outsideGeofence:     boolean   // pre-computed by simulator for test visibility
    lowBattery:          boolean   // batteryVoltageV < 11.5 V
    highEngineTemp:      boolean   // engineTempC > 105 °C — vehicle must stop
    lowOil:              boolean   // oilLevelPct < 10 % — vehicle must stop
    /**
     * The fuel probe is reporting outside its calibrated range — a hardware
     * fault, not a level. Distinguishes "the probe is broken" from "no probe
     * fitted", which both otherwise surface as a null fuelLevelMl.
     *
     * Optional because it is provider-specific: only Wialon's BLE probes
     * report it, and it is deliberately NOT an AlertType — it describes a
     * standing maintenance condition, not an event, and raising one alert per
     * ping for a probe that has been faulty for weeks would bury the feed.
     */
    fuelProbeFault?:     boolean

    /**
     * The unit's on-board recorder, when it has one.
     *
     * Provider-specific and rare: ONE unit of 1,496 in this Wialon account
     * reports a camera at all (`VS Menengai CAMERA - KCS 078M`), so this is
     * absent on essentially every frame. Optional rather than nullable for that
     * reason — a null on 1,495 units would imply the question was asked and
     * answered, when for most hardware it does not arise.
     *
     * `streamUrl` is separate from `hasCamera` on purpose: the recorder can be
     * fitted and healthy while no URL is reachable, which is the state of the
     * one real unit today. See readCamera in wialon.sensors for why an
     * unrecognised value never becomes a streamUrl.
     */
    camera?: {
      hasCamera:   boolean
      streamUrl:   string | null
      recording:   boolean | null
      signalLost:  boolean | null
    }
  }

  // ── Raw vendor envelope (stored in vehicle_telemetry_raws) ────────────────
  rawPayload: Record<string, unknown>
}

/** Contract every provider adapter must satisfy. */
export interface TelemetryProvider {
  /** Human-readable name shown in logs. */
  readonly name: string

  /**
   * Fetch the latest telemetry snapshot for every registered device.
   * Throws on unrecoverable provider errors; the poller catches and retries
   * on the next cycle.
   */
  fetchAll(): Promise<VehicleTelemetryFrame[]>
}
