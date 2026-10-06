import { z } from 'zod'

/**
 * RaiFactorySuite delivers several event types to the same callback:
 *
 *   alert.created     — an operational alert (feeds the Live Feed)
 *   dispatch.created  — a unit went out with a driver
 *   movement.created  — a movement/position record
 *
 * That is the whole list of NAMES, and it is shorter than the list of things
 * that arrive: the sales lifecycle has no name of its own and is delivered
 * under the latter two. The name therefore identifies the CALLBACK, not the
 * payload — see `looksLikeSale`, which is what actually sorts them.
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
  /** `VEHICLE` on every /dispatches row since FactorySuite v1.4.32. */
  type:                 z.string().nullish(),
})

/**
 * A SALES dispatch — finished sugar leaving for a customer.
 *
 * A different lifecycle from `/dispatches`, not a variant of it. The sales
 * office raises the run (tonnage + destination + unit + driver); the gate guard
 * then signs the unit OUT, and signs it back IN when it returns. So one row
 * mutates through three states and the same `id` is delivered more than once
 * with different fields populated — which is why the handler narrates on
 * TRANSITIONS rather than on first sight the way handleDispatch does.
 *
 * `tonnage` is the only weight anywhere in this integration. Everything the bag
 * count says comes from it.
 *
 * Every field past the identity is nullish on purpose: a run that has been
 * created but not yet signed out has no `signOutTime`, and rejecting it would
 * cost us the event (their sender retries a few times, then drops).
 */
export const raiFactorySuiteSaleSchema = z.object({
  id:                 z.string().min(1),
  factoryCode:        z.string().min(1),
  vehicleNumberPlate: z.string().min(1),
  driverName:         z.string().nullish(),
  /** Tonnes. Coerced because the provider has sent it as both 29 and "29.0". */
  tonnage:            z.coerce.number().nullish(),
  destination:        z.string().nullish(),
  /** Observed: RETURNED. The vocabulary is not published and the `status`
   *  query parameter is IGNORED by the endpoint, so this is recorded, never
   *  relied on — the timestamps below are what say where the run has got to. */
  status:             z.string().nullish(),
  signOutTime:        z.string().nullish(),
  signOutPhotoUrl:    z.string().nullish(),
  returnTime:         z.string().nullish(),
  returnPhotoUrl:     z.string().nullish(),
  /** `SALES` since FactorySuite v1.4.32 — see `providerDispatchType`. */
  type:               z.string().nullish(),
  /** The seal the gate puts on the load, typed in by the guard at sign-out
   *  (v1.4.32). Listed here because this schema STRIPS unknown keys: left out,
   *  it never reached the handler however often the provider sent it. */
  sealSerialNumber:   z.string().nullish(),
  /** Weighbridge legs of the load, kg. Present on the wire, null on every row
   *  read 2026-10-07; carried so they are not stripped the day they fill in. */
  loadedWeightKg:     z.coerce.number().nullish(),
  tareWeightKg:       z.coerce.number().nullish(),
})

export type RaiFactorySuiteSaleInput = z.infer<typeof raiFactorySuiteSaleSchema>

/**
 * Which kind of dispatch the provider SAYS this is, or null when it does not.
 *
 * FactorySuite v1.4.32 put a `type` on every dispatch notification so partner
 * integrations stop guessing: `SALES` (finished sugar out of the gate, with
 * its seal serial), `MATERIAL` (stores and spares leaving the site) and
 * `VEHICLE` (a unit sent out with a driver — what this codebase calls a cane
 * dispatch). Read off the live API 2026-10-07: every /dispatches row carries
 * `VEHICLE`, every /sales row `SALES`; no MATERIAL has been delivered yet.
 *
 * Alerts carry a `type` too (the alert's own category), so only these three
 * values on a payload with a plate count. Anything else returns null and the
 * shape sniffing below decides, as it did before v1.4.32 — older deliveries
 * and replays keep routing exactly as they always have.
 */
export type ProviderDispatchType = 'SALES' | 'MATERIAL' | 'VEHICLE'
const DISPATCH_TYPES: ReadonlySet<string> = new Set(['SALES', 'MATERIAL', 'VEHICLE'])

