/**
 * Telemetry poller — fetches frames from a provider on its own cadence, feeds
 * them into the existing `processTelemetry` ingest pipeline, and publishes
 * typed events to the fleet event bus so downstream workers (telemetry.worker,
 * notification.worker, alerts.worker, sim-events.worker) can react without
 * coupling to this module.
 *
 * The alert-row bookkeeping (syncFrameAlerts) and sim-event persistence
 * (persistSimEvents) are NOT called directly here — they're published as
 * events and picked up by alerts.worker/sim-events.worker off the poll
 * cycle's critical path (see event-bus.ts's 'alerts:sync'/'simEvents:persist').
 *
 * ## One instance per provider
 *
 * Everything that varies per provider — the in-flight guard, the rising-edge
 * alert maps, the notify cooldowns, the halt-flag tracking — lives on a
 * `TelemetryPoller` instance, NOT in module scope. That is what lets Wialon
 * and any second provider poll concurrently at different cadences without one
 * starving the other: previously a single shared `isPolling` flag meant a slow
 * Wialon cycle would silently skip the other provider's tick, and the log line
 * would blame the wrong loop. Scheduling itself is delegated to
 * lib/poll-loop.ts, which owns the guard and the watchdog.
 *
 * Adding a provider: `startPoller(new SomeAdapter())`. Nothing else changes.
 */

import { env }                   from '../config/env.js'
import { logger }                from './logger.js'
import { prisma }                from './prisma.js'
import { processTelemetry }      from '../modules/ingest/ingest.service.js'
import { eventBus }              from './event-bus.js'
import type { AlertType }        from './event-bus.js'
import type { SimEvents }        from './simulation.persistence.js'
import { emitDashboardNotice }   from './sse.js'
import { startPollLoop }         from './poll-loop.js'
import type { PollLoopHandle }   from './poll-loop.js'
import type { TelemetryProvider, VehicleTelemetryFrame } from '../providers/telemetry-provider.js'
import { noteSpeedFrame, sweepStaleEpisodes, flushEpisodes } from './speeding-episodes.js'
import { warmSpeedPolicy } from './speed-policy.js'
import { noteFuelFrame } from './fuel-drop-watch.js'
import { noteFaultFrame, noteAlive } from './sensor-faults.js'
import { deriveAlertFlags } from './derived-alerts.js'

// Minimum gap before the SAME vehicle+alert is allowed to notify again. The
// rising-edge map already suppresses a continuously-active flag; this stops a
// flapping condition (e.g. overspeeding that dips below the limit and spikes
// again) from re-spamming the feed until an hour has passed.
const NOTIFY_COOLDOWN_MS = 60 * 60_000

// Max frames processed at once. Firing all ~100 concurrently monopolises every
// connection in the pg pool for the whole cycle, starving interactive API/SSE
// requests (a trivial query would wait 20 s+). Bounding this leaves connections
// free for the dashboard/map while telemetry still refreshes each cycle.
//
// This is a PER-POLLER budget, so N providers can hold N×POLL_CONCURRENCY
// connections at once. Keep it low enough that the sum stays well under the
// pool size (see lib/prisma.ts) — two providers at 6 is already 12.
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
//
// Deliberately MODULE-level, unlike the per-poller alert state below: it is a
// read-only projection of the whole vehicle table keyed by a provider-namespaced
// deviceId (`wialon:123`), so every poller wants exactly the same contents.
// Giving each one its own copy would just re-run the same ~600-row query per
// provider every 5 minutes for identical data.

interface DeviceMeta {
  orgId:           string
  vehicleId:       string
  vehicleName:     string
  plate:           string
  tankCapacityMl:  number
  /** Which overspeed limit applies — see lib/derived-alerts. */
  vehicleType:     string | null
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
// In-flight refresh, shared by every caller. Without this, two pollers whose
// cycles coincide after the TTL lapses each fire the same ~600-row query.
let cacheRefresh: Promise<void> | null = null
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
      vehicleType:        true,
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
    // ZERO, not a 200 L guess, when Wialon states no capacity — 355 of 815
    // active vehicles. The consumer is telemetry.worker's fuelLevelPct, which
    // reads `frame.fuelLevelMl != null && tankCapacityMl` and so yields null on
    // a zero: exactly the honest answer, and the same one the fleet snapshot
    // and db-follower already give. Until now the live SSE path invented a
    // percentage against a tank nobody had measured, so the same vehicle's
    // gauge changed meaning depending on which update it arrived on.
    //
    // Fixed HERE rather than in telemetry.worker because that file carries
    // uncommitted gate-arrival work and must not be swept into this change.
    // Capacity comes from Wialon and only Wialon — the operators write the tank
    // size into the fuel sensor's name and sync-wialon reads it with
    // `tankCapacityOf`. Nothing derives, infers or defaults it.
    tankCapacityMl: (r.tankCapacityLitres ?? 0) * 1000,
    vehicleType:    r.vehicleType ?? null,
    driverId:       r.assignments[0]?.userId ?? null,
    driverName:     r.assignments[0]?.user.fullName ?? null,
  }]))
  cacheLoadedAt = Date.now()
}

