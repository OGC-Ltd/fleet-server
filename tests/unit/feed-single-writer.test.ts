/**
 * One incident, one feed line.
 *
 * Overspeeding had TWO writers. lib/feed-events publishes the sentence naming
 * the driver, the destination and the limit; notification.worker published a
 * second row for the same rising edge with a different id — `feed-<ts>-<veh>-0`
 * against `alert-overspeeding-<veh>-<ts>` — so the dashboard's dedupe, which
 * keys on id, saw two unrelated items and rendered both.
 *
 * Measured on the live database, 2026-09-03: of 379 overspeeding moments in 48
 * hours, 206 carried exactly two rows. The two writers also had different
 * cooldowns, 10 minutes against an hour, so the counts never matched either.
 *
 * These pin the resolution: notification.worker writes no feed row for
 * overspeeding, while everything ELSE it does for that alert is untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(),
}))
vi.mock('../../src/lib/sse.js', () => ({ emitDashboardAlert: vi.fn() }))
vi.mock('../../src/modules/notifications/notifications.service.js', () => ({
  pushService: { broadcastToOrg: vi.fn().mockResolvedValue(undefined) },
}))

import { eventBus } from '../../src/lib/event-bus.js'
import { publishNotification } from '../../src/lib/notifications/notification.store.js'
import { emitDashboardAlert } from '../../src/lib/sse.js'
import { pushService } from '../../src/modules/notifications/notifications.service.js'
import { startNotificationWorker } from '../../src/lib/workers/notification.worker.js'

const alert = (type: string, over: Record<string, unknown> = {}) => ({
  type,
  orgId:       'org_1',
  deviceId:    'dev_1',
  vehicleId:   `veh_${type}`,          // distinct per type: the worker dedupes pushes per vehicle+type
  vehicleName: 'Unit 01',
  plate:       'KCS 072B',
  capturedAt:  new Date('2026-09-02T12:32:04Z'),
  lat: -0.82, lng: 34.38,
  speedKmh:    84,
  fuelLevelMl: 40_000,
  meta:        { driverName: null, vehicleType: 'TRUCK' },
  ...over,
})

let stop: () => void
beforeEach(() => { vi.clearAllMocks(); stop = startNotificationWorker() })
afterEach(() => { stop() })

describe('the feed gets one line per incident', () => {
  it('writes NO feed row for overspeeding — feed-events owns that sentence', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus.publish('alert:triggered', alert('overspeeding') as any)
    expect(publishNotification).not.toHaveBeenCalled()
  })

  it.each(['lowFuel', 'engineIdling'])('writes no feed row for %s either', (type) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus.publish('alert:triggered', alert(type) as any)
    expect(publishNotification).not.toHaveBeenCalled()
  })

  /**
   * The suppression list must stay a list, not creep into "derived alerts are
   * never narrated". A type nobody suppressed still reaches the feed.
   */
  it('still writes a feed row for a type nobody suppressed', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus.publish('alert:triggered', alert('fuelInconsistency') as any)
    expect(publishNotification).toHaveBeenCalledTimes(1)
  })
})

describe('suppressing the feed row suppresses nothing else', () => {
  /**
   * emitDashboardAlert runs BEFORE the suppression check, deliberately: a
   * suppressed alert is still an alert, and anything subscribed to that channel
   * should keep seeing it. Only the feed line is withheld.
   */
  it('still broadcasts overspeeding on the alert channel', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus.publish('alert:triggered', alert('overspeeding') as any)
    expect(emitDashboardAlert).toHaveBeenCalledTimes(1)

    const [orgId, payload] = vi.mocked(emitDashboardAlert).mock.calls[0]!
    expect(orgId).toBe('org_1')
    expect(payload).toMatchObject({ alertType: 'overspeeding', speedKmh: 84, plate: 'KCS 072B' })
  })

  it('broadcasts every suppressed type on the alert channel', () => {
    for (const type of ['lowFuel', 'engineIdling', 'overspeeding']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventBus.publish('alert:triggered', alert(type) as any)
    }
    expect(emitDashboardAlert).toHaveBeenCalledTimes(3)
  })

  /**
   * Overspeeding is a WARNING and push is critical-only, so no phone was ever
   * woken for it. Stated as a test so the suppression is not later blamed for
   * a push that never existed.
   */
  it('sends no push for overspeeding, as before', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus.publish('alert:triggered', alert('overspeeding') as any)
    expect(pushService.broadcastToOrg).not.toHaveBeenCalled()
  })

  it('still pushes a critical alert', () => {
    // A vehicle of its own. The worker's push dedupe is MODULE state keyed on
    // org:type:vehicle with a ten-minute window, so reusing the vehicle from an
    // earlier test in this file would silently consume the push and make this
    // look like the suppression had broken it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus.publish('alert:triggered', alert('fuelInconsistency', { vehicleId: 'veh_push_1' }) as any)
    expect(pushService.broadcastToOrg).toHaveBeenCalledTimes(1)
  })

  /** The dedupe the test above had to work around, stated outright. */
  it('pushes once per vehicle and type inside the dedupe window', () => {
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventBus.publish('alert:triggered', alert('fuelInconsistency', { vehicleId: 'veh_push_2' }) as any)
    }
    expect(pushService.broadcastToOrg).toHaveBeenCalledTimes(1)
  })
})
