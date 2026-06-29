import { z } from 'zod'

export const createGroupSchema = z.object({
  name: z.string().min(2).max(80),
  code: z.string().min(2).max(20).toUpperCase(),
})

export const updateGroupSchema = createGroupSchema.partial()

export const createVehicleSchema = z.object({
  vehicleGroupId: z.string().cuid(),
  name: z.string().min(1).max(100),
  registrationPlate: z.string().min(1).max(20),
  deviceId: z.string().min(1).max(100),
  vehicleType: z.string().min(1).max(50),
  fuelEfficiencyKmpl: z.number().positive().optional(),
  tankCapacityLitres: z.number().positive().optional(),
})

export const updateVehicleSchema = createVehicleSchema.omit({ vehicleGroupId: true, registrationPlate: true, deviceId: true }).partial()

export const createAssignmentSchema = z.object({
  userId: z.string().cuid(),
  assignmentType: z.enum(['PRIMARY', 'RELIEF']).default('PRIMARY'),
  notes: z.string().max(500).optional(),
})

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  vehicleGroupId: z.string().cuid().optional(),
})

export type CreateGroupDto = z.infer<typeof createGroupSchema>
export type UpdateGroupDto = z.infer<typeof updateGroupSchema>
export type CreateVehicleDto = z.infer<typeof createVehicleSchema>
export type UpdateVehicleDto = z.infer<typeof updateVehicleSchema>
export type CreateAssignmentDto = z.infer<typeof createAssignmentSchema>
export type ListQuery = z.infer<typeof listQuerySchema>