async function getDeviceMeta(deviceId: string): Promise<DeviceMeta | null> {
  if (Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    cacheRefresh ??= refreshCache().finally(() => { cacheRefresh = null })
    await cacheRefresh
  }
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

const HALT_FLAGS: AlertType[] = ['lowFuel', 'highEngineTemp', 'lowOil']

/** True if the previously-active alert set equals the current active list. */
function sameAlertSet(prev: Set<AlertType>, current: AlertType[]): boolean {
  if (prev.size !== current.length) return false
  for (const t of current) if (!prev.has(t)) return false
  return true
}

// ─── one poller per provider ───────────────────────────────────────────────

class TelemetryPoller {
  /**
   * Per-vehicle "previously active" flags. Ensures alert:triggered fires ONCE
   * when a flag first becomes true, not on every subsequent poll cycle while
   * the condition persists.
   */
  private readonly prevActiveMap = new Map<string, Set<AlertType>>()

  /** vehicleId:alertType → epoch ms last notified — the 1-hour re-arm window. */
  private readonly lastNotifiedAt = new Map<string, number>()

  /**
   * Halt-causing flags active last cycle, per vehicle. When they clear and the
   * engine is back on we emit a "back on road" notice.
   */
  private readonly haltFlagsPrev = new Map<string, Set<AlertType>>()

  constructor(private readonly provider: TelemetryProvider) {}

  async runCycle(): Promise<void> {
    const t0 = Date.now()
    let frames: VehicleTelemetryFrame[]

    try {
      frames = await this.provider.fetchAll()
    } catch (err) {
      logger.error({ err, provider: this.provider.name }, 'Provider fetchAll() failed — skipping cycle')
      return
    }

    let processed = 0, skipped = 0, errors = 0

    await runWithConcurrency(frames, POLL_CONCURRENCY, async (frame) => {
      const meta = await getDeviceMeta(frame.deviceId)
      if (!meta) { skipped++; return }
      // Zone speed limits need the org's zones in memory (lib/speed-policy).
      // A cache hit after the first frame; never throws.
      await warmSpeedPolicy(meta.orgId)

      // Flags this fleet's own telemetry can answer, for providers that send
      // none. ORed on, never assigned: a provider that computes its own alerts
      // keeps every one of them, and this can only add.
      //
      // Applied HERE, before the frame is persisted, so the `flags` written
      // into rawPayload are the same ones the alert rows are opened from.
      // db-follower reads that stored copy to rebuild a frame, so deriving
      // after the write would give the two paths different answers for the
      // same fix.
      const derived = deriveAlertFlags(frame, {
        orgId:          meta.orgId,
        vehicleId:      meta.vehicleId,
        tankCapacityMl: meta.tankCapacityMl,
        vehicleType:    meta.vehicleType,
      })
      for (const [k, v] of Object.entries(derived)) {
        if (v) (frame.flags as Record<string, unknown>)[k] = true
      }

      // The same frames, watched as EPISODES rather than per-frame flags.
      //
      // Here rather than inside deriveAlertFlags, which is documented as
      // returning flags and nothing else and is also driven by db-follower on
      // API-only instances — capture belongs behind the POLL_ENABLED gate that
      // makes this the single writer. Costs one Map lookup; the write is
      // published to speeding.worker, never awaited in a frame's turn.
      noteSpeedFrame(frame, {
        orgId:       meta.orgId,
        vehicleId:   meta.vehicleId,
        vehicleType: meta.vehicleType,
        driverId:    meta.driverId,
        driverName:  meta.driverName,
      })

      // A tank that has dropped while the machine stood still — the fast path
      // beside the adjudicator, which is authoritative but waits on the
      // provider's report. Provisional and never worded as theft; see
      // lib/fuel-drop-watch. Published rather than awaited, like the rest.
      const drop = noteFuelFrame(frame, {
        orgId:     meta.orgId,
        vehicleId: meta.vehicleId,
        plate:     meta.plate ?? null,
      })
      if (drop) eventBus.publish('fuel:dropped', drop)

      // Sensor contradictions this frame proves on its own, and the fact that a
      // frame arrived at all — which is what closes a signal_lost the sweep
      // opened, accurate to the ping rather than to the next 15-minute grid.
      noteFaultFrame(frame, { orgId: meta.orgId, vehicleId: meta.vehicleId })
      noteAlive(frame, { orgId: meta.orgId, vehicleId: meta.vehicleId })

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
          ignitionKnown: frame.ignitionKnown,
          engineHoursMeter: frame.engineHoursMeter ?? undefined,
          accelXG:       frame.accelG?.x ?? undefined,
          accelYG:       frame.accelG?.y ?? undefined,
          accelZG:       frame.accelG?.z ?? undefined,
          fuelLevelMl:   frame.fuelLevelMl ?? undefined,
          fuelUsedMl:    frame.fuelUsedMl ?? undefined,
          cargoWeightKg: frame.cargoWeightKg ?? undefined,

          // Camera, where the unit has one. `undefined` rather than null on the
          // 1,495 units without a recorder, so the optional fields simply do
          // not appear in the payload — ingest turns them into explicit nulls
          // at the column.
          cameraFitted:     frame.flags?.camera?.hasCamera ?? undefined,
          cameraStreamUrl:  frame.flags?.camera?.streamUrl ?? undefined,
          cameraRecording:  frame.flags?.camera?.recording ?? undefined,
          cameraSignalLost: frame.flags?.camera?.signalLost ?? undefined,
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
          vehicleType:    meta.vehicleType,
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
        const prevActive = this.prevActiveMap.get(meta.vehicleId)
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
        const prevHalts   = this.haltFlagsPrev.get(meta.vehicleId) ?? new Set<AlertType>()
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
        this.haltFlagsPrev.set(meta.vehicleId, activeHalts)

        // 5. Emit SSE+Push ONLY for flags that are newly active this cycle
        //    (rising-edge detection — prevents flooding the feed every 30 s
        //    while a condition like lowFuel or highEngineTemp persists)
        const newlyActive = activeAlertTypes.filter(k => !(prevActive?.has(k)))
        this.prevActiveMap.set(meta.vehicleId, new Set(activeAlertTypes))

        const nowMs = Date.now()
        for (const flagKey of newlyActive) {
          // Suppress a re-notification if this vehicle+alert fired within the
          // last hour — a persistent/flapping issue is reported only once until
          // the re-arm window elapses.
          const cooldownKey = `${meta.vehicleId}:${flagKey}`
          if (nowMs - (this.lastNotifiedAt.get(cooldownKey) ?? 0) < NOTIFY_COOLDOWN_MS) continue
          this.lastNotifiedAt.set(cooldownKey, nowMs)

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
              // Carried for the feed's overspeeding sentence, which names the
              // driver and the limit that was broken. Both are already in this
              // 5-minute cache, so neither costs a query here — which is the
              // whole reason driverName was folded into DeviceMeta.
              driverName:      meta.driverName,
              vehicleType:     meta.vehicleType,
            },
          })
        }

      } catch (err) {
        errors++
        logger.error({ err, deviceId: frame.deviceId }, 'processTelemetry error')
      }
    })

    // A unit that stops reporting mid-episode never produces a falling edge, so
    // its episode would stay open forever. Iterates only units currently
    // speeding — single digits on these fleets.
    sweepStaleEpisodes()

    logger.info(
      {
        provider:   this.provider.name,
        durationMs: Date.now() - t0,
        total:      frames.length,
        processed,
        skipped,
        errors,
      },
      'Poll cycle complete',
    )
  }
}

