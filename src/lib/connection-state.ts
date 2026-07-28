/**
 * Whether each tracker is CONNECTED, as the provider itself reports it.
 *
 * ## Why this cannot be inferred from telemetry
 *
 * Connection is a different axis from activity, and it is the one axis the
 * telemetry pipeline structurally cannot carry. The Wialon adapter only emits
 * a frame when a unit's fix time ADVANCES — an offline unit produces nothing,
 * by definition. So "no recent frame" is the only thing the ping table can
 * say, and every consumer was left inferring connection from the age of the
 * newest row.
 *
 * That inference is wrong often enough to matter. Measured against the live
 * Kasulu account (224 units), a 15-minute last-message window disagreed with
 * Wialon's own verdict on 28 units — 25 of which it called online while
 * Wialon called them offline. Wialon knows things the message age does not:
 * whether the TCP session is up, and whether the unit's expected reporting
 * interval has lapsed (a tracker configured to report every 30 minutes is not
 * offline at minute 16).
 *
 * ## Shape of the fix
 *
 * `netconn` (Wialon data flag 0x200000) is returned for EVERY unit on the
 * reconcile sweep, including ones that emit no frame, so this map is fed for
 * the whole fleet on every sweep regardless of movement. It is in-memory and
 * deliberately not persisted: it describes right now, a restart re-populates
 * it within one reconcile, and a stale row in the database asserting "online"
 * would be worse than no answer at all.
 *
 * This mirrors lib/zone-presence, which exists for the same reason — a fact
 * about a vehicle that the snapshot must carry because the parked vehicles
 * that most need it are exactly the ones that stop emitting.
 */

import { logger } from './logger.js'

interface Entry {
  online: boolean
  /** When the provider last told us. */
  atMs: number
}

/** Keyed by deviceId — the provider's own unit id, as stored on Vehicle. */
const states = new Map<string, Entry>()

/**
 * Beyond this, our knowledge of the connection is too old to assert.
 *
 * The reconcile sweep refreshes every unit well inside this, so exceeding it
 * means the poller itself stopped — in which case reporting a remembered
 * "online" would be claiming fleet-wide connectivity we are no longer
 * observing. Unknown is reported instead, and consumers fall back.
 */
const STALE_MS = 15 * 60_000

export interface ConnectionStatus {
  /** The provider's verdict. */
  online: boolean
  /** ISO-8601 moment the provider reported it. */
  checkedAt: string
}

/** Record the provider's verdict for one unit. Safe to call every sweep. */
export function noteConnection(deviceId: string, online: boolean, atMs: number = Date.now()): void {
  if (!deviceId) return
  const prev = states.get(deviceId)
  if (prev && prev.online !== online) {
    logger.debug({ deviceId, from: prev.online, to: online }, 'Connection state changed')
  }
  states.set(deviceId, { online, atMs })
}

/**
 * The provider's verdict for one unit, or null when we have none that is
 * current — in which case the caller should fall back rather than guess.
 */
export function connectionStatus(deviceId: string | null | undefined): ConnectionStatus | null {
  if (!deviceId) return null
  const e = states.get(deviceId)
  if (!e) return null
  if (Date.now() - e.atMs > STALE_MS) return null
  return { online: e.online, checkedAt: new Date(e.atMs).toISOString() }
}

/** Observability: how many units the provider currently reports connected. */
export function connectionCounts(): { online: number; offline: number; known: number } {
  let online = 0, offline = 0
  const cutoff = Date.now() - STALE_MS
  for (const e of states.values()) {
    if (e.atMs < cutoff) continue
    if (e.online) online++; else offline++
  }
  return { online, offline, known: online + offline }
}

/** Test seam. */
export function resetConnectionState(): void {
  states.clear()
}