export function providerDispatchType(item: unknown): ProviderDispatchType | null {
  if (!item || typeof item !== 'object') return null
  const o = item as Record<string, unknown>
  if (!('vehicleNumberPlate' in o) || typeof o['type'] !== 'string') return null
  const t = o['type'].trim().toUpperCase()
  return DISPATCH_TYPES.has(t) ? (t as ProviderDispatchType) : null
}

/**
 * Does this payload look like a sale, whatever the sender called the event?
 *
 * There is no sales event name to check. Confirmed 2026-09-09: the provider
 * delivers a sales sign-out under `dispatch.created` and `movement.created` —
 * the same names the cane flow uses — so the envelope cannot discriminate and
 * the controller consults this BEFORE the name, not after.
 *
 * Getting that order wrong is not a near-miss. A sales payload satisfies the
 * dispatch schema outright (id, factoryCode, vehicleNumberPlate and driverName
 * are all present; `dispatchTime` is optional), so a name-first controller
 * files it as a cane dispatch, drops the tonnage, and stamps it with a
 * dispatch time taken from the receive clock.
 *
 * The three fields below are decisive in both directions, which is what makes
 * running this first safe: none of them appears on a cane dispatch or a
 * movement. Note in particular that a dispatch's return field is
 * `actualReturnTime` — loosening this to match "some kind of return time"
 * would start swallowing closed cane dispatches.
 */
export function looksLikeSale(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const o = item as Record<string, unknown>
  return 'vehicleNumberPlate' in o && ('tonnage' in o || 'signOutTime' in o || 'returnTime' in o)
}

/**
 * A weighbridge ticket, delivered as `weighment.created` / `weighment.updated`.
 *
 * Loose on purpose, and looser than the REST types in the provider client.
 * Everything except the four fields that IDENTIFY a ticket is `nullish`,
 * because an `updated` event is the scale correcting one number — a re-weigh,
 * a fixed plate — and rejecting a payload that omits the rest would drop
 * exactly the deliveries that carry news. A 4xx here is not a retry: their
 * sender tries a few times and then discards the event, and this feed cannot
 * be backfilled (the provider keeps about two days), so a dropped weighment is
 * gone from our history for good.
 *
 * `category` is what routes it, and it is the provider's own field rather than
 * something inferred from the shape — unlike sales, which had to be sniffed
 * because the provider reuses `dispatch.created` for them.
 */
export const raiFactorySuiteWeighmentSchema = z.object({
  category:    z.enum(['CANE_DELIVERY', 'CANE_TRANSFER']),
  tokenNumber: z.number(),
  tokenDate:   z.string().min(1),
  tokenTime:   z.number().nullish(),
  vehicleNo:   z.string().min(1),
  driverName:  z.string().nullish(),
}).passthrough()

/**
 * Does this payload look like a weighbridge ticket, whatever it was called?
 *
 * `category` plus `tokenNumber` appear on nothing else the provider sends, so
 * this is decisive in both directions — a dispatch, a movement and a sale all
 * fail it. Consulted only as a FALLBACK, after the `weighment.*` name, so a
 * renamed event still lands rather than falling through to the unmapped log.
 */
export function looksLikeWeighment(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const o = item as Record<string, unknown>
  return 'tokenNumber' in o && (o['category'] === 'CANE_DELIVERY' || o['category'] === 'CANE_TRANSFER')
}

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

  // ── fuel ────────────────────────────────────────────────────────────────
  // Wialon's fuel-filling and fuel-theft notifications know the VOLUME, but a
  // notification only carries what its template substitutes, and the template
  // in docs/LIVE_INTEGRATION.md predates fuel rules — so today a "Fuel theft"
  // would arrive as an event with no litres in it.
  //
  // These are named by MEANING rather than after a Wialon tag on purpose. The
  // exact tag spelling differs per notification type and is not something to
  // guess at in a document an operator will copy: whoever authors the rule maps
  // the volume tag their trigger offers into `volumeL`, and the level tag into
  // `fuelLevelL`. Both optional, like every other field here — a template that
  // omits them still produces a usable alert, just without the amount.
  volumeL:      z.coerce.number().nullish(),  // litres filled or lost
  fuelLevelL:   z.coerce.number().nullish(),  // tank level at trigger time
  sensorName:   z.string().nullish(),         // %SENSOR_NAME%, when sent
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
