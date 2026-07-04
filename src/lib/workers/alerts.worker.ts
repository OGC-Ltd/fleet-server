/**
 * Alerts worker — subscribes to 'alerts:sync' and persists the open/resolved
 * VehicleAlert bookkeeping for a frame whose active-alert set changed.
 *
 * This used to be awaited inline in the poller's per-vehicle loop. Moving it
 * here means a vehicle with a state change no longer holds up the next
 * vehicle's turn in the poll cycle's bounded concurrency — the DB writes
 * happen off to the side, bounded by their own small limiter so a burst of
 * simultaneous state changes can't open unbounded connections against the pool.
 */

import { eventBus } from '../event-bus.js'
import { logger }   from '../logger.js'
import { syncFrameAlerts } from '../alerts.js'
import { createLimiter }   from '../concurrency.js'

const limit = createLimiter(4)

export function startAlertsWorker(): () => void {
  const unsub = eventBus.subscribe('alerts:sync', (evt) => {
    void limit(() => syncFrameAlerts(evt.orgId, evt.vehicleId, evt.frame, evt.activeTypes)).catch(
      err => logger.warn({ err, deviceId: evt.deviceId }, 'alerts.worker: syncFrameAlerts failed'),
    )
  })

  logger.info('Alerts worker started')
  return unsub
}
