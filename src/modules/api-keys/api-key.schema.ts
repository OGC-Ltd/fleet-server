import { z } from 'zod'

export const createApiKeySchema = z.object({
  label:     z.string().min(1).max(80),
  expiresAt: z.coerce.date().optional(),
})

export const updateApiKeySchema = z.object({
  label:    z.string().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
})

export type CreateApiKey = z.infer<typeof createApiKeySchema>
export type UpdateApiKey = z.infer<typeof updateApiKeySchema>
