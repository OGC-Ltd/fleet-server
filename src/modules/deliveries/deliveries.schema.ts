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
  /** The stops carried over from an earlier day's list by deliveries/roll-over (names, or a pasted point's name). */
  carried: z.array(z.string().max(300)).max(500).optional(),
  /** The day they were carried from, 'YYYY-MM-DD'. */
  carriedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export const daySaveSchema = z.object({
  vehicles: z.array(vehicle).max(500),
})

export const dayBeforeQuerySchema = z.object({
  before: z.string().regex(DAY_RE),
})

export const orderSaveSchema = z.object({
  /** "8/10"; empty forgets the plate's value. */
  text: z.string().max(40),
})

export type DaySave  = z.infer<typeof daySaveSchema>
export type OrderSave = z.infer<typeof orderSaveSchema>
