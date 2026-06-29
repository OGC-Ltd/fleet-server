import { z } from 'zod'

const cargoTypes = ['BULK', 'PACKAGED', 'LIVESTOCK', 'HAZMAT', 'FUEL', 'MACHINERY', 'OTHER'] as const

export const upsertCargoSchema = z.object({
  description:       z.string().max(500).optional(),
  cargoType:         z.enum(cargoTypes).optional(),
  declaredWeightKg:  z.number().positive().optional(),
  departureWeightKg: z.number().positive().optional(),
  arrivalWeightKg:   z.number().positive().optional(),
  weightVarianceKg:  z.number().optional(),
  notes:             z.string().max(1000).optional(),
})

export type UpsertCargo = z.infer<typeof upsertCargoSchema>
