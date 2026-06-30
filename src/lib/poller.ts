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
import { ControltechMockAdapter } from '../providers/controltech/controltech.adapter.js'
import type { TelemetryProvider, VehicleTelemetryFrame } from '../providers/telemetry-provider.js'

const POLL_INTERVAL_MS = 30_000   // 30 seconds

// ─── device metadata cache ─────────────────────────────────────────────────
// Avoids a DB hit on every frame.  Refreshed every 5 min.

interface DeviceMeta {
  orgId:       string
  vehicleId:   string
  vehicleName: string
  plate:       string
}

let deviceCache   = new Map<string, DeviceMeta>()
let cacheLoadedAt = 0
const CACHE_TTL_MS = 5 * 60_000

async function refreshCache(): Promise<void> {
  const rows = await prisma.vehicle.findMany({
    select: {
      deviceId:          true,
      organisationId:    true,
      id:                true,
      name:              true,
      registrationPlate: true,
    },
  })
  deviceCache   = new Map(rows.map(r => [r.deviceId, {
    orgId:       r.organisationId,
    vehicleId:   r.id,
    vehicleName: r.name,
    plate:       r.registrationPlate,
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
]

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

  await Promise.allSettled(
    frames.map(async (frame) => {
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
          orgId:       meta.orgId,
          vehicleId:   meta.vehicleId,
          vehicleName: meta.vehicleName,
          plate:       meta.plate,
        })

        // 3. Publish one alert event per active flag
        for (const flagKey of FLAG_KEYS) {
          if (!frame.flags[flagKey]) continue
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
    }),
  )

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
  }
}
