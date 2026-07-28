import { z } from 'zod'

/**
 * RaiFactorySuite delivers several event types to the same callback:
 *
 *   alert.created     — an operational alert (feeds the Live Feed)
 *   dispatch.created  — a unit went out with a driver
 *   movement.created  — a movement/position record
 *
 * Their envelope shape is not published, and rejecting a delivery we don't
 * fully understand costs us the event: their sender retries a few times and
 * then drops it. So the receiver validates only what it must — that the body
 * is a JSON object or array — and the controller sorts out the rest,
 * persisting what it recognises and logging the shape of what it doesn't.
 *
 * Anything narrower belongs downstream, once the real payloads are known.
 */
export const webhookEnvelopeSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
])

/** The alert body we can actually map (see raifactorysuite-alerts.service).
 *  `createdAt` is NULLABLE: the webhook sends null on live alerts (only the
 *  REST backfill populates it), so requiring it silently dropped every pushed
 *  alert. The receive time stands in when it's absent. */
export const raiFactorySuiteAlertSchema = z.object({
  id:           z.string().min(1),
  factoryCode:  z.string().min(1),
  type:         z.string().min(1),
  message:      z.string().min(1),
  relatedId:    z.string().nullish(),
  acknowledged: z.boolean().nullish(),
  createdAt:    z.string().nullish(),
})

export type RaiFactorySuiteAlertInput = z.infer<typeof raiFactorySuiteAlertSchema>

/** A dispatch record — a unit leaving with a driver. Same shape as the REST
 *  /dispatches resource, so the two paths normalise identically. */
export const raiFactorySuiteDispatchSchema = z.object({
  id:                   z.string().min(1),
  factoryCode:          z.string().min(1),
  vehicleNumberPlate:   z.string().min(1),
  driverName:           z.string().min(1),
  vehicleType:          z.string().nullish(),
  destinationOrPurpose: z.string().nullish(),
  status:               z.string().nullish(),
  dispatchTime:         z.string().nullish(),
  expectedReturnTime:   z.string().nullish(),
  actualReturnTime:     z.string().nullish(),
})

/** A gate movement — a unit crossing the factory gate. Carries NO coordinates:
 *  this is a checkpoint crossing, not GPS. */
export const raiFactorySuiteMovementSchema = z.object({
  id:                 z.string().min(1),
  factoryCode:        z.string().min(1),
  vehicleNumberPlate: z.string().min(1),
  driverName:         z.string().nullish(),
  direction:          z.string().nullish(),   // EXIT | ENTRY
  destination:        z.string().nullish(),
  timestamp:          z.string().nullish(),
})

/**
 * A Wialon notification delivered by its "Send a request" action.
 *
 * Wialon does not publish a JSON contract — the operator authors the body in
 * the notification's own template, substituting `%TAGS%` at trigger time. The
 * shape below is the template documented in docs/LIVE_INTEGRATION.md; every
 * field is optional because a template can legitimately omit any of them, and
 * rejecting a delivery would lose the event (Wialon does not retry).
 */
export const wialonNotificationSchema = z.object({
  notification: z.string().min(1),          // %NOTIFICATION% — the rule's name
  unit:         z.string().nullish(),       // %UNIT%
  unitId:       z.union([z.string(), z.number()]).nullish(),
  time:         z.string().nullish(),       // %CURR_TIME% / %MSG_TIME%
  lat:          z.coerce.number().nullish(), // %LAT%
  lng:          z.coerce.number().nullish(), // %LON%
  speed:        z.coerce.number().nullish(), // %SPEED%
  zone:         z.string().nullish(),        // %ZONE%
  driver:       z.string().nullish(),        // %DRIVER%
  location:     z.string().nullish(),        // %LOCATION%
  text:         z.string().nullish(),        // free-form message
})

export type WialonNotificationInput = z.infer<typeof wialonNotificationSchema>

/** Event name → the payload we care about, wherever the sender put it. */
export function unwrapEvent(body: unknown): { event: string | null; items: unknown[] } {
  if (Array.isArray(body)) return { event: null, items: body }
  if (!body || typeof body !== 'object') return { event: null, items: [] }

  const o = body as Record<string, unknown>
  const event =
    (typeof o['event'] === 'string' && o['event']) ||
    (typeof o['eventType'] === 'string' && o['eventType']) ||
    (typeof o['type'] === 'string' && o['type']) ||
    (typeof o['topic'] === 'string' && o['topic']) ||
    null

  // The interesting payload is usually under one of these keys; if none is
  // present the object IS the payload.
  for (const key of ['data', 'payload', 'alert', 'alerts', 'record', 'body', 'events']) {
    const v = o[key]
    if (v == null) continue
    return { event, items: Array.isArray(v) ? v : [v] }
  }
  return { event, items: [o] }
}
