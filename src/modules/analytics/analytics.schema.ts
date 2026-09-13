import { z } from 'zod'
import { env } from '../../config/env.js'

export const analyticsRangeSchema = z.object({
  from: z.coerce.date(),
  to:   z.coerce.date(),
})

export const speedingQuerySchema = analyticsRangeSchema.extend({
  // Defaults to the configured fleet limit, so an unfiltered Speeding screen
  // shows exactly what the live feed alerts on. A caller may still pass its own
  // threshold to explore.
  thresholdKmh: z.coerce.number().int().min(1).default(env.OVERSPEED_LIMIT_KMH),
})

// Deliveries dashboard: a trailing window of `days` (default 30), optionally
// ending at `to` instead of now.
export const deliveriesQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  to:   z.coerce.date().optional(),
  // Vehicle-type filter, comma separated plate-prefix categories ("EX,CTR").
  // A STRING rather than an array: it is resolved to vehicle ids by
  // analytics/vehicle-filter, which owns the one definition of what a category
  // is, and validating the members here would be a second list to keep in step
  // with a vocabulary that differs per fleet.
  //
  // Absent means the whole fleet, which is NOT the same as an empty selection —
  // see parseCategories.
  categories: z.string().optional(),
  // Unit filter, comma separated vehicle ids. A string for the same reason,
  // and unvalidated here for a stronger one: an id is only meaningful against
  // THIS organisation's fleet, which is a database question. vehicleIdsFor
  // answers it by intersection, so an id from another organisation narrows the
  // answer to nothing rather than reaching its data.
  vehicles: z.string().optional(),
})

// Fuel cost: the same trailing window as deliveries, plus the price to cost the
// litres at. `pricePerLitre` is optional because the server has a configured
// default (env.FUEL_PRICE_PER_LITRE) — it is a query param only so an operator
// can re-price a period without a redeploy (e.g. "what would last month have
// cost at the new EPRA rate?"). The quantities never depend on it.
export const fuelCostQuerySchema = deliveriesQuerySchema.extend({
  pricePerLitre: z.coerce.number().positive().optional(),
})

export type AnalyticsRange  = z.infer<typeof analyticsRangeSchema>
export type SpeedingQuery   = z.infer<typeof speedingQuerySchema>
export type DeliveriesQuery = z.infer<typeof deliveriesQuerySchema>
export type FuelCostQuery   = z.infer<typeof fuelCostQuerySchema>
