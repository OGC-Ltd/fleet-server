/**
 * Wialon sensor decoding — fuel level.
 *
 * Units carry configured sensors (`sens`) whose raw parameter values arrive in
 * the last message (`lmsg.p`). A fuel probe reports a RAW ADC reading — around
 * 0–4096 — not litres, so it must be run through the sensor's own calibration
 * table before it means anything. Publishing the raw number as a fuel level
 * would be badly wrong, not merely imprecise: a raw 1992 is 44 L on one unit
 * and something else entirely on the next.
 *
 * Tank capacity is not a field either — the operator encodes it in the sensor
 * NAME, e.g. "2.Main Tank Fuel Level Qty (95L)". That is the only source of
 * capacity available, and without it a percentage cannot be computed at all.
 */

/** One calibration point: for readings from `x` upward, litres = a·raw + b. */
export interface CalibrationPoint { x: number; a: number; b: number }

export interface WialonSensor {
  n:    string                  // name — carries the tank size in brackets
  t:    string                  // type — "fuel level" for a probe
  p:    string                  // parameter it reads, e.g. "io_270"
  m?:   string                  // metric, e.g. "l"
  tbl?: CalibrationPoint[]      // calibration table; may be empty
}

const FUEL_SENSOR_TYPE = 'fuel level'
/**
 * Wialon's type for an ignition line. Verified against this account: 222 of
 * 224 units carry one, every one of them reading `io_239` — the standard
 * Teltonika ignition input.
 */
const IGNITION_SENSOR_TYPE = 'engine operation'
/** "…Qty (450L)" / "…Level (254 L)" → 450 / 254. */
const CAPACITY_IN_NAME = /\((\d+(?:\.\d+)?)\s*L\)/i

/** Tank capacity in litres, read from the sensor name. */
export function tankCapacityFromSensorName(name: string): number | null {
  const m = CAPACITY_IN_NAME.exec(name)
  if (!m) return null
  const litres = Number(m[1])
  return Number.isFinite(litres) && litres > 0 ? litres : null
}

/**
 * Convert a raw probe reading to litres using the sensor's calibration table.
 *
 * Wialon's table is piecewise-linear: points are sorted by `x`, and the
 * segment that applies is the last one whose `x` is at or below the reading.
 * Returns null when there is no table — a reading we cannot calibrate is not
 * a fuel level, and inventing one would be worse than showing nothing.
 */
export function calibrateFuel(raw: number, tbl: CalibrationPoint[] | undefined): number | null {
  if (!Number.isFinite(raw) || !tbl || tbl.length === 0) return null

  const sorted = [...tbl].sort((p, q) => p.x - q.x)
  let seg = sorted[0]!
  for (const point of sorted) {
    if (point.x <= raw) seg = point
    else break
  }

  const litres = seg.a * raw + seg.b
  if (!Number.isFinite(litres)) return null
  // A probe reading below its calibrated floor can compute slightly negative.
  return Math.max(0, litres)
}

export interface FuelReading {
  /** Litres in the tank, calibrated. */
  litres:   number
  /** Tank capacity from the sensor name, when stated. */
  capacityL: number | null
}

/**
 * Best fuel reading for a unit: its main-tank probe, calibrated.
 *
 * Where a unit has several fuel sensors (main + reserve) the one with the
 * largest stated capacity is treated as the main tank — reserve tanks are the
 * smaller of the pair, and summing them would misreport the level against the
 * capacity we display.
 */
export function readFuel(
  sensors: Record<string, WialonSensor> | undefined,
  params: Record<string, unknown> | undefined,
): FuelReading | null {
  if (!sensors || !params) return null

  let best: FuelReading | null = null
  for (const sensor of Object.values(sensors)) {
    if (sensor.t !== FUEL_SENSOR_TYPE) continue

    const raw = params[sensor.p]
    if (typeof raw !== 'number') continue

    const litres = calibrateFuel(raw, sensor.tbl)
    if (litres == null) continue

    const capacityL = tankCapacityFromSensorName(sensor.n)
    if (!best || (capacityL ?? 0) > (best.capacityL ?? 0)) best = { litres, capacityL }
  }
  return best
}

/**
 * Ignition state for a unit, or null when it cannot be known.
 *
 * This is the ONLY way to tell a vehicle that is idling from one that is
 * parked. Without it `engineOn` has to be derived from speed, which makes the
 * two states literally the same signal — the reason the dashboard could not
 * report idling at all.
 *
 * Null is returned rather than `false` when the unit has no ignition sensor,
 * or has one but its parameter is absent from this message: "we do not know"
 * and "the engine is off" are different claims, and only the first is honest
 * here. Callers fall back to the speed heuristic in that case.
 */
export function readIgnition(
  sensors: Record<string, WialonSensor> | undefined,
  params: Record<string, unknown> | undefined,
): boolean | null {
  if (!sensors || !params) return null

  for (const sensor of Object.values(sensors)) {
    if (sensor.t !== IGNITION_SENSOR_TYPE) continue
    const raw = params[sensor.p]
    // Digital line: any non-zero numeric means the ignition is live. Some
    // firmwares send it as a string, hence the coercion rather than a
    // typeof-number guard.
    if (raw == null || raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n)) continue
    return n !== 0
  }
  return null
}

/** Largest stated tank capacity across a unit's fuel sensors. */
export function tankCapacityOf(sensors: Record<string, WialonSensor> | undefined): number | null {
  if (!sensors) return null
  let max: number | null = null
  for (const sensor of Object.values(sensors)) {
    if (sensor.t !== FUEL_SENSOR_TYPE) continue
    const cap = tankCapacityFromSensorName(sensor.n)
    if (cap != null && (max == null || cap > max)) max = cap
  }
  return max
}
