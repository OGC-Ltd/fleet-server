import { z } from 'zod'

export const createRoleSchema = z.object({
  name: z.string().min(2).max(60),
  slug: z.string().min(2).max(60).regex(/^[a-z0-9_]+$/, 'slug must be lowercase alphanumeric with underscores'),
  description: z.string().max(255).optional(),
})

export const updateRoleSchema = createRoleSchema.omit({ slug: true }).partial()

export const permissionAssignSchema = z.object({
  permissionId: z.string().cuid(),
})

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type CreateRoleDto = z.infer<typeof createRoleSchema>
export type UpdateRoleDto = z.infer<typeof updateRoleSchema>
export type PermissionAssignDto = z.infer<typeof permissionAssignSchema>
export type ListQuery = z.infer<typeof listQuerySchema>