// ─── public lifecycle API ─────────────────────────────────────────────────

export interface PollerHandle {
  stop: () => void
  /** Flush any provider-held state (e.g. simulation snapshot) to durable storage. */
  flush: () => Promise<void>
}

export interface StartPollerOptions {
  /** Override the global POLL_INTERVAL_MS for this provider. */
  intervalMs?: number
  /** Stagger the first cycle so co-starting pollers don't contend for the pool. */
  startDelayMs?: number
}

/**
 * The provider is REQUIRED. It used to default to the mock raifactorysuite
 * simulator, which is now retired — with the production database live, a
 * defaulted `startPoller()` would have quietly resumed writing simulated
 * positions over real fleet data. Callers must name the provider they mean.
 *
 * Safe to call more than once, with different providers and cadences: each
 * call gets its own state and its own scheduling loop.
 */
export function startPoller(provider: TelemetryProvider, opts: StartPollerOptions = {}): PollerHandle {
  const poller = new TelemetryPoller(provider)

  const loop: PollLoopHandle = startPollLoop({
    name:         `telemetry:${provider.name}`,
    intervalMs:   opts.intervalMs ?? env.POLL_INTERVAL_MS,
    startDelayMs: opts.startDelayMs ?? 0,
    run:          () => poller.runCycle(),
  })

  return {
    stop() {
      loop.stop()
    },
    async flush() {
      // Close open speeding episodes at their real last over-limit frame — NOT
      // at `now`, which would claim the unit was speeding until the process
      // died. See flushEpisodes.
      flushEpisodes()
      // Persist the latest simulation state so a restart resumes from here.
      const p = provider as TelemetryProvider & { persist?: () => Promise<void> }
      if (typeof p.persist === 'function') {
        await p.persist().catch(err => logger.warn({ err }, 'Poller flush failed'))
      }
    },
  }
}
