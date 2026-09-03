import { z } from 'zod'

export const createUserSchema = z.object({
  fullName: z.string().min(2).max(100),
  email: z.string().email(),
  phone: z.string().optional(),
  licenceNumber: z.string().optional(),
  employeeId: z.string().optional(),
})

export const updateUserSchema = createUserSchema
  .omit({ email: true })
  .extend({ status: z.enum(['ACTIVE', 'SUSPENDED', 'TERMINATED']).optional() })
  .partial()

export const listUserQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'TERMINATED']).optional(),
})

export const assignRoleSchema = z.object({
  roleId: z.string().cuid(),
})

/**
 * One organisation's worth of access.
 *
 * Roles are named by SLUG rather than id: a role is per organisation, so
 * `operator` is a different row in each, and asking a caller to look up four
 * ids to grant the same role in four places invites pasting the wrong one.
 */
export const membershipInputSchema = z.object({
  organisationId:  z.string().cuid(),
  roleSlugs:       z.array(z.string().min(1)).default([]),
  // true = the whole fleet, including vehicles added later.
  allVehicles:     z.boolean().default(true),
  vehicleIds:      z.array(z.string().cuid()).default([]),
  vehicleGroupIds: z.array(z.string().cuid()).default([]),
})

export const provisionUserSchema = z.object({
  fullName:   z.string().min(2).max(100),
  email:      z.string().email(),
  phone:      z.string().optional(),
  employeeId: z.string().optional(),
  // Optional: an account provisioned without one exists but cannot sign in,
  // which is the correct state for someone whose password is set separately.
  password:   z.string().min(12).optional(),
  memberships: z.array(membershipInputSchema).min(1),
})

/** The org-scoped form: the organisation is the path, so it is not in the body. */
export const orgProvisionUserSchema = provisionUserSchema
  .omit({ memberships: true })
  .extend({
    roleSlugs:       z.array(z.string().min(1)).default([]),
    allVehicles:     z.boolean().default(true),
    vehicleIds:      z.array(z.string().cuid()).default([]),
    vehicleGroupIds: z.array(z.string().cuid()).default([]),
  })

export const setMembershipSchema = membershipInputSchema.omit({ organisationId: true })

export type CreateUserDto = z.infer<typeof createUserSchema>
export type UpdateUserDto = z.infer<typeof updateUserSchema>
export type ListUserQuery = z.infer<typeof listUserQuerySchema>
export type AssignRoleDto = z.infer<typeof assignRoleSchema>
export type MembershipInput = z.infer<typeof membershipInputSchema>
export type ProvisionUserDto = z.infer<typeof provisionUserSchema>
export type OrgProvisionUserDto = z.infer<typeof orgProvisionUserSchema>
export type SetMembershipDto = z.infer<typeof setMembershipSchema>
