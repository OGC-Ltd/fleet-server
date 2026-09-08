/**
 * Sensor fault worker — turns 'sensorFault:open' / 'sensorFault:close' into
 * rows in `sensor_fault_episodes`.
 *
 * ## Open is an UPSERT against the partial unique index
 *
 * `sensor_fault_episodes_open_uniq` allows at most one row per
 * (vehicle, kind) with `recovered_at IS NULL`. That is what makes "open or
 * extend" a single statement instead of a read-then-write race between the poll
 * loop and the 15-minute sweep, which observe the same fleet at the same time
 * and would otherwise both decide a fault is new.
 *
 * Prisma cannot upsert on a partial index, so this is find-then-write — but the
 * index still holds the line: a losing race gets P2002 and is treated as "the
 * other detector already opened it", which is exactly right.
 *
 * ## Close is idempotent by construction
 *
 * `updateMany` over the open row: if nothing is open, it updates nothing, and a
 * duplicate close is a no-op rather than an error. The poller closes
 * `signal_lost` on every single frame of a healthy unit, so that path has to be
 * free when there is nothing to do.
 */

import { prisma } from '../prisma.js'
import { eventBus } from '../event-bus.js'
import { logger } from '../logger.js'
import { createLimiter } from '../concurrency.js'
import { fleetDayStart, fleetDayKey } from '../provider-time.js'
import { MOVING_THRESHOLD_KMH } from '../movement-state.js'
import { reverseGeocode } from '../geocode.js'
import type { FaultObservation, FaultResolution } from '../sensor-faults.js'

const limit = createLimiter(4)
const UNIQUE_VIOLATION = 'P2002'

/**
 * Where the unit was when this sensor was last working.
 *
 * The last fix at or BEFORE the episode's start, not the unit's latest fix.
 * The difference matters on a channel death: a tracker whose odometer died in
 * March keeps reporting position, so its newest fix says where the machine is
 * today and answers a question nobody asked. The fix at `startedAt` says where
 * it was when the channel last worked, which is the one that sends someone to
 * the right place.
 *
 * `lat: { not: null }` because a fix without coordinates is a row, not a
 * position — frozen_gps episodes are opened by exactly those.
 */
async function lastKnownFix(vehicleId: string, at: Date) {
  return prisma.vehicleTelemetry.findFirst({
    where:   { vehicleId, capturedAt: { lte: at }, lat: { not: null } },
    orderBy: { capturedAt: 'desc' },
    select:  { lat: true, lng: true, speedKmh: true, capturedAt: true },
  })
}

/**
 * Resolve the place name and write it in, once the row exists.
 *
 * Deliberately not awaited by the caller. Nominatim's policy caps the geocoder
 * at roughly one request every 1.1s and the first sweep of a neglected fleet
 * opens a couple of hundred episodes at once — awaiting them in order would
 * put four minutes of rate limiter inside fault capture. The label is the
 * least urgent field on the row and the only one that can arrive late.
 */
function fillPlaceLater(id: string, lat: number, lng: number): void {
  void reverseGeocode(lat, lng)
    .then(place => place
      ? prisma.sensorFaultEpisode.update({ where: { id }, data: { lastPlace: place } })
      : undefined)
    .catch(err => logger.debug({ err, id }, 'sensor-faults.worker: place label unresolved'))
}

export async function openFaultEpisode(obs: FaultObservation): Promise<void> {
  const existing = await prisma.sensorFaultEpisode.findFirst({
    where:  { vehicleId: obs.vehicleId, kind: obs.kind, recoveredAt: null },
    select: { id: true },
  })

  if (existing) {
    // Already open — extend the watchdog clock and keep the newest detail. The
    // START is never touched: it is when the fault began, and a later
    // observation of the same fault does not move that.
    await prisma.sensorFaultEpisode.update({
      where: { id: existing.id },
      data:  {
        lastSeenAt:   obs.lastSeenAt,
        detail:       obs.detail,
        evidence:     obs.evidence as never,
        observations: { increment: 1 },
      },
    })
    return
  }

  // One lookup per NEW episode — never on the extend path above, where the
  // position was already settled when the fault began.
  const fix = await lastKnownFix(obs.vehicleId, obs.startedAt)
  const speed = fix?.speedKmh ?? null

  try {
    const row = await prisma.sensorFaultEpisode.create({
      data: {
        organisationId: obs.orgId,
        vehicleId:      obs.vehicleId,
        kind:           obs.kind,
        severity:       obs.severity,
        source:         obs.source,
        startedAt:      obs.startedAt,
        lastSeenAt:     obs.lastSeenAt,
        detail:         obs.detail,
        evidence:       obs.evidence as never,
        lastFixAt:      fix?.capturedAt ?? null,
        lastLat:        fix?.lat ?? null,
        lastLng:        fix?.lng ?? null,
        lastSpeedKmh:   speed,
        // Null, not false, when there is no fix to judge: "we do not know what
        // it was doing" and "it was parked" are different answers.
        lastMoving:     speed == null ? null : speed >= MOVING_THRESHOLD_KMH,
        day:            fleetDayKey(fleetDayStart(obs.startedAt)),
      },
      select: { id: true },
    })
    if (fix?.lat != null && fix.lng != null) fillPlaceLater(row.id, fix.lat, fix.lng)
  } catch (err) {
    if ((err as { code?: string })?.code === UNIQUE_VIOLATION) {
      // The other detector opened it between the find and the create. Its row
      // is as good as this one would have been.
      logger.debug({ vehicleId: obs.vehicleId, kind: obs.kind }, 'sensor-faults.worker: already open')
      return
    }
    throw err
  }
}

export async function closeFaultEpisode(res: FaultResolution): Promise<void> {
  const open = await prisma.sensorFaultEpisode.findFirst({
    where:  { vehicleId: res.vehicleId, kind: res.kind, recoveredAt: null },
    select: { id: true, startedAt: true },
  })
  if (!open) return

  // Guard against a recovery that predates the start. It should not happen, but
  // a negative duration in a report is worse than a zero: it looks like a bug in
  // the reader rather than in the clock that produced it.
  const durationSec = Math.max(
    0,
    Math.round((res.recoveredAt.getTime() - open.startedAt.getTime()) / 1000),
  )

  await prisma.sensorFaultEpisode.updateMany({
    where: { id: open.id, recoveredAt: null },
    data:  { recoveredAt: res.recoveredAt, durationSec },
  })
}

export function startSensorFaultsWorker(): () => void {
  const unsubOpen = eventBus.subscribe('sensorFault:open', (obs) => {
    void limit(() => openFaultEpisode(obs)).catch(
      err => logger.warn({ err, vehicleId: obs.vehicleId, kind: obs.kind }, 'sensor-faults.worker: open failed'),
    )
  })
  const unsubClose = eventBus.subscribe('sensorFault:close', (res) => {
    void limit(() => closeFaultEpisode(res)).catch(
      err => logger.warn({ err, vehicleId: res.vehicleId, kind: res.kind }, 'sensor-faults.worker: close failed'),
    )
  })

  logger.info('Sensor faults worker started')
  return () => { unsubOpen(); unsubClose() }
}
