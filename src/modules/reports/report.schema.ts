import { z } from 'zod'

export const createPeriodSchema = z.object({
  label: z.string().min(2).max(100),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  periodType: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']),
})

export const createEngineSessionSchema = z.object({
  vehicleId: z.string().cuid(),
  reportingPeriodId: z.string().cuid(),
  beganAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  initialLocation: z.string().max(255).optional(),
  finalLocation: z.string().max(255).optional(),
  engineHoursSeconds: z.number().int().nonnegative(),
  initialEngineHoursSeconds: z.number().int().nonnegative().optional(),
  finalEngineHoursSeconds: z.number().int().nonnegative().optional(),
  totalTimeSeconds: z.number().int().nonnegative(),
  offTimeSeconds: z.number().int().nonnegative().optional(),
  inMotionSeconds: z.number().int().nonnegative().optional(),
  idlingSeconds: z.number().int().nonnegative().optional(),
  mileageKm: z.number().nonnegative().optional(),
  avgSpeedKmh: z.number().nonnegative().optional(),
  maxSpeedKmh: z.number().nonnegative().optional(),
  consumedMl: z.number().int().nonnegative().optional(),
  consumedByFlsMl: z.number().int().nonnegative().optional(),
  consumedFlsMotionMl: z.number().int().nonnegative().optional(),
  consumedFlsIdleMl: z.number().int().nonnegative().optional(),
  avgConsumptionByFls: z.number().nonnegative().optional(),
  avgConsumptionFlsMotion: z.number().nonnegative().optional(),
  avgConsumptionFlsIdle: z.number().nonnegative().optional(),
  avgConsumptionFlsTrips: z.number().nonnegative().optional(),
  initialFuelLevelMl: z.number().int().nonnegative().optional(),
  finalFuelLevelMl: z.number().int().nonnegative().optional(),
  maxFuelLevelMl: z.number().int().nonnegative().optional(),
  minFuelLevelMl: z.number().int().nonnegative().optional(),
})

export const listPeriodQuerySchema = z.object({
  periodType: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const listEngineSessionQuerySchema = z.object({
  vehicleId: z.string().cuid().optional(),
  reportingPeriodId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const listSummaryQuerySchema = z.object({
  reportingPeriodId: z.string().cuid().optional(),
  vehicleId: z.string().cuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type CreatePeriodDto = z.infer<typeof createPeriodSchema>
export type CreateEngineSessionDto = z.infer<typeof createEngineSessionSchema>
export type ListPeriodQuery = z.infer<typeof listPeriodQuerySchema>
export type ListEngineSessionQuery = z.infer<typeof listEngineSessionQuerySchema>
export type ListSummaryQuery = z.infer<typeof listSummaryQuerySchema>
