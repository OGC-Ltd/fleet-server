import { z } from 'zod'

const cursorListBase = z.object({
  vehicleId: z.string().cuid().optional(),
  reportingPeriodId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const createFillingSchema = z.object({
  vehicleId: z.string().cuid(),
  reportingPeriodId: z.string().cuid(),
  filledAt: z.coerce.date(),
  location: z.string().max(255).optional(),
  mileageAtFillKm: z.number().nonnegative().optional(),
  initialFuelLevelMl: z.number().int().nonnegative().optional(),
  filledMl: z.number().int().positive(),
  finalFuelLevelMl: z.number().int().nonnegative().optional(),
})

export const listFillingQuerySchema = cursorListBase

export const createTheftSchema = z.object({
  vehicleId: z.string().cuid(),
  driverId: z.string().cuid().optional(),
  reportingPeriodId: z.string().cuid(),
  beganAt: z.coerce.date(),
  detectedAt: z.coerce.date(),
  initialLocation: z.string().max(255).optional(),
  initialFuelLevelMl: z.number().int().nonnegative().optional(),
  finalFuelLevelMl: z.number().int().nonnegative().optional(),
  stolenMl: z.number().int().positive(),
  initialSpeedKmh: z.number().nonnegative().optional(),
  finalSpeedKmh: z.number().nonnegative().optional(),
})

export const listTheftQuerySchema = cursorListBase

export type CreateFillingDto = z.infer<typeof createFillingSchema>
export type ListFillingQuery = z.infer<typeof listFillingQuerySchema>
export type CreateTheftDto = z.infer<typeof createTheftSchema>
export type ListTheftQuery = z.infer<typeof listTheftQuerySchema>
