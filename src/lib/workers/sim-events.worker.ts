/**
 * Sim-events worker — subscribes to 'simEvents:persist' and writes the
 * durable outcomes of a completed trip / fuel theft / refuel (see
 * simulation.persistence.ts) off the poll cycle's critical path.
 *
 * A completed trip alone is a Trip + CargoManifest write (+ a driver-rating
 * update) — exactly the kind of multi-round-trip work that shouldn't block
 * the next vehicle's turn in the poller's bounded concurrency. Bounded by its
 * own small limiter, separate from alerts.worker's, so the two can't jointly
 * exceed a sane share of the pg pool.
 */

import { eventBus } from '../event-bus.js'
import { logger }   from '../logger.js'
import { persistSimEvents } from '../simulation.persistence.js'
import { createLimiter }    from '../concurrency.js'

const limit = createLimiter(3)

export function startSimEventsWorker(): () => void {
  const unsub = eventBus.subscribe('simEvents:persist', (evt) => {
    void limit(() => persistSimEvents(evt.orgId, evt.vehicleId, evt.events, evt.vehicleMeta)).catch(
      err => logger.warn({ err, deviceId: evt.deviceId }, 'sim-events.worker: persistSimEvents failed'),
    )
  })

  logger.info('Sim-events worker started')
  return unsub
}
