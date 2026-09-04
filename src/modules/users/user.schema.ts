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
  /**
   * Who counts as a "user".
   *
   * `all` is every person row, which for Sukari is 553 — of whom 549 are
   * driver records synced from the RaiFactorySuite registry. They are people,
   * and they belong in the driver screens, but they have never had a password
   * and never will: nobody invited them to the dashboard. A roster whose job
   * is "who can get in" listing 553 rows with one of them real is not a
   * roster, it is a haystack.
   *
   * `system` narrows to people who were actually given access. Opt-in rather
   * than the default, so the existing callers of this endpoint are unaffected.
   */
  access: z.enum(['all', 'system']).optional().default('all'),
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

/**
 * The org-scoped form: the organisation is the path, so it is not in the body.
 *
 * `password` is REMOVED here, and that is a security fix rather than tidying.
 * provisionUser overwrites the password of an account that already exists with
 * the given email — so an admin at org A who typed an address belonging to
 * somebody at org B would take over that account. Org admins now invite
 * instead: the person sets their own password through a link, and nobody else
 * can set it for them. The platform-level POST /users keeps the field.
 */
export const orgProvisionUserSchema = provisionUserSchema
  .omit({ memberships: true, password: true })
  .extend({
    roleSlugs:       z.array(z.string().min(1)).default([]),
    allVehicles:     z.boolean().default(true),
    vehicleIds:      z.array(z.string().cuid()).default([]),
    vehicleGroupIds: z.array(z.string().cuid()).default([]),
    /** Email the new person a set-password link. Off only for a bulk import. */
    sendInvite:      z.boolean().default(true),
    /**
     * Additional organisations, each with its OWN roles.
     *
     * Somebody can be a dispatcher at one site and an accountant at another,
     * and forcing one role across every organisation would have made the
     * roster lie about what they can do. The path organisation is always
     * granted; these are on top of it.
     *
     * The caller is checked against EVERY organisation named here — holding
     * user:create at the path org says nothing about the others. See
     * assertCanGrantOrgs in the controller.
     */
    memberships: z.array(z.object({
      organisationId: z.string().min(1),
      roleSlugs:      z.array(z.string().min(1)).max(5).default([]),
      allVehicles:    z.boolean().default(true),
    })).max(20).default([]),
  })

/** Flipping a person between ACTIVE and SUSPENDED, and nothing else. */
export const setUserStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
}).strict()

/** Replacing a person's roles in THIS organisation. */
export const setUserRoleSchema = z.object({
  roleSlugs: z.array(z.string().min(1)).max(5),
}).strict()

export const setMembershipSchema = membershipInputSchema.omit({ organisationId: true })

export type CreateUserDto = z.infer<typeof createUserSchema>
export type UpdateUserDto = z.infer<typeof updateUserSchema>
export type ListUserQuery = z.infer<typeof listUserQuerySchema>
export type AssignRoleDto = z.infer<typeof assignRoleSchema>
export type MembershipInput = z.infer<typeof membershipInputSchema>
export type ProvisionUserDto = z.infer<typeof provisionUserSchema>
export type OrgProvisionUserDto = z.infer<typeof orgProvisionUserSchema>
export type SetMembershipDto = z.infer<typeof setMembershipSchema>
export type SetUserStatusDto = z.infer<typeof setUserStatusSchema>
export type SetUserRoleDto = z.infer<typeof setUserRoleSchema>
