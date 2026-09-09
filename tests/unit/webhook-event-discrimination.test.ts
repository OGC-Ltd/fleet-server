/**
 * Which handler a delivery reaches, when the event NAME cannot say.
 *
 * The provider does not mint an event name for the sales lifecycle — a sales
 * sign-out arrives as `dispatch.created` and `movement.created`, the same two
 * names the cane flow uses. So the controller cannot dispatch on the name, and
 * the first cut of this (name first, sales last) was actively wrong: a sales
 * payload parses CLEANLY against the dispatch schema, because it carries
 * id/factoryCode/vehicleNumberPlate/driverName and `dispatchTime` is merely
 * optional. It would have been stored as a cane dispatch with the tonnage
 * dropped and a dispatch time invented from the receive clock.
 *
 * Discrimination is therefore by SHAPE, and these pin it in both directions
 * using payloads read off the live endpoints on 2026-09-09.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/modules/webhooks/raifactorysuite-events.service.js', () => ({
  handleDispatch: vi.fn().mockResolvedValue(true),
  handleMovement: vi.fn().mockResolvedValue(true),
  handleSale:     vi.fn().mockResolvedValue(true),
}))
vi.mock('../../src/modules/webhooks/raifactorysuite-alerts.service.js', () => ({
  ingestAlerts: vi.fn().mockResolvedValue({ created: 0 }),
}))
vi.mock('../../src/modules/webhooks/wialon-notifications.service.js', () => ({
  ingestWialonNotifications: vi.fn().mockResolvedValue({ created: 0 }),
}))

import { providerWebhook } from '../../src/modules/webhooks/webhooks.controller.js'
import {
  handleDispatch, handleMovement, handleSale,
} from '../../src/modules/webhooks/raifactorysuite-events.service.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /sales?factoryCode=NAITIRI — a sales run. Note: NO `dispatchTime`. */
const SALE = {
  id: '4eebde3e-cb58-403b-8f35-926a603e318e',
  factoryCode: 'NAITIRI',
  vehicleNumberPlate: 'KCP 134P',
  driverName: 'Duncan Mwangi',
  tonnage: 29.0,
  destination: 'Raiply',
  status: 'RETURNED',
  signOutTime: '2026-09-09T09:58:18.775629',
  signOutPhotoUrl: null,
  returnTime: '2026-09-09T10:30:26.796874',
  returnPhotoUrl: null,
}

/** GET /dispatches?factoryCode=NAITIRI — a cane dispatch. No tonnage, and the
 *  return field is `actualReturnTime`, not `returnTime`. */
const DISPATCH = {
  id: '40ae93a6-aa05-4954-bc22-607d45903313',
  factoryCode: 'NAITIRI',
  vehicleType: 'TRUCK',
  vehicleNumberPlate: 'KCP 134P',
  driverName: 'Duncan Mwangi',
  driverChangeReason: null,
  destinationOrPurpose: 'Raiply',
  status: 'CANCELLED',
  dispatchTime: '2026-09-09T14:08:49.043618',
  expectedReturnTime: '2026-09-09T19:00:00',
  actualReturnTime: null,
  exitChecklist: null,
  returnChecklist: null,
}

/** GET /movements?factoryCode=NAITIRI — a gate crossing. */
const MOVEMENT = {
  id: 'cc6d9e1e-b260-4db7-b61e-73bfdfcaae90',
  factoryCode: 'NAITIRI',
  vehicleNumberPlate: 'KCP 134P',
  driverName: 'Duncan Mwangi',
  direction: 'EXIT',
  destination: 'Raiply',
  timestamp: '2026-09-09T14:08:49.049381',
}

const post = async (body: unknown) => {
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any
  await providerWebhook({ body } as any, res, vi.fn() as any)
  return res
}

beforeEach(() => vi.clearAllMocks())

describe('a sales payload delivered under the cane event names', () => {
  it('reaches handleSale, not handleDispatch, under dispatch.created', async () => {
    await post({ event: 'dispatch.created', data: SALE })

    expect(handleSale).toHaveBeenCalledTimes(1)
    expect(handleDispatch).not.toHaveBeenCalled()
    // The tonnage survives — the whole point of not letting the dispatch
    // schema strip it.
    expect((handleSale as any).mock.calls[0][0].tonnage).toBe(29)
  })

  it('reaches handleSale under movement.created too', async () => {
    await post({ event: 'movement.created', data: SALE })

    expect(handleSale).toHaveBeenCalledTimes(1)
    expect(handleMovement).not.toHaveBeenCalled()
  })

  it('reaches handleSale with no event envelope at all', async () => {
    await post([SALE])

    expect(handleSale).toHaveBeenCalledTimes(1)
  })
})

describe('the cane flow is not captured by the sales branch', () => {
  it('routes a real dispatch to handleDispatch', async () => {
    await post({ event: 'dispatch.created', data: DISPATCH })

    expect(handleDispatch).toHaveBeenCalledTimes(1)
    expect(handleSale).not.toHaveBeenCalled()
  })

  it('routes a real movement to handleMovement', async () => {
    await post({ event: 'movement.created', data: MOVEMENT })

    expect(handleMovement).toHaveBeenCalledTimes(1)
    expect(handleSale).not.toHaveBeenCalled()
  })

  it('is not fooled by a dispatch that HAS returned', async () => {
    // `actualReturnTime` is the cane field. If the sales sniff ever loosened to
    // match on "some kind of return time", this is the payload that would start
    // being swallowed.
    await post({ event: 'dispatch.created', data: { ...DISPATCH, actualReturnTime: '2026-09-09T18:00:00' } })

    expect(handleDispatch).toHaveBeenCalledTimes(1)
    expect(handleSale).not.toHaveBeenCalled()
  })
})

describe('mixed batches', () => {
  it('sorts a sales run out of a batch of cane dispatches', async () => {
    // The case that matters: one delivery, one event name, both lifecycles in
    // it. Each item is sorted on its own shape rather than on the batch's name.
    await post({ event: 'dispatch.created', data: [DISPATCH, SALE, DISPATCH] })

    expect(handleSale).toHaveBeenCalledTimes(1)
    expect(handleDispatch).toHaveBeenCalledTimes(2)
    expect((handleSale as any).mock.calls[0][0].id).toBe(SALE.id)
  })

  it('counts each lifecycle separately in the response', async () => {
    const res = await post({ event: 'dispatch.created', data: [DISPATCH, SALE] })

    // sendSuccess wraps the payload; the counters are what the provider's
    // sender and the summary log line both read.
    const body = (res.json as any).mock.calls[0][0]
    expect(body).toMatchObject({ data: expect.objectContaining({ dispatches: 1, sales: 1 }) })
  })
})
