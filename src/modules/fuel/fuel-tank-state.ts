/**
 * What the tank held when the machine started work, what it holds now, and how
 * much the probe moved about while it was working.
 *
 * ## What counts as a stop
 *
 * **The engine going off.** That is not an arbitrary choice — it falls out of
 * the operator's own definition of the other half: turbulence is what the unit
 * experiences *"when the unit was moving or working (engine on and move or
 * engine on and stationary)"*. If working is engine-on, then stopped is
 * engine-off, and the two definitions cannot disagree with each other.
 *
 * It also suits this fleet. 215 of 310 probed units are plant or tractors that
 * spend hours stationary with the engine running — a dozer clearing a face does
 * not move, and a speed-based definition would call it stopped all day and
 * report no consumption at all. Engine state is what separates working from
 * finished here, which is the same reason `fuel-consumption-rates.md` insists
 * consumption be measured per engine-hour rather than per km.
 *
 * A stop needs `STOP_MINUTES` of continuous engine-off to count, so a machine
 * restarting after a two-minute pause is one working period and not three.
 *
 * ## Why the level is read at the stop, not continuously
 *
 * A tank in motion does not have a level — it has a range. Reading it while the
 * machine works is what produces the swings this whole module has spent its
 * life compensating for. Reading it once the engine is off and the fuel has
 * settled is the only moment the number means a quantity.
 *
 * So `initialMl` is the settled level at the START of the current working
 * period (i.e. the level at the previous stop) and `currentMl` is the settled
 * level at the most recent stop, or the live level if the machine is working
 * now. Their difference is what the machine has burned.
 */

/** Continuous engine-off needed before a pause counts as a stop. */
export const STOP_MINUTES = 15

/**
 * How many recent working windows the turbulence average spans.
 *
 * A moving average, so a machine that spent last week on a slope and this week
 * on a yard reads as it is now rather than as it was. Eight 30-minute windows
 * is roughly a working half-day on this fleet.
 */
export const TURBULENCE_WINDOWS = 8

/** Readings a window needs before its swing is worth measuring. */
export const TURBULENCE_MIN_SAMPLES = 10

export interface TankState {
  /** Settled level at the start of the current working period. */
  initialMl: number | null
  /** Settled level now, or at the most recent stop. */
  currentMl: number | null
  /** initial − current: what the machine has burned since it started work. */
  consumedMl: number | null
  /**
   * Mean level range per 30-minute window WHILE WORKING, over the most recent
   * TURBULENCE_WINDOWS. This is the working counterpart of the parked-swing
   * figure the trust gate uses (`getProbeProfile`): that one asks whether a
   * probe can be believed at rest, this one describes what the machine is
   * putting the fuel through — terrain, load and slope.
   */
  turbulenceMl: number | null
  /** When the current working period began. Null if never seen stopped. */
  workingSince: Date | null
}

/** Nothing known — a vehicle with no usable telemetry. */
export const UNKNOWN_TANK_STATE: TankState = {
  initialMl: null, currentMl: null, consumedMl: null,
  turbulenceMl: null, workingSince: null,
}

/**
 * Derive the pair and the turbulence from a vehicle's recent readings.
 *
 * Pure, so the rule can be tested without a database. `samples` must be
 * ascending and carry `engineOn`; without engine state nothing here can be
 * computed and the caller gets UNKNOWN_TANK_STATE, which is the honest answer
 * rather than a consumption figure derived from a guess.
 */
export function deriveTankState(
  samples: readonly { capturedAt: Date; fuelLevelMl: number; engineOn?: boolean }[],
): TankState {
  if (samples.length === 0) return { ...UNKNOWN_TANK_STATE }
  // Engine state is load-bearing: it defines both halves. A provider that does
  // not send it cannot be given a consumption figure — 2 of the operator's own
  // five condemned units report it on zero readings.
  if (!samples.some(s => s.engineOn !== undefined)) return { ...UNKNOWN_TANK_STATE }

  const stopMs = STOP_MINUTES * 60_000

  // Walk backwards to the start of the CURRENT working period: the end of the
  // last engine-off run that lasted at least STOP_MINUTES.
  let workingSince: Date | null = null
  let offRunEnd: Date | null = null
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i]!
    if (s.engineOn === false) {
      if (offRunEnd == null) offRunEnd = s.capturedAt
      if (offRunEnd.getTime() - s.capturedAt.getTime() >= stopMs) {
        // s..offRunEnd is a genuine stop; work resumed after it.
        workingSince = offRunEnd
        break
      }
    } else if (s.engineOn === true) {
      offRunEnd = null
    }
  }

  // The settled level at a stop is the median of the engine-off readings around
  // it, never a single sample — that is the whole point of waiting for the
  // engine to stop.
  const settledAt = (at: Date): number | null => {
    const near = samples.filter(s =>
      s.engineOn === false && Math.abs(s.capturedAt.getTime() - at.getTime()) <= stopMs)
    if (near.length === 0) return null
    const v = near.map(s => s.fuelLevelMl).sort((a, b) => a - b)
    return v[Math.floor(v.length / 2)]!
  }

  const last = samples.at(-1)!
  const currentMl = last.engineOn === false
    ? settledAt(last.capturedAt) ?? last.fuelLevelMl
    : last.fuelLevelMl
  const initialMl = workingSince ? settledAt(workingSince) : null

  return {
    initialMl,
    currentMl,
    // Only when both ends are real. A consumption figure with a guessed end is
    // worse than no figure, because it looks like a measurement.
    consumedMl: initialMl != null && currentMl != null ? initialMl - currentMl : null,
    turbulenceMl: workingTurbulence(samples),
    workingSince,
  }
}

/**
 * Mean level range per 30-minute window while the engine was on, over the most
 * recent TURBULENCE_WINDOWS.
 *
 * Deliberately the SAME shape as the parked-swing measure in
 * `fuel-adjudication.service`'s `getProbeProfile` — 30-minute windows, range
 * within the window — so the two are directly comparable. A machine whose
 * working turbulence is high and whose parked swing is low is telling you about
 * ground and load; one whose PARKED swing is high is telling you its probe
 * cannot be trusted, and that one already has a verdict gate.
 */
function workingTurbulence(
  samples: readonly { capturedAt: Date; fuelLevelMl: number; engineOn?: boolean }[],
): number | null {
  const buckets = new Map<number, number[]>()
  for (const s of samples) {
    if (s.engineOn !== true) continue
    const key = Math.floor(s.capturedAt.getTime() / (30 * 60_000))
    const b = buckets.get(key)
    if (b) b.push(s.fuelLevelMl)
    else buckets.set(key, [s.fuelLevelMl])
  }

  const ranges = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v.length >= TURBULENCE_MIN_SAMPLES)
    .map(([, v]) => Math.max(...v) - Math.min(...v))
    .slice(-TURBULENCE_WINDOWS)

  if (ranges.length === 0) return null
  return Math.round(ranges.reduce((a, b) => a + b, 0) / ranges.length)
}
