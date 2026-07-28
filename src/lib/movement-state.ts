/**
 * How long each vehicle has been moving, or standing still.
 *
 * The snapshot already carries `lastMovedAt` (the newest ping that showed
 * movement), which answers "resting since" for a parked vehicle — but only for
 * the 129 of 224 units that have ever recorded a moving ping, and it answers
 * nothing at all for a vehicle currently in transit. There was no way to say
 * "this truck has been on the road for two hours".
 *
 * This tracks the CURRENT run: when the vehicle entered its present state, so
 * a duration is just `now - since`.
 *
 * ## Two decisions worth knowing
 *
 * **A movement threshold, not `speed > 0`.** A stationary unit reports 1–2 km/h
 * of GPS jitter. Treating that as movement would restart the resting clock
 * every few seconds and the number would never grow past a minute.
 *
 * **A grace period before a journey is declared over.** A truck at a junction
 * or a weighbridge is not "resting"; without this, one red light would split a
 * two-hour haul into two runs and reset the clock. When the stop does become
 * real, the rest clock is backdated to the moment the vehicle ACTUALLY stopped
 * — not to the moment the grace period elapsed.
 */

/**
 * km/h at or above which a unit counts as moving.
 *
 * 1 km/h: a vehicle under power and covering ground is in transit, per the
 * fleet definition (engine on and speed >= 1).
 *
 * This was 3, to sit above the 1-2 km/h of GPS jitter a stationary unit can
 * emit. Measured against the live account, that jitter does not appear here —
 * of 82 online units the speed histogram was 77 at exactly 0 and 5 at 6+, with
 * NOTHING in the 1-5 band, so Wialon is already filtering it upstream. Kept in
 * step with MOVING_THRESHOLD_KMH in the dash's lib/vehicleMap: if the two ever
 * differ, a vehicle can be "in transit" on the card while its run row reports
 * it idling.
 */
const MOVING_THRESHOLD_KMH = 1

/** A stop shorter than this does not end a journey. */
const STOP_GRACE_MS = 3 * 60_000

/**
 * Beyond this age, a fix cannot support a claim that the vehicle is MOVING.
 *
 * Without it the tracker reports whatever the last frame said, forever: a unit
 * whose final ping in June showed 12 km/h was still being described as "on the
 * road" 34 days later, because nothing ever arrived to end the run. A vehicle
 * that has stopped reporting is not driving — we simply have not heard from
 * it — so a stale run is reported as stopped, dated from that last fix, which
 * is the last moment we know anything about.
 */
const STALE_FIX_MS = 60 * 60_000

export type RunState = 'moving' | 'idling' | 'resting'

interface State {
  state: RunState
  /** Epoch ms the current run began. */
  sinceMs: number
  /** First frame of an as-yet-unconfirmed stop, while a journey is running. */
  pendingStopMs: number | null
  /**
   * False when `sinceMs` is the first frame we happened to see rather than an
   * observed transition — true after a restart, mid-journey. The run is then
   * AT LEAST this long, and the UI says so rather than overstating precision.
   */
  exact: boolean
}

const states = new Map<string, State>()

export interface MovementState {
  /**
   * moving  — above the movement threshold
   * idling  — stationary with the ignition ON. Only ever reported when the
   *           unit actually reports ignition (Wialon `engine operation` →
   *           io_239, fitted on 222/224). Where it does not, engineOn is
   *           derived from speed and idling is indistinguishable from parked,
   *           so this collapses to 'resting' rather than guessing.
   * resting — stationary, ignition off or unknown
   */
  state: RunState
  /** Kept for callers that only care whether it is under way. */
  moving: boolean
  /** ISO-8601 start of the current run. */
  since: string
  /** False = "at least this long" (we started watching mid-run). */
  exact: boolean
}

/**
 * Fold one telemetry frame into the vehicle's movement state.
 * Safe to call on every frame; does nothing when the state is unchanged.
 */
