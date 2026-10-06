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
  /** The batched-event number it registered at; it is sent only later ones. */
  fromSeq?: number
  /** Asked for `position_delta` (changed vehicles and fields only) instead of
   *  full `position` frames — see positionDelta. */
  delta?: boolean
}

/**
 * May this client be told about this event?
 *
 * Fails CLOSED for a scoped client: an event that names no vehicle is withheld
 * rather than broadcast, because "it has no vehicleId" is not evidence that it
 * concerns a vehicle this person may see. Keep-alives are the exception -
 * withholding those would just kill the connection.
 */
function visibleTo(client: SseClient, event: string, vehicleId: string | null): boolean {
  if (client.vehicleIds === null) return true
  if (event === 'heartbeat' || event === 'connected') return true
  return vehicleId !== null && client.vehicleIds.has(vehicleId)
}

function vehicleIdOf(data: unknown): string | null {
  const v = (data as { vehicleId?: unknown } | null)?.vehicleId
  return typeof v === 'string' ? v : null
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
//
// Kept as the serialised SSE frame rather than the object: the frame is built
// once when the position arrives and every replay reuses it. The whole-fleet
// replay is also cached as one Buffer per org (dropped whenever a position
// changes), so a crowd connecting at once — the morning shift, or every
// browser reconnecting after a deploy — costs one encode, not one per client.
// Bench 2026-10-06: the replay is ~320 KB per client at 600 vehicles.
const lastPositions = new Map<string, Map<string, string>>()
const replayCache   = new Map<string, Buffer>()
/** The same positions as plain JSON values — the base each delta is taken
 *  against. Parsed back from the frame, so Dates and bigints compare exactly
 *  as the client received them. */
const lastPositionData = new Map<string, Map<string, Record<string, unknown>>>()

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null
    && JSON.stringify(a) === JSON.stringify(b))

/**
 * What changed in a vehicle's position payload since the last one: the
 * top-level fields whose value differs (objects such as `movement` and
 * `zones` go whole when anything inside them changed), plus `$del` naming
 * fields that disappeared. `vehicleId` is always carried. Null when nothing
 * changed at all — that vehicle is left out of the delta event.
 *
 * Absent and null are different on this wire — a frame with no cargoWeightKg
 * knows nothing about the load, a null one says there is no measurement —
 * so a field that vanished is named in `$del`, never sent as null.
 */
export function positionDelta(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!prev) return { ...next }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(next)) if (!sameValue(prev[k], next[k])) out[k] = next[k]
  const del = Object.keys(prev).filter((k) => !(k in next))
  if (!Object.keys(out).length && !del.length) return null
  if (del.length) out['$del'] = del
  out['vehicleId'] = next['vehicleId']
  return out
}

/** Write the org's cached per-vehicle positions to one client, in one write. */
export function replayDashboardPositions(
  orgId: string,
  res: Response,
  vehicleIds: Set<string> | null = null,
): number {
  const positions = lastPositions.get(orgId)
  if (!positions?.size) return 0
  try {
    if (!vehicleIds) {
      let buf = replayCache.get(orgId)
      if (!buf) {
        buf = Buffer.from([...positions.values()].join(''))
        replayCache.set(orgId, buf)
      }
      res.write(buf)
      return positions.size
    }
    // The replay is the entire fleet as of the last tick, so leaving it
    // unscoped would hand a restricted client everything the live stream
    // withholds.
    const frames: string[] = []
    for (const [vehicleId, frame] of positions) if (vehicleIds.has(vehicleId)) frames.push(frame)
    if (frames.length) res.write(frames.join(''))
    return frames.length
  } catch {
    return 0   // client disconnected mid-replay
  }
}

// ─── batched delivery ──────────────────────────────────────────────────────
//
// Dashboard events are queued per org and written every FLUSH_MS as ONE write
// per client, instead of one write per event per client.
//
// Bench 2026-10-06 (bench/realtime.mjs, 600 vehicles, 3000 viewers): a tick was
// 1.8 M individual writes, each re-encoding the same string, and it froze the
// event loop for ~7 s every 30 s — new streams were refused, API calls queued
// behind it, RSS reached ~1 GB. Batched, a tick is one Buffer per org, encoded
// once and shared by every unscoped client, and one write per client.
//
// For a client that did not ask for deltas the wire format is unchanged: a
// batch is the same `event:`/`data:` frames, concatenated. Order is kept,
// because every dashboard event goes through the same per-org queue. The price
// is at most FLUSH_MS of extra delay on an event; positions tick every 30 s.
//
// A client that opened /live?delta=1 gets each run of positions in a batch as
// ONE `position_delta` event: an array of positionDelta()s, vehicles with
// nothing new left out. Everything else (alerts, feed, dispatch …) is the same
// frame in the same place. Its replay on connect is still full `position`
// frames — that is the base its deltas apply to.

const FLUSH_MS = 150

/**
 * How far a client may fall behind before it is cut loose. A viewer on a dead
 * link otherwise makes the server hold every tick for it (~330 KB each at 600
 * vehicles) until TCP gives up, which takes minutes. Closing it lets
 * EventSource reconnect and take the replay, which is the current fleet anyway.
 */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

interface Queued {
  seq: number; event: string; vehicleId: string | null; frame: string
  /** Position events only: the change since the vehicle's previous position,
   *  or null when nothing changed. */
  delta?: Record<string, unknown> | null
}
const outbox = new Map<string, Queued[]>()
let flushTimer: NodeJS.Timeout | null = null
/** Monotonic event number. A client registered mid-window takes only events
 *  queued after it — earlier ones are already in its replay. */
