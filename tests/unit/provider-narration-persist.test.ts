/**
 * Routine narration must be STORED even though it is not pushed.
 *
 * notification.worker passed `persist: a.notify` for a long time. The two
 * flags read alike and diverged in meaning: `notify:false` was introduced for
 * a boot replay of rows the store already held (correct not to re-write), and
 * was then inherited by dispatch and gate-movement narration, which means
 * "don't wake anyone's phone" and must absolutely still be written.
 *
 * The cost was invisible until someone went looking for history: every
 * dispatch RaiFactorySuite ever reported reached whoever had a tab open at
 * that instant and nothing else. 1,813 dispatches on record for SUKARI on
 * 2026-08-03, and not one surviving feed item.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/notifications/notification.store.js', () => ({
  publishNotification: vi.fn(),
}))
vi.mock('../../src/lib/sse.js', () => ({ emitDashboardAlert: vi.fn() }))
vi.mock('../../src/modules/notifications/notifications.service.js', () => ({
  pushService: { broadcastToOrg: vi.fn().mockResolvedValue(undefined) },
}))

import { eventBus } from '../../src/lib/event-bus.js'
import { publishNotification } from '../../src/lib/notifications/notification.store.js'
import { pushService } from '../../src/modules/notifications/notifications.service.js'
import { startNotificationWorker } from '../../src/lib/workers/notification.worker.js'

const dispatch = (over: Record<string, unknown> = {}) => ({
  orgId:     'org_1',
  id:        'dp-abc123',
  source:    'controltech',
  alertType: 'DISPATCH',
  severity:  'info' as const,
  text:      'KDL 715E · CALVIN LESOIYAN LENASO dispatched to NYAONDO.',
  at:        new Date('2026-08-02T20:41:16Z'),
  plate:     'KDL 715E',
  vehicleId: 'veh_1',
  notify:    false,          // routine narration — no phone should buzz
  ...over,
})

let stop: () => void
beforeEach(() => {
  vi.mocked(publishNotification).mockClear()
  vi.mocked(pushService.broadcastToOrg).mockClear()
  stop?.()
  stop = startNotificationWorker()
})

describe('provider narration', () => {
  it('is persisted even when it is not pushed', () => {
    eventBus.publish('provider:alert', dispatch())

    expect(publishNotification).toHaveBeenCalledTimes(1)
    expect(vi.mocked(publishNotification).mock.calls[0]![0]).toMatchObject({
      id:        'dp-abc123',
      alertType: 'DISPATCH',
      persist:   true,
    })
    // …and still no push. That half of the contract has to survive the fix.
    expect(pushService.broadcastToOrg).not.toHaveBeenCalled()
  })

  it('honours an explicit persist:false, which is what a replay uses', () => {
    eventBus.publish('provider:alert', dispatch({ persist: false }))
    expect(vi.mocked(publishNotification).mock.calls[0]![0]).toMatchObject({ persist: false })
  })

  it('still pushes a critical', () => {
    eventBus.publish('provider:alert', dispatch({
      severity: 'critical', notify: true, alertType: 'DRIVER_BLOCKED',
    }))
    expect(pushService.broadcastToOrg).toHaveBeenCalledTimes(1)
  })
})
