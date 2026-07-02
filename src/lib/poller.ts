/**
 * Telemetry poller — fetches frames from the configured provider every
 * POLL_INTERVAL_MS, feeds them into the existing `processTelemetry` ingest
 * pipeline, and publishes typed events to the fleet event bus so downstream
 * workers (telemetry.worker, notification.worker) can react without coupling
 * to this module.
 *
 * Swapping providers:
 *   Change the `provider` argument to `startPoller`.  Nothing else changes.
 */

import { logger }                from './logger.js'
import { prisma }                from './prisma.js'
import { processTelemetry }      from '../modules/ingest/ingest.service.js'
import { eventBus }              from './event-bus.js'
import type { AlertType }        from './event-bus.js'
import { syncFrameAlerts }       from './alerts.js'
import { persistSimEvents }      from './simulation.persistence.js'
import type { SimEvents }        from './simulation.persistence.js'
import { ControltechMockAdapter } from '../providers/controltech/controltech.adapter.js'
import type { TelemetryProvider, VehicleTelemetryFrame } from '../providers/telemetry-provider.js'

const POLL_INTERVAL_MS = 30_000   // 30 seconds

// Minimum gap before the SAME vehicle+alert is allowed to notify again. The
// rising-edge map already suppresses a continuously-active flag; this stops a
// flapping condition (e.g. overspeeding that dips below the limit and spikes
// again) from re-spamming the feed until an hour has passed.
const NOTIFY_COOLDOWN_MS = 60 * 60_000

// Max frames processed at once. Firing all ~100 concurrently monopolises every
// connection in the pg pool for the whole cycle, starving interactive API/SSE
// requests (a trivial query would wait 20 s+). Bounding this leaves connections
// free for the dashboard/map while telemetry still refreshes each cycle.
const POLL_CONCURRENCY = 6

/** Run `worker` over `items` with at most `limit` in flight at a time. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0
  const runNext = async (): Promise<void> => {
    const i = idx++
    if (i >= items.length) return
    await worker(items[i]!)
    return runNext()
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runNext()))
}

// ─── device metadata cache ─────────────────────────────────────────────────
// Avoids a DB hit on every frame.  Refreshed every 5 min.

interface DeviceMeta {
  orgId:           string
  vehicleId:       string
  vehicleName:     string
  plate:           string
  tankCapacityMl:  number
}

let deviceCache   = new Map<string, DeviceMeta>()
let cacheLoadedAt = 0
const CACHE_TTL_MS = 5 * 60_000

async function refreshCache(): Promise<void> {
  const rows = await prisma.vehicle.findMany({
    select: {
      deviceId:           true,
      organisationId:     true,
      id:                 true,
      name:               true,
      registrationPlate:  true,
      tankCapacityLitres: true,
    },
  })
  deviceCache   = new Map(rows.map(r => [r.deviceId, {
    orgId:          r.organisationId,
    vehicleId:      r.id,
    vehicleName:    r.name,
    plate:          r.registrationPlate,
    tankCapacityMl: (r.tankCapacityLitres ?? 200) * 1000,
  }]))
  cacheLoadedAt = Date.now()
}

async function getDeviceMeta(deviceId: string): Promise<DeviceMeta | null> {
  if (Date.now() - cacheLoadedAt > CACHE_TTL_MS) await refreshCache()
  return deviceCache.get(deviceId) ?? null
}

// ─── alert flag → AlertType mapping ───────────────────────────────────────

const FLAG_KEYS: Array<keyof VehicleTelemetryFrame['flags'] & AlertType> = [
  'overspeeding',
  'fuelInconsistency',
  'doorOpenWhileMoving',
  'lowFuel',
  'outsideGeofence',
  'lowBattery',
  'highEngineTemp',
  'lowOil',
]

// ─── per-vehicle "previously active" flag tracking ─────────────────────────
// Ensures alert:triggered fires ONCE when a flag first becomes true, not on
// every subsequent 30-s poll cycle while the condition persists.
const prevActiveMap = new Map<string, Set<AlertType>>()

// vehicleId:alertType → epoch ms it was last notified — enforces the 1-hour
// re-arm window so a recurring issue notifies at most once per hour.
const lastNotifiedAt = new Map<string, number>()

/** True if the previously-active alert set equals the current active list. */
function sameAlertSet(prev: Set<AlertType>, current: AlertType[]): boolean {
  if (prev.size !== current.length) return false
  for (const t of current) if (!prev.has(t)) return false
  return true
}