let seq = 0

function frameOf(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data, bigIntReplacer)}\n\n`
}

function enqueueDashboard(
  orgId: string, event: string, vehicleId: string | null, frame: string,
  delta?: Record<string, unknown> | null,
) {
  if (!registry.get(dashboardKey(orgId))?.size) return
  let q = outbox.get(orgId)
  if (!q) { q = []; outbox.set(orgId, q) }
  q.push({ seq: ++seq, event, vehicleId, frame, delta })
  if (!flushTimer) {
    flushTimer = setTimeout(flushDashboards, FLUSH_MS)
    flushTimer.unref?.()
  }
}

function flushDashboards() {
  flushTimer = null
  for (const [orgId, items] of outbox) {
    outbox.delete(orgId)
    const clients = registry.get(dashboardKey(orgId))
    if (!clients?.size) continue
    const firstSeq = items[0]!.seq
    // One encode per org per wire format, shared by every unscoped client.
    let sharedFull: Buffer | null = null
    let sharedDelta: Buffer | null = null
    for (const client of [...clients]) {
      if (client.vehicleIds === null && (client.fromSeq ?? 0) < firstSeq) {
        const buf = client.delta
          ? (sharedDelta ??= Buffer.from(encodeBatch(items, true)))
          : (sharedFull  ??= Buffer.from(encodeBatch(items, false)))
        if (buf.length) writeOrDrop(client, buf, clients)
        continue
      }
      const mine = items.filter((i) => i.seq > (client.fromSeq ?? 0) && visibleTo(client, i.event, i.vehicleId))
      const chunk = encodeBatch(mine, client.delta === true)
      if (chunk) writeOrDrop(client, chunk, clients)
    }
  }
}

/** A batch on the wire: full frames, or with each run of positions folded into
 *  one `position_delta` event. */
function encodeBatch(items: Queued[], delta: boolean): string {
  if (!delta) return items.map((i) => i.frame).join('')
  let out = ''
  let run: Record<string, unknown>[] = []
  const closeRun = () => {
    if (run.length) out += `event: position_delta\ndata: ${JSON.stringify(run)}\n\n`
    run = []
  }
  for (const i of items) {
    if (i.event === 'position' && i.delta !== undefined) {
      if (i.delta) run.push(i.delta)
      continue
    }
    closeRun()
    out += i.frame
  }
  closeRun()
  return out
}

function writeOrDrop(client: SseClient, chunk: Buffer | string, clients: Set<SseClient>) {
  try {
    if (client.res.writableLength > MAX_BUFFERED_BYTES) {
      clients.delete(client)
      client.res.end()
      return
    }
    client.res.write(chunk)
  } catch { /* client disconnected */ }
}

function broadcastDashboard(orgId: string, event: string, data: unknown) {
  if (!registry.get(dashboardKey(orgId))?.size) return
  enqueueDashboard(orgId, event, vehicleIdOf(data), frameOf(event, data))
}

/**
 * A keep-alive for ONE connection, written straight to it.
 *
 * This used to be emitDashboardHeartbeat(orgId), called from a timer every
 * client starts — so each client's timer broadcast to EVERY client in the org:
 * N clients, N² writes per 25 s. Bench 2026-10-06: 1000 viewers froze the
 * server for 14 s and 3072 API calls were refused. A keep-alive only has to
 * keep its own socket warm.
 */
export function writeHeartbeat(res: Response): void {
  try { res.write(frameOf('heartbeat', { ts: new Date().toISOString() })) } catch { /* client gone */ }
}

export function registerDashboardClient(
  orgId: string,
  res: Response,
  scope: { vehicleIds?: Set<string> | null; userId?: string; delta?: boolean } = {},
): () => void {
  const key = dashboardKey(orgId)
  if (!registry.has(key)) registry.set(key, new Set())
  const client: SseClient = {
    res, vehicleIds: scope.vehicleIds ?? null, userId: scope.userId, fromSeq: seq, delta: scope.delta === true,
  }
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
  const vehicleId = vehicleIdOf(data)
  const json  = JSON.stringify(data, bigIntReplacer)
  const frame = `event: position\ndata: ${json}\n\n`
  // No vehicleId, no base to diff against: such a frame goes out whole to
  // delta clients too (`delta` left undefined).
  let delta: Record<string, unknown> | null | undefined
  if (vehicleId) {
    if (!lastPositions.has(orgId)) lastPositions.set(orgId, new Map())
    lastPositions.get(orgId)!.set(vehicleId, frame)
    replayCache.delete(orgId)
    // The base is kept current even with nobody watching, so the first delta
    // after a client connects is taken against exactly what its replay held.
    if (!lastPositionData.has(orgId)) lastPositionData.set(orgId, new Map())
    const bases = lastPositionData.get(orgId)!
    const next = JSON.parse(json) as Record<string, unknown>
    delta = positionDelta(bases.get(vehicleId), next)
    bases.set(vehicleId, next)
  }
  enqueueDashboard(orgId, 'position', vehicleId, frame, delta)
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

/**
 * A repair job changed: filed, moved, assigned, signed off, or its overhaul
 * (inspections, spare parts) written. Clients re-read Maintenance > Repairs
 * and Fuel > Audit, which show the same jobs; the payload carries nothing.
 */
export function emitDashboardRepairChanged(orgId: string) {
  broadcastDashboard(orgId, 'repair_changed', { at: new Date().toISOString() })
}

/** Alert notification — powers the alert feed and banner toasts. */
export function emitDashboardAlert(orgId: string, data: unknown) {
  broadcastDashboard(orgId, 'alert', data)
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
