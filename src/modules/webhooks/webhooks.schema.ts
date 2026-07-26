import { z } from 'zod'

/**
 * Controltech EA delivers several event types to the same callback:
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

/** The alert body we can actually map (see controltech-alerts.service). */
export const controltechAlertSchema = z.object({
  id:           z.string().min(1),
  factoryCode:  z.string().min(1),
  type:         z.string().min(1),
  message:      z.string().min(1),
  relatedId:    z.string().nullish(),
  acknowledged: z.boolean().nullish(),
  createdAt:    z.string().min(1),
})

export type ControltechAlertInput = z.infer<typeof controltechAlertSchema>

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
