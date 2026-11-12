import { z } from 'zod'

export const listUsersQuerySchema = z.object({
  search: z.string().max(120).optional(),
  page:   z.coerce.number().int().min(1).default(1),
  limit:  z.coerce.number().int().min(1).max(500).default(500),
})

export const grantChangeSchema = z.object({
  /** null = every organisation this person can reach. */
  organisationId: z.string().min(1).max(64).nullable(),
  /** A `resource:action` slug from the catalogue. */
  permission: z.string().min(3).max(80),
  /** `inherit` removes the personal grant: back to whatever the role says. */
  effect: z.enum(['allow', 'deny', 'inherit']),
})

export const setGrantsSchema = z.object({
  changes: z.array(grantChangeSchema).min(1).max(300),
})

/** One organisation's fleet for one person: all of it, or these categories. */
export const setFleetSchema = z.object({
  organisationId:  z.string().min(1).max(64),
  allVehicles:     z.boolean(),
  vehicleGroupIds: z.array(z.string().min(1).max(64)).max(100).default([]),
})

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>
export type GrantChange    = z.infer<typeof grantChangeSchema>
export type SetGrantsDto   = z.infer<typeof setGrantsSchema>
export type SetFleetDto    = z.infer<typeof setFleetSchema>
