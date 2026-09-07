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
import type { FaultObservation, FaultResolution } from '../sensor-faults.js'

const limit = createLimiter(4)
const UNIQUE_VIOLATION = 'P2002'

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

  try {
    await prisma.sensorFaultEpisode.create({
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
        day:            fleetDayKey(fleetDayStart(obs.startedAt)),
      },
    })
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
