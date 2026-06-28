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

export type CreateUserDto = z.infer<typeof createUserSchema>
export type UpdateUserDto = z.infer<typeof updateUserSchema>
export type ListUserQuery = z.infer<typeof listUserQuerySchema>
export type AssignRoleDto = z.infer<typeof assignRoleSchema>
