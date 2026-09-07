/**
 * Sensor faults as EPISODES — the frame-driven half.
 *
 * ## What this replaces
 *
 * `dash/src/hooks/useSensorHealth` detects these same contradictions in the
 * browser, over the live snapshot, and stamps each one `detectedAt: Date.now()`
 * — which is when the PAGE RENDERED, not when the fault began. Reload the page
 * and every fault appears to have just started. Nothing anywhere records when
 * one ended.
 *
 * So the rules move here, where the frames are, and open/close a
 * `sensor_fault_episodes` row with timestamps taken from the data.
 *
 * ## Two detectors, split by what can observe what
 *
 * This module handles the faults a FRAME can prove, because it arrived and
 * contradicted itself: moving with the engine reported off, speed with no
 * ignition, a fix with no coordinates, a fix too coarse to use.
 *
 * The other half — `signal_lost` and dead channels — is structurally invisible
 * here: the Wialon adapter emits nothing at all for a silent unit, so absence
 * cannot be detected by watching arrivals. That is the sweep's job
 * (sensor-fault-sweep.service), and it is not an optimisation but the only
 * possible detector.
 *
 * ## Two corrections to the browser's rules, made while porting
 *
 * - `speed_no_engine` now requires `ignitionKnown`. A unit that reports no
 *   ignition channel at all has an UNFITTED channel, not a fault, and the
 *   browser's `engine === 'off'` cannot tell those apart — so it accuses every
 *   unit without an ignition line of a sensor contradiction.
 * - `transit_no_engine` takes its start from `movement-state`'s `since`, which
 *   already backdates past the stop grace. That is the accurate start the
 *   report needs, and it comes from state the server already keeps.
 */

import { env } from '../config/env.js'
import { eventBus } from './event-bus.js'
import { movementState } from './movement-state.js'
import type { VehicleTelemetryFrame } from '../providers/telemetry-provider.js'

/** Faults a single frame can prove on its own. */
export type FrameFaultKind =
  | 'speed_no_engine'
  | 'transit_no_engine'
  | 'frozen_gps'
  | 'low_accuracy'

export interface FaultContext {
  orgId:     string
  vehicleId: string
}

export interface FaultObservation {
  orgId:      string
  vehicleId:  string
  kind:       string
  severity:   'critical' | 'warning'
  source:     'poller' | 'sweep'
  startedAt:  Date
  lastSeenAt: Date
  detail:     string
  evidence:   Record<string, unknown>
}

export interface FaultResolution {
  orgId:       string
  vehicleId:   string
  kind:        string
  recoveredAt: Date
}

/** How coarse a fix has to be before it is unusable. */
const ACCURACY_LIMIT_M = 200
/** Speed that contradicts a reported-off ignition. */
const MOVING_KMH = 2
/** How long "moving with the engine off" must hold before it is a fault. */
const TRANSIT_NO_ENGINE_MS = 5 * 60_000

interface Pending {
  /** When the DATA says it began — not when we became confident. */
  startedAt: number
  lastSeen:  number
  frames:    number
  detail:    string
  evidence:  Record<string, unknown>
  severity:  'critical' | 'warning'
  /** Consecutive clean frames, for the closing debounce. */
  clear:     number
  /** Has this been published as open yet? */
  opened:    boolean
}

/** `${vehicleId}:${kind}` → the fault currently being tracked. */
const tracked = new Map<string, Pending>()

const key = (vehicleId: string, kind: string) => `${vehicleId}:${kind}`

interface Detected {
  kind:      FrameFaultKind
  severity:  'critical' | 'warning'
  startedAt: number
  detail:    string
  evidence:  Record<string, unknown>
}

/** Every fault this frame proves, with the start each one's own data implies. */
function detect(frame: VehicleTelemetryFrame, atMs: number, vehicleId: string): Detected[] {
  const out: Detected[] = []
  const speed = frame.speedKmh ?? 0

  // Speed with the ignition MEASURED off. Without the ignitionKnown guard this
  // accuses every unit that has no ignition line at all.
  if (frame.ignitionKnown && !frame.engineOn && speed > MOVING_KMH) {
    out.push({
      kind: 'speed_no_engine', severity: 'critical', startedAt: atMs,
      detail: `Reporting ${Math.round(speed)} km/h with the ignition off`,
      evidence: { speedKmh: speed, ignitionKnown: true },
    })
  }

  // Moving for longer than the grace with the ignition off. The START comes
  // from the movement tracker, which has already backdated past a short stop —
  // that is the whole reason this is not `now`.
  // Keyed by vehicleId, the same key noteMovement is called with.
  const mv = movementState(vehicleId, null, atMs)
  if (frame.ignitionKnown && !frame.engineOn && mv?.state === 'moving' && mv.since) {
    const sinceMs = Date.parse(mv.since)
    if (Number.isFinite(sinceMs) && atMs - sinceMs > TRANSIT_NO_ENGINE_MS) {
      out.push({
        kind: 'transit_no_engine', severity: 'warning', startedAt: sinceMs,
        detail: 'In transit with the ignition reported off',
        evidence: { movingSince: mv.since, speedKmh: speed },
      })
    }
  }

  // A frame arrived, so the tracker is alive — but it carried no usable fix.
  if (frame.lat == null || frame.lng == null || (frame.lat === 0 && frame.lng === 0)) {
    out.push({
      kind: 'frozen_gps', severity: 'warning', startedAt: atMs,
      detail: 'Reporting without a position fix',
      evidence: { lat: frame.lat, lng: frame.lng },
    })
  } else if (frame.accuracyM != null && frame.accuracyM > ACCURACY_LIMIT_M) {
    // Only meaningful when there IS a fix — an accuracy figure beside a missing
    // position would be two complaints about one problem.
    out.push({
      kind: 'low_accuracy', severity: 'warning', startedAt: atMs,
      detail: `Position accurate only to ${Math.round(frame.accuracyM)} m`,
      evidence: { accuracyM: frame.accuracyM },
    })
  }

  return out
}

