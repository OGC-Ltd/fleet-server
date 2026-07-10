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
