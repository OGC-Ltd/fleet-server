import { z } from 'zod'

/**
 * A single Controltech EA alert. Unknown extra fields are preserved (the raw
 * body is stored verbatim), so the provider can add fields without breaking
 * delivery here.
 */
export const controltechAlertSchema = z.object({
  id:           z.string().min(1),
  factoryCode:  z.string().min(1),
  type:         z.string().min(1),
  message:      z.string().min(1),
  relatedId:    z.string().nullish(),
  acknowledged: z.boolean().nullish(),
  createdAt:    z.string().min(1),
})

/**
 * Accepts either a single alert or a batch, and tolerates a wrapper envelope
 * ({ alerts: [...] } / { data: [...] } / { events: [...] }) since the
 * provider's callback shape isn't contractually fixed yet.
 */
export const controltechAlertPayloadSchema = z.union([
  controltechAlertSchema,
  z.array(controltechAlertSchema),
  z.object({ alerts: z.array(controltechAlertSchema) }),
  z.object({ data:   z.array(controltechAlertSchema) }),
  z.object({ events: z.array(controltechAlertSchema) }),
])

export type ControltechAlertPayload = z.infer<typeof controltechAlertPayloadSchema>

/** Flatten any accepted shape into a plain array. */
export function toAlertArray(payload: ControltechAlertPayload) {
  if (Array.isArray(payload)) return payload
  if ('alerts' in payload) return payload.alerts
  if ('data'   in payload) return payload.data
  if ('events' in payload) return payload.events
  return [payload]
}
