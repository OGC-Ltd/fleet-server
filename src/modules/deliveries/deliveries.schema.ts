import { z } from 'zod'

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const pin = z.object({
  name: z.string().max(200).default(''),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().positive().max(50_000),
})

/** One vehicle of the day's list, as new-ui's lib/deliveryPlan keeps it. */
const vehicle = z.object({
  key: z.string().min(1).max(200),
  plate: z.string().max(60),
  vehicleIds: z.array(z.string().max(60)).max(20).default([]),
  customers: z.array(z.string().max(300)).max(500).default([]),
  pins: z.array(pin).max(500).optional(),
  group: z.string().max(120).optional(),
  /**
   * Which of the tab's two reports the vehicle was added on: 'vs' Van Sales,
   * 'fg' (or none, as every list saved before the split) Finished Goods.
   * Both live in the one day list; zod would drop the tag if it were not named.
   */
  list: z.enum(['vs', 'fg']).optional(),
})

export const daySaveSchema = z.object({
  vehicles: z.array(vehicle).max(500),
})

/** The longest range one read returns (a month); the report itself runs 7 days at most. */
export const MAX_RANGE_DAYS = 31

/**
 * GET /days: `before` (the latest earlier day with a list), or `from` and `to`
 * (every day of that range, both ends kept: 2026-11-11 to 2026-11-12 is two days).
 */
export const daysQuerySchema = z.object({
  before: z.string().regex(DAY_RE).optional(),
  from: z.string().regex(DAY_RE).optional(),
  to: z.string().regex(DAY_RE).optional(),
}).refine((q) => (q.before != null) !== (q.from != null || q.to != null), { message: 'Give before, or from and to' })
  .refine((q) => q.before != null || (q.from != null && q.to != null), { message: 'from and to go together' })
  .refine((q) => q.from == null || q.to == null || q.from <= q.to, { message: 'from is after to' })

export const orderSaveSchema = z.object({
  /** "8/10"; empty forgets the plate's value. */
  text: z.string().max(40),
})

export type DaySave  = z.infer<typeof daySaveSchema>
export type OrderSave = z.infer<typeof orderSaveSchema>