/**
 * Feed one frame in. Call once per frame, beside noteSpeedFrame.
 *
 * Returns what it published, for the tests; production reads the event bus.
 */
export function noteFaultFrame(
  frame: VehicleTelemetryFrame,
  ctx: FaultContext,
): { opened: FaultObservation[]; closed: FaultResolution[] } {
  const opened: FaultObservation[] = []
  const closed: FaultResolution[] = []
  if (!env.INCIDENT_CAPTURE_ENABLED) return { opened, closed }

  const atMs = frame.capturedAt.getTime()
  const now  = detect(frame, atMs, ctx.vehicleId)
  const seen = new Set(now.map(d => d.kind))

  for (const d of now) {
    const k = key(ctx.vehicleId, d.kind)
    const p = tracked.get(k)
    if (!p) {
      tracked.set(k, {
        startedAt: d.startedAt, lastSeen: atMs, frames: 1,
        detail: d.detail, evidence: d.evidence, severity: d.severity,
        clear: 0, opened: false,
      })
      continue
    }
    p.lastSeen = atMs
    p.frames  += 1
    p.clear    = 0
    p.detail   = d.detail
    p.evidence = d.evidence
    // Debounced so one noisy fix does not raise an episode.
    if (!p.opened && p.frames >= env.SENSOR_FAULT_MIN_FRAMES) {
      p.opened = true
      const obs: FaultObservation = {
        orgId: ctx.orgId, vehicleId: ctx.vehicleId, kind: d.kind,
        severity: p.severity, source: 'poller',
        startedAt: new Date(p.startedAt), lastSeenAt: new Date(atMs),
        detail: p.detail, evidence: p.evidence,
      }
      opened.push(obs)
      eventBus.publish('sensorFault:open', obs)
    }
  }

  // Anything tracked for this vehicle that this frame did NOT show.
  for (const [k, p] of tracked) {
    if (!k.startsWith(`${ctx.vehicleId}:`)) continue
    const kind = k.slice(ctx.vehicleId.length + 1)
    if (seen.has(kind as FrameFaultKind)) continue

    p.clear += 1
    if (p.clear < env.SENSOR_FAULT_MIN_FRAMES) continue
    tracked.delete(k)
    // Only an episode that was actually opened can be closed — one that never
    // cleared the debounce was never reported to anybody.
    if (!p.opened) continue
    const res: FaultResolution = {
      orgId: ctx.orgId, vehicleId: ctx.vehicleId, kind,
      // The first frame that no longer showed it, which is what "recovered"
      // means. Not the frame that finished the debounce.
      recoveredAt: frame.capturedAt,
    }
    closed.push(res)
    eventBus.publish('sensorFault:close', res)
  }

  return { opened, closed }
}

/**
 * Units the sweep has opened a `signal_lost` episode for.
 *
 * This set is what keeps `noteAlive` free. Without it, every frame of every
 * healthy unit would publish a close, and the worker would run a findFirst for
 * each one — ~1,500 units every 2 s is roughly 750 pointless queries a second
 * against the pool. The sweep is the only thing that opens signal_lost, so it
 * is also the only thing that can tell the poller a close is worth publishing.
 */
const silent = new Set<string>()

/** Called by the sweep when it opens a signal_lost episode. */
export function markSilent(vehicleId: string): void {
  silent.add(vehicleId)
}

/** Called by the sweep when it finds the episode already closed. */
export function clearSilent(vehicleId: string): void {
  silent.delete(vehicleId)
}

export function silentCount(): number {
  return silent.size
}

/**
 * A frame arrived, so this unit is not silent.
 *
 * `signal_lost` is OPENED by the sweep — only absence can be observed from
 * outside — but CLOSED here, because a ping is the exact moment it recovered.
 * That is accurate to the frame rather than to the next 15-minute grid, which
 * is the whole reason the two detectors are split this way.
 *
 * Publishes only for units the sweep has actually flagged; see `silent`.
 */
export function noteAlive(frame: VehicleTelemetryFrame, ctx: FaultContext): void {
  if (!env.INCIDENT_CAPTURE_ENABLED) return
  if (!silent.delete(ctx.vehicleId)) return
  eventBus.publish('sensorFault:close', {
    orgId: ctx.orgId, vehicleId: ctx.vehicleId,
    kind: 'signal_lost', recoveredAt: frame.capturedAt,
  })
}

/** Test seam. */
export function resetFaultState(vehicleId?: string): void {
  if (!vehicleId) { tracked.clear(); silent.clear(); return }
  silent.delete(vehicleId)
  for (const k of [...tracked.keys()]) {
    if (k.startsWith(`${vehicleId}:`)) tracked.delete(k)
  }
}

export function trackedFaultCount(): number {
  return tracked.size
}
