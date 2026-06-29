import { z } from 'zod'

export const createTripSchema = z.object({
  vehicleId: z.string().cuid(),
  driverId: z.string().cuid().optional(),
  reportingPeriodId: z.string().cuid(),
  beganAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  initialLocation: z.string().max(255).optional(),
  finalLocation: z.string().max(255).optional(),
  durationSeconds: z.number().int().nonnegative(),
  mileageKm: z.number().nonnegative(),
  avgSpeedKmh: z.number().nonnegative().optional(),
  maxSpeedKmh: z.number().nonnegative().optional(),
  engineHoursSeconds: z.number().int().nonnegative().optional(),
  consumedMl: z.number().int().nonnegative().optional(),
  consumedByFlsMl: z.number().int().nonnegative().optional(),
  ratesDeviationByFls: z.number().optional(),
  avgConsumptionL100km: z.number().nonnegative().optional(),
  avgConsumptionByFls: z.number().nonnegative().optional(),
  avgIdleConsumptionByFls: z.number().nonnegative().optional(),
  avgMileagePerUnitFls: z.number().nonnegative().optional(),
  initialFuelLevelMl: z.number().int().nonnegative().optional(),
  finalFuelLevelMl: z.number().int().nonnegative().optional(),
  maxFuelLevelMl: z.number().int().nonnegative().optional(),
  minFuelLevelMl: z.number().int().nonnegative().optional(),
})

/** Cursor-based pagination for high-volume event tables. */
export const listTripQuerySchema = z.object({
  vehicleId: z.string().cuid().optional(),
  driverId: z.string().cuid().optional(),
  reportingPeriodId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export type CreateTripDto = z.infer<typeof createTripSchema>
export type ListTripQuery = z.infer<typeof listTripQuerySchema>
