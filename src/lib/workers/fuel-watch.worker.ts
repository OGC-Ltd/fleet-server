/**
 * Puts a live fuel drop on the operations feed.
 *
 * `lib/fuel-drop-watch` decides; this publishes. Same split as
 * `speeding.worker` and for the same reason: the detector runs inside the poll
 * loop, where a write must never hold up the next vehicle's turn.
 *
 * ## Why the wording is careful
 *
 * This item is the fast half of a two-stage answer, and the slow half is the
 * one that decides. `fuel-adjudication` still runs, still weighs the probe's
 * 30-day profile, still checks whether a filling explains the fall and whether
 * the level came back — and only it may use the word theft
 * (`mayUseTheftWording`). So this says what was SEEN and states plainly that it
 * is unconfirmed.
 *
 * It is a `warning`, never `critical`. A critical item that later turns out to
 * be a refuelling is worse than no item at all: the operator learns to discount
 * the channel, and then the confirmed one does not land either.
 *
 * ## Two items per event, deliberately
 *
 * The confirmed item carries `fuel-drain-<vehicle>-<theftId>` and cannot be
 * known here — the ledger row does not exist yet. Rather than invent a shared
 * key and risk one overwriting the other, this uses its own id and the operator
 * sees the sequence: a provisional sighting, then the verdict. That is what
 * actually happened, and collapsing it would hide the very latency this exists
 * to close.
 *
 * The id is keyed on the SETTLED time rather than on now, so the same fall
 * re-offered by a replay updates one row instead of duplicating the feed.
 */

import { eventBus } from '../event-bus.js'
import { logger } from '../logger.js'
import { publishNotification } from '../notifications/notification.store.js'
import type { LiveFuelDrop } from '../fuel-drop-watch.js'

const L = (ml: number): string => `${(ml / 1000).toFixed(1)} L`

/** Minutes, for a sentence rather than a field. */
const mins = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m < 1 ? 'under a minute' : m === 1 ? '1 minute' : `${m} minutes`
}

export function startFuelWatchWorker(): () => void {
  const onDrop = (d: LiveFuelDrop) => {
    const plate = d.plate ?? 'a vehicle'
    try {
      publishNotification({
        orgId:     d.orgId,
        id:        `fuel-watch-${d.vehicleId}-${d.settledAt.getTime()}`,
        source:    'live',
        alertType: 'fuelInconsistency',
        // Never critical — see the note above.
        severity:  'warning',
        text:
          `FUEL DROP SEEN: ${plate} fell ${L(d.droppedMl)} ` +
          `(${L(d.baselineMl)} to ${L(d.troughMl)}) while parked with the engine off ` +
          `for ${mins(d.stillForMs)}. Unconfirmed — being checked against the tank's own history.`,
        at:        d.settledAt,
        plate:     d.plate,
        vehicleId: d.vehicleId,
      })
    } catch (err) {
      // A feed item is not worth taking the poll loop down for.
      logger.warn({ err, vehicleId: d.vehicleId }, 'Live fuel drop: publish failed')
    }
  }

  const unsub = eventBus.subscribe('fuel:dropped', onDrop)
  logger.info('Live fuel-drop worker started')
  return unsub
}
