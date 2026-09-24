import type { Response } from 'express'

interface SseClient {
  res: Response
  /**
   * The vehicles this connection may be told about. NULL means no restriction.
   *
   * A stream is a subscription, not a read, so it cannot be filtered by the
   * route guard that let it open — every event has to be judged as it is
   * written. Without this, a dashboard client scoped to three trucks would
   * still receive live positions and alerts for the entire fleet: the payloads
   * were already on the wire, and only the UI was ever narrowing them.
   */
  vehicleIds: Set<string> | null
  /** Who opened it, so a revoked account's streams can be closed. */
  userId?: string
}

/**
 * May this client be told about this event?
 *
 * Fails CLOSED for a scoped client: an event that names no vehicle is withheld
 * rather than broadcast, because "it has no vehicleId" is not evidence that it
 * concerns a vehicle this person may see. Keep-alives are the exception -
 * withholding those would just kill the connection.
 */
function visibleTo(client: SseClient, event: string, data: unknown): boolean {
  if (client.vehicleIds === null) return true
  if (event === 'heartbeat' || event === 'connected') return true
  const vehicleId = (data as { vehicleId?: unknown } | null)?.vehicleId
  return typeof vehicleId === 'string' && client.vehicleIds.has(vehicleId)
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
  // Per-vehicle streams need no scope of their own: the route that opened this
  // one already proved the caller may see THAT vehicle, and it carries nothing
  // else.
  const client: SseClient = { res, vehicleIds: null }
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
export function replayDashboardPositions(
  orgId: string,
  res: Response,
  vehicleIds: Set<string> | null = null,
): number {
  const positions = lastPositions.get(orgId)
  if (!positions?.size) return 0
  let sent = 0
  // The replay is the entire fleet as of the last tick, so leaving it unscoped
  // would hand a restricted client everything the live stream withholds.
  for (const [vehicleId, data] of positions) {
    if (vehicleIds && !vehicleIds.has(vehicleId)) continue
    try {
      res.write(`event: position\ndata: ${JSON.stringify(data, bigIntReplacer)}\n\n`)
      sent++
    } catch { /* client disconnected mid-replay */ }
  }
  return sent
}

function broadcastDashboard(orgId: string, event: string, data: unknown) {
  const key     = dashboardKey(orgId)
  const clients = registry.get(key)
  if (!clients?.size) return
  const payload = `event: ${event}\ndata: ${JSON.stringify(data, bigIntReplacer)}\n\n`
  for (const client of clients) {
    if (!visibleTo(client, event, data)) continue
    try { client.res.write(payload) } catch { /* client disconnected */ }
  }
}

export function registerDashboardClient(
  orgId: string,
  res: Response,
  scope: { vehicleIds?: Set<string> | null; userId?: string } = {},
): () => void {
  const key = dashboardKey(orgId)
  if (!registry.has(key)) registry.set(key, new Set())
  const client: SseClient = { res, vehicleIds: scope.vehicleIds ?? null, userId: scope.userId }
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
export async function replayDashboardFeed(
  orgId: string,
  res: Response,
  limit = 40,
  vehicleIds: Set<string> | null = null,
): Promise<number> {
  const { getNotifications } = await import('./notifications/notification.reader.js')
  const { items } = await getNotifications(orgId, { limit })

  // getNotifications returns newest-first; the panel wants the replay in
  // arrival order so its prepend leaves the newest at the top.
  let sent = 0
  for (const item of [...items].reverse()) {
    // Same fail-closed rule as the live stream: a scoped client is not shown a
    // history item that names no vehicle it may see.
    if (vehicleIds) {
      const vid = (item as { vehicleId?: unknown }).vehicleId
      if (typeof vid !== 'string' || !vehicleIds.has(vid)) continue
    }
    try {
      res.write(`event: feed\ndata: ${JSON.stringify({ ...item, orgId }, bigIntReplacer)}\n\n`)
      sent++
    } catch { /* client disconnected mid-replay */ }
  }
  return sent
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

/**
 * The unit's paperwork changed — what it is carrying, where it is taking it,
 * who signed for it.
 *
 * A position frame cannot carry this. Wialon emits one only when a fix time
 * advances, so a truck standing at the gate with 29 t on the bed may not
 * produce another for an hour, and the load it just signed out with would sit
 * unannounced until the browser next re-read the snapshot. This is pushed by
 * the paperwork instead of by the wheels.
 *
 * It carries `vehicleId`, so a permission-scoped client is filtered by
 * `visibleTo` like every other event, with no rule of its own.
 */
export function emitDashboardDispatch(orgId: string, data: unknown) {
  broadcastDashboard(orgId, 'dispatch', data)
}

/**
 * A fuel incident was dismissed from the dashboard. Every open client drops it
 * from its alerts list and stops painting the unit red. Carries `vehicleId`,
 * so a vehicle-scoped client only hears about units it can see.
 */
export function emitDashboardFuelIncidentDismissed(orgId: string, data: { vehicleId: string; incidentId: string }) {
  broadcastDashboard(orgId, 'fuel_incident_dismissed', data)
}

/**
 * A fuel follow-up opened or changed hands or status (see FuelTheftFollowUp).
 * Clients re-read the follow-up list; the payload only says which one moved.
 */
export function emitDashboardFuelFollowUp(orgId: string, data: { vehicleId: string; followUpId: string; status: string }) {
  broadcastDashboard(orgId, 'fuel_followup', data)
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

/**
 * Close every dashboard stream this user holds.
 *
 * An access token lives 15 minutes and an SSE connection lives for hours, so
 * revoking a role does not by itself stop a stream that is already open — it
 * was authorised once, at handshake, and never asked again. This is how a
 * revocation reaches one that is already running.
 */
export function closeDashboardStreamsForUser(userId: string): number {
  let closed = 0
  for (const [key, clients] of registry) {
    if (!key.endsWith(':dashboard')) continue
    for (const client of [...clients]) {
      if (client.userId !== userId) continue
      try { client.res.end() } catch { /* already gone */ }
      clients.delete(client)
      closed++
    }
    if (clients.size === 0) registry.delete(key)
  }
  return closed
}