// ─── single poll cycle ─────────────────────────────────────────────────────
// Guard prevents a slow cycle from overlapping with the next interval tick.

let isPolling = false

async function runOnePollCycle(provider: TelemetryProvider): Promise<void> {
  if (isPolling) {
    logger.warn({ provider: provider.name }, 'Previous poll cycle still running — skipping this tick')
    return
  }
  isPolling = true
  try { await _runOnePollCycle(provider) } finally { isPolling = false }
}

async function _runOnePollCycle(provider: TelemetryProvider): Promise<void> {
  const t0 = Date.now()
  let frames: VehicleTelemetryFrame[]

  try {
    frames = await provider.fetchAll()
  } catch (err) {
    logger.error({ err, provider: provider.name }, 'Provider fetchAll() failed — skipping cycle')
    return
  }

  let processed = 0, skipped = 0, errors = 0

  await runWithConcurrency(frames, POLL_CONCURRENCY, async (frame) => {
      const meta = await getDeviceMeta(frame.deviceId)
      if (!meta) { skipped++; return }

      try {
        // 1. Persist to DB + emit per-vehicle SSE (existing ingest pipeline)
        await processTelemetry(meta.orgId, {
          deviceId:      frame.deviceId,
          capturedAt:    frame.capturedAt,
          lat:           frame.lat ?? undefined,
          lng:           frame.lng ?? undefined,
          altitudeM:     frame.altitudeM ?? undefined,
          headingDeg:    frame.headingDeg ?? undefined,
          accuracyM:     frame.accuracyM ?? undefined,
          speedKmh:      frame.speedKmh ?? undefined,
          engineOn:      frame.engineOn,
          fuelLevelMl:   frame.fuelLevelMl ?? undefined,
          fuelUsedMl:    frame.fuelUsedMl ?? undefined,
          cargoWeightKg: frame.cargoWeightKg ?? undefined,
          rawPayload: {
            ...frame.rawPayload,
            batteryVoltageV:    frame.batteryVoltageV,
            doorStatus:         frame.doorStatus,
            panicButtonPressed: frame.panicButtonPressed,
            gpsFixQuality:      frame.gpsFixQuality,
            satelliteCount:     frame.satelliteCount,
            networkType:        frame.networkType,
            signalStrengthPct:  frame.signalStrengthPct,
            flags:              frame.flags,
          },
        })
        processed++

        // 2. Publish processed event for workers (dashboard SSE, etc.)
        eventBus.publish('telemetry:processed', {
          frame,
          orgId:          meta.orgId,
          vehicleId:      meta.vehicleId,
          vehicleName:    meta.vehicleName,
          plate:          meta.plate,
          tankCapacityMl: meta.tankCapacityMl,
        })

        // 3. Determine which flags are currently active
        const activeAlertTypes = FLAG_KEYS.filter(k => frame.flags[k])

        // 4. Persist open/resolved alerts — but ONLY when this vehicle's active
        //    alert set actually changed since last cycle. When it's unchanged
        //    (the common case: a healthy vehicle, or a persistent condition),
        //    the DB already holds exactly the right open rows, so we skip 3
        //    queries/vehicle/cycle. This is the main lever that keeps the poll
        //    cycle fast at 100 vehicles over a remote pooler.
        const prevActive = prevActiveMap.get(meta.vehicleId)
        const alertsChanged = prevActive === undefined || !sameAlertSet(prevActive, activeAlertTypes)
        if (alertsChanged) {
          await syncFrameAlerts(meta.orgId, meta.vehicleId, frame, activeAlertTypes).catch(
            err => logger.warn({ err, deviceId: frame.deviceId }, 'syncFrameAlerts failed'),
          )
        }

        // 4b. Persist simulation lifecycle events (completed trips, fuel theft,
        //     self-heal refuels) surfaced on the frame. Awaited inside the
        //     bounded concurrency like the alert write, and a no-op on cycles
        //     where nothing transitioned.
        const simEvents = (frame.rawPayload as { _sim?: { events?: SimEvents } } | undefined)?._sim?.events
        if (simEvents) {
          await persistSimEvents(meta.orgId, meta.vehicleId, simEvents).catch(
            err => logger.warn({ err, deviceId: frame.deviceId }, 'persistSimEvents failed'),
          )
        }

        // 5. Emit SSE+Push ONLY for flags that are newly active this cycle
        //    (rising-edge detection — prevents flooding the feed every 30 s
        //    while a condition like lowFuel or highEngineTemp persists)
        const newlyActive = activeAlertTypes.filter(k => !(prevActive?.has(k)))
        prevActiveMap.set(meta.vehicleId, new Set(activeAlertTypes))

        const nowMs = Date.now()
        for (const flagKey of newlyActive) {
          // Suppress a re-notification if this vehicle+alert fired within the
          // last hour — a persistent/flapping issue is reported only once until
          // the re-arm window elapses.
          const cooldownKey = `${meta.vehicleId}:${flagKey}`
          if (nowMs - (lastNotifiedAt.get(cooldownKey) ?? 0) < NOTIFY_COOLDOWN_MS) continue
          lastNotifiedAt.set(cooldownKey, nowMs)

          eventBus.publish('alert:triggered', {
            type:        flagKey,
            orgId:       meta.orgId,
            deviceId:    frame.deviceId,
            vehicleId:   meta.vehicleId,
            vehicleName: meta.vehicleName,
            plate:       meta.plate,
            capturedAt:  frame.capturedAt,
            lat:         frame.lat,
            lng:         frame.lng,
            speedKmh:    frame.speedKmh,
            fuelLevelMl: frame.fuelLevelMl,
            meta: {
              batteryVoltageV: frame.batteryVoltageV,
              doorStatus:      frame.doorStatus,
              fuelUsedMl:      frame.fuelUsedMl,
            },
          })
        }

      } catch (err) {
        errors++
        logger.error({ err, deviceId: frame.deviceId }, 'processTelemetry error')
      }
  })

  logger.info(
    {
      provider:   provider.name,
      durationMs: Date.now() - t0,
      total:      frames.length,
      processed,
      skipped,
      errors,
    },
    'Poll cycle complete',
  )
}

// ─── public lifecycle API ─────────────────────────────────────────────────

export interface PollerHandle {
  stop: () => void
  /** Flush any provider-held state (e.g. simulation snapshot) to durable storage. */
  flush: () => Promise<void>
}

export function startPoller(provider: TelemetryProvider = new ControltechMockAdapter()): PollerHandle {
  logger.info({ provider: provider.name, intervalMs: POLL_INTERVAL_MS }, 'Telemetry poller starting')

  void runOnePollCycle(provider)
  const timer = setInterval(() => void runOnePollCycle(provider), POLL_INTERVAL_MS)

  return {
    stop() {
      clearInterval(timer)
      logger.info({ provider: provider.name }, 'Telemetry poller stopped')
    },
    async flush() {
      // Persist the latest simulation state so a restart resumes from here.
      const p = provider as TelemetryProvider & { persist?: () => Promise<void> }
      if (typeof p.persist === 'function') {
        await p.persist().catch(err => logger.warn({ err }, 'Poller flush failed'))
      }
    },
  }
}
