/**
 * Telemetry poller — fetches frames from the configured provider every
 * POLL_INTERVAL_MS, feeds them into the existing `processTelemetry` ingest
 * pipeline, and publishes typed events to the fleet event bus so downstream
 * workers (telemetry.worker, notification.worker, alerts.worker,
 * sim-events.worker) can react without coupling to this module.
 *
 * The alert-row bookkeeping (syncFrameAlerts) and sim-event persistence
 * (persistSimEvents) are NOT called directly here — they're published as
 * events and picked up by alerts.worker/sim-events.worker off the poll
 * cycle's critical path (see event-bus.ts's 'alerts:sync'/'simEvents:persist').
 *
 * Swapping providers:
 *   Change the `provider` argument to `startPoller`.  Nothing else changes.
 */

import { logger }                from './logger.js'
import { prisma }                from './prisma.js'
import { processTelemetry }      from '../modules/ingest/ingest.service.js'
import { eventBus }              from './event-bus.js'
import type { AlertType }        from './event-bus.js'
import type { SimEvents }        from './simulation.persistence.js'
import { emitDashboardNotice }   from './sse.js'
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
  // Currently-assigned driver, folded into this same 5-min cache so
  // processTelemetry/persistSimEvents don't each re-query vehicleAssignment
  // per frame per cycle. Driver reassignment is a rare admin action, so a
  // few minutes of staleness here is an acceptable tradeoff for cutting 2
  // DB round-trips per vehicle per poll cycle.
  driverId:        string | null
  driverName:      string | null
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
      assignments: {
        where: { unassignedAt: null },
        select: { userId: true, user: { select: { fullName: true } } },
        take: 1,
      },
    },
  })
  deviceCache   = new Map(rows.map(r => [r.deviceId, {
    orgId:          r.organisationId,
    vehicleId:      r.id,
    vehicleName:    r.name,
    plate:          r.registrationPlate,
    tankCapacityMl: (r.tankCapacityLitres ?? 200) * 1000,
    driverId:       r.assignments[0]?.userId ?? null,
    driverName:     r.assignments[0]?.user.fullName ?? null,
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
  'engineIdling',
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

// Tracks which halt-causing flags were active last cycle per vehicle.
// When all three clear and the engine is back on we emit a "back on road" notice.
const haltFlagsPrev  = new Map<string, Set<AlertType>>()
const HALT_FLAGS: AlertType[] = ['lowFuel', 'highEngineTemp', 'lowOil']

/** True if the previously-active alert set equals the current active list. */
function sameAlertSet(prev: Set<AlertType>, current: AlertType[]): boolean {
  if (prev.size !== current.length) return false
  for (const t of current) if (!prev.has(t)) return false
  return true
}

// ─── single poll cycle ─────────────────────────────────────────────────────
// Guard prevents a slow cycle from overlapping with the next interval tick.

// Hard ceiling on one cycle. Normal cycles run 5–100 s; if the pooler drops a
// pg connection mid-cycle the cycle's promise can hang forever (Jul 2026: the
// in-flight guard then skipped every tick for 3 days while the process stayed
// alive, so pm2 never restarted it). The watchdog abandons the cycle and
// re-arms the guard so the next tick can start.
const CYCLE_TIMEOUT_MS = 5 * 60_000

let isPolling = false

async function runOnePollCycle(provider: TelemetryProvider): Promise<void> {
  if (isPolling) {
    logger.warn({ provider: provider.name }, 'Previous poll cycle still running — skipping this tick')
    return
  }
  isPolling = true
  const t0 = Date.now()

  const cycle = _runOnePollCycle(provider).then(
    () => 'settled' as const,
    (err) => {
      logger.error({ err, provider: provider.name }, 'Poll cycle failed')
      return 'settled' as const
    },
  )

  // unref: a pending watchdog must not keep the process alive after stop().
  let watchdogTimer!: NodeJS.Timeout
  const watchdog = new Promise<'timeout'>((resolve) => {
    watchdogTimer = setTimeout(() => resolve('timeout'), CYCLE_TIMEOUT_MS).unref()
  })

  const outcome = await Promise.race([cycle, watchdog])
  clearTimeout(watchdogTimer)

  if (outcome === 'timeout') {
    logger.error(
      { provider: provider.name, timeoutMs: CYCLE_TIMEOUT_MS },
      'Poll cycle exceeded watchdog timeout — abandoning it and re-arming the poller',
    )
    // If the abandoned cycle ever settles, its only remaining continuation is
    // this log line — it can no longer touch isPolling (this call has already
    // reset it, and a later cycle may own the guard by then).
    void cycle.then(() =>
      logger.warn(
        { provider: provider.name, durationMs: Date.now() - t0 },
        'Abandoned poll cycle eventually settled',
      ),
    )
  }
  isPolling = false
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
        // 1. Persist to DB + emit per-vehicle SSE (existing ingest pipeline).
        //    Pre-resolved {vehicleId, driverId} from the device cache skips
        //    the vehicle + assignment lookups processTelemetry would otherwise
        //    make itself — 2 fewer round-trips per vehicle per cycle.
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
        }, { vehicleId: meta.vehicleId, driverId: meta.driverId })
        processed++

        // 2. Publish processed event for workers (dashboard SSE, etc.)
        eventBus.publish('telemetry:processed', {
          frame,
          orgId:          meta.orgId,
          vehicleId:      meta.vehicleId,
          vehicleName:    meta.vehicleName,
          plate:          meta.plate,
          tankCapacityMl: meta.tankCapacityMl,
          driverName:     meta.driverName,
        })

        // 3. Determine which flags are currently active
        const activeAlertTypes = FLAG_KEYS.filter(k => frame.flags[k])

        // 4. Persist open/resolved alerts — but ONLY when this vehicle's active
        //    alert set actually changed since last cycle. When it's unchanged
        //    (the common case: a healthy vehicle, or a persistent condition),
        //    the DB already holds exactly the right open rows, so we skip 3
        //    queries/vehicle/cycle. This is the main lever that keeps the poll
        //    cycle fast at 100 vehicles over a remote pooler.
        //
        //    Published to the event bus (alerts.worker) instead of awaited
        //    here: this frame's turn in the concurrency-bounded loop above
        //    completes as soon as the fast path (upsert + SSE emit) is done,
        //    instead of blocking on alert-row bookkeeping before the next
        //    vehicle in the batch gets its turn.
        const prevActive = prevActiveMap.get(meta.vehicleId)
        const alertsChanged = prevActive === undefined || !sameAlertSet(prevActive, activeAlertTypes)
        if (alertsChanged) {
          eventBus.publish('alerts:sync', {
            orgId:       meta.orgId,
            vehicleId:   meta.vehicleId,
            deviceId:    frame.deviceId,
            frame,
            activeTypes: activeAlertTypes,
          })
        }

        // 4b. Persist simulation lifecycle events (completed trips, fuel theft,
        //     self-heal refuels) surfaced on the frame. Also published to the
        //     event bus (sim-events.worker) rather than awaited — a trip
        //     completion writes a Trip + CargoManifest (+ driver rating
        //     update), which is exactly the kind of multi-round-trip work
        //     that shouldn't hold up the poll cycle's per-vehicle turn.
        const simEvents = (frame.rawPayload as { _sim?: { events?: SimEvents } } | undefined)?._sim?.events
        if (simEvents) {
          eventBus.publish('simEvents:persist', {
            orgId:     meta.orgId,
            vehicleId: meta.vehicleId,
            deviceId:  frame.deviceId,
            events:    simEvents,
            vehicleMeta: {
              plate:       meta.plate,
              vehicleName: meta.vehicleName,
              driverId:    meta.driverId,
            },
          })
        }

        // 4c. Detect halt-flag clearing → emit "vehicle back on road" notice
        const activeHalts = new Set(HALT_FLAGS.filter(f => frame.flags[f as keyof typeof frame.flags]))
        const prevHalts   = haltFlagsPrev.get(meta.vehicleId) ?? new Set<AlertType>()
        const justCleared = [...prevHalts].filter(f => !activeHalts.has(f))
        if (justCleared.length > 0 && frame.engineOn) {
          emitDashboardNotice(meta.orgId, {
            noticeType:    'vehicleOnline',
            vehicleId:     meta.vehicleId,
            plate:         meta.plate,
            vehicleName:   meta.vehicleName,
            resolvedFlags: justCleared,
            capturedAt:    frame.capturedAt.toISOString(),
          })
        }
        haltFlagsPrev.set(meta.vehicleId, activeHalts)

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

/**
 * The provider is REQUIRED. It used to default to the mock Controltech
 * simulator, which is now retired — with the production database live, a
 * defaulted `startPoller()` would have quietly resumed writing simulated
 * positions over real fleet data. Callers must name the provider they mean.
 */
export function startPoller(provider: TelemetryProvider): PollerHandle {
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