export function noteMovement(
  vehicleId: string,
  speedKmh: number | null,
  capturedAtMs: number,
  /** Measured ignition. Null = not reported; idling is then not claimable. */
  ignitionOn: boolean | null = null,
): void {
  if (!Number.isFinite(capturedAtMs)) return

  const moving = (speedKmh ?? 0) >= MOVING_THRESHOLD_KMH
  // Idling is only ever asserted from a real ignition reading.
  const stoppedState: RunState = ignitionOn === true ? 'idling' : 'resting'

  const prev = states.get(vehicleId)
  if (!prev) {
    states.set(vehicleId, {
      state: moving ? 'moving' : stoppedState,
      sinceMs: capturedAtMs, pendingStopMs: null, exact: false,
    })
    return
  }

  if (moving) {
    if (prev.state !== 'moving') {
      states.set(vehicleId, { state: 'moving', sinceMs: capturedAtMs, pendingStopMs: null, exact: true })
    } else {
      // Still going — any pending stop was a pause, not the end.
      prev.pendingStopMs = null
    }
    return
  }

  // Not moving. Ending a JOURNEY needs the grace period (a truck at a junction
  // is not resting); switching between idling and resting does not, because
  // that is the ignition being turned off, which is instantaneous and real.
  if (prev.state === 'moving') {
    if (prev.pendingStopMs == null) {
      prev.pendingStopMs = capturedAtMs
      return
    }
    if (capturedAtMs - prev.pendingStopMs >= STOP_GRACE_MS) {
      // Backdate to when it actually stopped, not to when grace elapsed.
      states.set(vehicleId, { state: stoppedState, sinceMs: prev.pendingStopMs, pendingStopMs: null, exact: true })
    }
    return
  }

  if (prev.state !== stoppedState) {
    states.set(vehicleId, { state: stoppedState, sinceMs: capturedAtMs, pendingStopMs: null, exact: true })
  }
}

/**
 * Current run for a vehicle, or null when it has never been seen.
 *
 * `fallbackLastMovedAt` covers the case this map cannot: a vehicle parked
 * since before the process started, which emits no frames at all and so never
 * enters the map. Its last moving ping is in the database, and that IS the
 * moment it stopped.
 */
export function movementState(
  vehicleId: string,
  fallbackLastMovedAt?: Date | string | null,
  lastFixAtMs?: number | null,
): MovementState | null {
  const fallbackMs = (() => {
    if (!fallbackLastMovedAt) return null
    const ms = typeof fallbackLastMovedAt === 'string'
      ? Date.parse(fallbackLastMovedAt)
      : fallbackLastMovedAt.getTime()
    return Number.isFinite(ms) ? ms : null
  })()

  const s = states.get(vehicleId)
  if (s) {
    // A run can only be called "in progress" if we have heard from the vehicle
    // recently. `lastFixAtMs` is the newest fix we hold; absent one, fall back
    // to when this run began, which for a silent unit is equally old.
    const newestFix = Number.isFinite(lastFixAtMs) ? (lastFixAtMs as number) : s.sinceMs
    const stale  = Date.now() - newestFix > STALE_FIX_MS
    // A silent unit is neither driving nor idling — we simply have not heard
    // from it, so a stale run collapses to resting.
    const state: RunState = stale ? 'resting' : s.state
    const moving = state === 'moving'

    // Prefer the DATABASE's last-moving-ping when this process only inferred
    // the run from its first sighting AND the database knows of an earlier
    // stop. Otherwise every restart would reset the whole fleet's rest clocks
    // to "≥ a few minutes" and silently discard history we actually hold: a
    // truck idle since Tuesday would read "resting for ≥ 3m" purely because
    // the server had just come back up.
    //
    // This corrects the START TIME only. It used to hardcode `state: 'resting'`
    // and so DISCARDED a measured idling verdict: a vehicle already idling when
    // this process booted takes exactly this branch — first sighting sets
    // exact:false, and later stationary frames leave it false because
    // `prev.state === stoppedState` short-circuits noteMovement — so its
    // ignition-backed 'idling' was overwritten with 'resting' for the whole run.
    // Measured on production, that misreported 18 of 78 online units, which the
    // dashboard showed as ENGINE ON sitting next to PARKED.
    //
    // Backdating to the last moving ping stays correct for idling: the branch
    // only fires when we never witnessed the transition, so the moment it
    // stopped moving IS the moment the current stationary run began.
    if (!moving && !s.exact && fallbackMs != null && fallbackMs < s.sinceMs) {
      return { state, moving: false, since: new Date(fallbackMs).toISOString(), exact: true }
    }

    return { state, moving, since: new Date(s.sinceMs).toISOString(), exact: s.exact }
  }

  if (fallbackMs != null) {
    // Derived from the last moving ping, so the stop time is exact even
    // though this process never witnessed it.
    return { state: 'resting', moving: false, since: new Date(fallbackMs).toISOString(), exact: true }
  }
  return null
}
