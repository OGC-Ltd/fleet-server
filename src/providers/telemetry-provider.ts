/**
 * Vendor-agnostic telemetry provider interface.
 *
 * To integrate a live provider (e.g. real Controltech EA REST API):
 *   1. Create `src/providers/controltech/controltech-live.adapter.ts`
 *   2. Implement `TelemetryProvider` — fetch from their API, normalise the
 *      response into `VehicleTelemetryFrame[]`, return it.
 *   3. In `src/lib/poller.ts` swap `ControltechMockAdapter` for the live one.
 *   Nothing else changes.
 */

export type DoorStatus = 'CLOSED' | 'OPEN' | 'AJAR' | 'UNKNOWN'
export type NetworkType = 'GSM' | '3G' | '4G' | '5G' | null

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

  // ── Fuel / FLS sensor ─────────────────────────────────────────────────────
  fuelLevelMl:       number | null
  fuelUsedMl:        number | null     // delta since last ping; negative = suspect theft

  // ── Cargo weight ──────────────────────────────────────────────────────────
  cargoWeightKg:     number | null

  // ── Extended Controltech sensor channels ──────────────────────────────────
  batteryVoltageV:   number | null     // vehicle chassis battery (e.g. 12.4 V)
  doorStatus:        DoorStatus
  panicButtonPressed: boolean
  gpsFixQuality:     number | null     // 0 = no fix, 1 = GPS, 2 = DGPS, 3 = RTK
  satelliteCount:    number | null
  networkType:       NetworkType
  signalStrengthPct: number | null     // 0–100

  // ── Derived / diagnostic flags ────────────────────────────────────────────
  flags: {
    overspeeding:        boolean   // speedKmh > speedLimitKmh
    fuelInconsistency:   boolean   // sudden unexplained drop > threshold
    doorOpenWhileMoving: boolean
    lowFuel:             boolean   // fuelLevelMl < 10 % of tank capacity
    engineIdling:        boolean   // engineOn && speedKmh === 0
    outsideGeofence:     boolean   // pre-computed by simulator for test visibility
    lowBattery:          boolean   // batteryVoltageV < 11.5 V
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
