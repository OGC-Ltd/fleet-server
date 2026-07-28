import type { Response } from 'express'

interface SseClient {
  res: Response
}

// In-process SSE registry.
//   Per-vehicle key: "orgId:vehicleId"
//   Org-wide dashboard key: "orgId:dashboard"
// Upgrade path: replace with Redis pub/sub for multi-instance deployments —
// the emit functions become redis.publish() calls and each instance subscribes.
const registry = new Map<string, Set<SseClient>>()

function channelKey(orgId: string, vehicleId: string) {
  return `${orgId}:${vehicleId}`
}

export function registerSseClient(orgId: string, vehicleId: string, res: Response): () => void {
  const key = channelKey(orgId, vehicleId)
  if (!registry.has(key)) registry.set(key, new Set())
  const client: SseClient = { res }
  registry.get(key)!.add(client)
  return () => {
    registry.get(key)?.delete(client)
    if (registry.get(key)?.size === 0) registry.delete(key)
  }
}

function broadcast(orgId: string, vehicleId: string, event: string, data: unknown) {
  const key = channelKey(orgId, vehicleId)
  const clients = registry.get(key)
  if (!clients?.size) return
  const payload = `event: ${event}\ndata: ${JSON.stringify(data, bigIntReplacer)}\n\n`
  for (const client of clients) {
    try {
      client.res.write(payload)
    } catch {
      // client disconnected mid-write — cleanup handled by 'close' event
    }
  }
}

export function emitTelemetry(orgId: string, vehicleId: string, data: unknown) {
  broadcast(orgId, vehicleId, 'telemetry', data)
}

export function emitViolation(orgId: string, vehicleId: string, data: unknown) {
  broadcast(orgId, vehicleId, 'geofence_violation', data)
}

export function emitHeartbeat(orgId: string, vehicleId: string) {
  broadcast(orgId, vehicleId, 'heartbeat', { ts: new Date().toISOString() })
}

function bigIntReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value
}

// ─── org-wide dashboard channel ────────────────────────────────────────────
// Streams position updates for ALL vehicles in an org + alert notifications.
// Dashboard clients subscribe once and receive the full fleet picture.

function dashboardKey(orgId: string) {
  return `${orgId}:dashboard`
}

// Last position payload per vehicle, per org — replayed to a newly connected
// dashboard client so its map reflects the fleet as of the LAST poll tick
// immediately, instead of waiting up to a full tick (30 s) for fresh events.
// This closes the window where two browsers opened moments apart disagree.
const lastPositions = new Map<string, Map<string, unknown>>()

/** Write the org's cached per-vehicle positions straight to one client. */
export function replayDashboardPositions(orgId: string, res: Response): number {
  const positions = lastPositions.get(orgId)
  if (!positions?.size) return 0
  for (const data of positions.values()) {
    try {
      res.write(`event: position\ndata: ${JSON.stringify(data, bigIntReplacer)}\n\n`)
    } catch { /* client disconnected mid-replay */ }
  }
  return positions.size
}

function broadcastDashboard(orgId: string, event: string, data: unknown) {
  const key     = dashboardKey(orgId)
  const clients = registry.get(key)
  if (!clients?.size) return
  const payload = `event: ${event}\ndata: ${JSON.stringify(data, bigIntReplacer)}\n\n`
  for (const client of clients) {
    try { client.res.write(payload) } catch { /* client disconnected */ }
  }
}

export function registerDashboardClient(orgId: string, res: Response): () => void {
  const key = dashboardKey(orgId)
  if (!registry.has(key)) registry.set(key, new Set())
  const client: SseClient = { res }
  registry.get(key)!.add(client)
  return () => {
    registry.get(key)?.delete(client)
    if (registry.get(key)?.size === 0) registry.delete(key)
  }
}

/**
 * Human activity-feed item (dispatch / arrival / offload / alert …) — powers
 * the Live Feed panel.
 *
 * Delivered ONLY to the owning organisation's dashboard clients.
 *
 * This used to buffer into a single 60-item ring shared by every org and
 * broadcast to all of them, on the theory that the panel showed "the whole
 * platform's activity". The client never agreed: useFleetLive drops any item
 * whose `orgId` is not the active one. The result was that the noisiest org
 * starved every other one — KASULU emits a zone crossing every few seconds, so
 * a SUKARI client would receive 60 replayed items, discard 58 of them, and
 * watch its remaining 2 get evicted from the shared ring within seconds. Its
 * Live Feed went permanently empty while the platform was visibly busy.
 *
 * History now comes from the durable per-org store instead of a ring buffer
 * (see replayDashboardFeed), so nothing here needs to retain anything.
 */
export function emitDashboardFeed(orgId: string, item: unknown) {
  const stamped = { ...(item as Record<string, unknown>), orgId }
  broadcastDashboard(orgId, 'feed', stamped)
}

/**
 * Replay this organisation's recent feed history to one newly-connected
 * client, oldest-first (the client prepends, so it lands newest-first).
 *
 * Reads the durable store — Redis cache first, Postgres behind it — rather
 * than an in-memory buffer. Two things follow from that: history survives a
 * restart, and one org's traffic can no longer crowd out another's, because
 * each org is queried for its own rows.
 */
export async function replayDashboardFeed(orgId: string, res: Response, limit = 40): Promise<number> {
  const { getNotifications } = await import('./notifications/notification.reader.js')
  const { items } = await getNotifications(orgId, { limit })

  // getNotifications returns newest-first; the panel wants the replay in
  // arrival order so its prepend leaves the newest at the top.
  for (const item of [...items].reverse()) {
    try {
      res.write(`event: feed\ndata: ${JSON.stringify({ ...item, orgId }, bigIntReplacer)}\n\n`)
    } catch { /* client disconnected mid-replay */ }
  }
  return items.length
}

/** Vehicle position + state snapshot — powers the live map markers. */
export function emitDashboardPosition(orgId: string, data: unknown) {
  const vehicleId = (data as { vehicleId?: string } | null)?.vehicleId
  if (vehicleId) {
    if (!lastPositions.has(orgId)) lastPositions.set(orgId, new Map())
    lastPositions.get(orgId)!.set(vehicleId, data)
  }
  broadcastDashboard(orgId, 'position', data)
}

/** Alert notification — powers the alert feed and banner toasts. */
export function emitDashboardAlert(orgId: string, data: unknown) {
  broadcastDashboard(orgId, 'alert', data)
}

/** Keep long-lived SSE connections alive across proxy timeouts. */
export function emitDashboardHeartbeat(orgId: string) {
  broadcastDashboard(orgId, 'heartbeat', { ts: new Date().toISOString() })
}

/** Lifecycle notice (refuel, vehicle back online, etc.) — powers the notification inbox. */
export function emitDashboardNotice(orgId: string, data: unknown) {
  broadcastDashboard(orgId, 'notice', data)
}
