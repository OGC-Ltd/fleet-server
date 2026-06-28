import { z } from 'zod'

export const createOrgSchema = z.object({
  name: z.string().min(2).max(100),
  code: z.string().min(2).max(20).toUpperCase(),
})

export const updateOrgSchema = createOrgSchema.partial()

export const listOrgQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type CreateOrgDto = z.infer<typeof createOrgSchema>
export type UpdateOrgDto = z.infer<typeof updateOrgSchema>
export type ListOrgQuery = z.infer<typeof listOrgQuerySchema>
