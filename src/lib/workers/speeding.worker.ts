/**
 * Speeding worker — subscribes to 'speeding:closed' and writes one
 * `speeding_incidents` row per completed episode.
 *
 * Off the poll loop for the same reason alerts.worker is: the cycle runs every
 * 2 s across ~1,500 units, and a vehicle that just stopped speeding must not
 * hold up the next vehicle's turn while a row is inserted.
 *
 * The insert is idempotent by construction — `@@unique([vehicleId, startedAt])`
 * over the provider's own `capturedAt` — so a duplicate is a P2002 and a no-op
 * rather than a second row. That is what makes a second writer (a stray
 * POLL_ENABLED instance, a replayed frame) harmless instead of corrupting.
 */

import { prisma }          from '../prisma.js'
import { eventBus }        from '../event-bus.js'
import { logger }          from '../logger.js'
import { createLimiter }   from '../concurrency.js'
import { fleetDayStart, fleetDayKey } from '../provider-time.js'
import type { ClosedEpisode } from '../speeding-episodes.js'

const limit = createLimiter(4)

/** Postgres unique violation, surfaced by Prisma. */
const UNIQUE_VIOLATION = 'P2002'

export async function writeSpeedingIncident(ep: ClosedEpisode): Promise<void> {
  try {
    await prisma.speedingIncident.create({
      data: {
        organisationId: ep.orgId,
        vehicleId:      ep.vehicleId,
        vehicleType:    ep.vehicleType,
        driverId:       ep.driverId,
        driverName:     ep.driverName,
        startedAt:      ep.startedAt,
        endedAt:        ep.endedAt,
        durationSec:    ep.durationSec,
        peakKmh:        ep.peakKmh,
        avgKmh:         ep.avgKmh,
        limitKmh:       ep.limitKmh,
        limitSource:    ep.limitSource,
        overByKmh:      ep.overByKmh,
        frames:         ep.frames,
        distanceM:      ep.distanceM,
        startLat:       ep.startLat,
        startLng:       ep.startLng,
        peakLat:        ep.peakLat,
        peakLng:        ep.peakLng,
        endLat:         ep.endLat,
        endLng:         ep.endLng,
        // The FLEET day the episode began, so the rollup is a plain GROUP BY
        // and month filters never touch date_trunc(… AT TIME ZONE).
        day:            fleetDayKey(fleetDayStart(ep.startedAt)),
        meta: {
          closedBy:     ep.closedBy,
          gapped:       ep.gapped,
          driverSource: ep.driverId ? 'assignment' : 'unassigned',
        },
      },
    })
  } catch (err) {
    if ((err as { code?: string })?.code === UNIQUE_VIOLATION) {
      // Already recorded. Expected whenever the same frame is processed twice.
      logger.debug({ vehicleId: ep.vehicleId, startedAt: ep.startedAt }, 'speeding.worker: duplicate, ignored')
      return
    }
    throw err
  }
}

export function startSpeedingWorker(): () => void {
  const unsub = eventBus.subscribe('speeding:closed', (ep) => {
    void limit(() => writeSpeedingIncident(ep)).catch(
      err => logger.warn({ err, vehicleId: ep.vehicleId }, 'speeding.worker: write failed'),
    )
  })

  logger.info('Speeding worker started')
  return unsub
}
