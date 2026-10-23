import { z } from 'zod'

export const createUserGroupSchema = z.object({
  organisationId: z.string().min(1).optional(),
  organisationIds: z.array(z.string().min(1)).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Organisation IDs must be unique')
    .optional(),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullable().optional(),
}).strict()

export const updateUserGroupSchema = z.object({
  organisationIds: z.array(z.string().min(1)).min(1).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Organisation IDs must be unique')
    .optional(),
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be provided',
})

export const setUserGroupsSchema = z.object({
  groupIds: z.array(z.string().cuid()).max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Group IDs must be unique'),
}).strict()

export type CreateUserGroupDto = z.infer<typeof createUserGroupSchema>
export type UpdateUserGroupDto = z.infer<typeof updateUserGroupSchema>
export type SetUserGroupsDto = z.infer<typeof setUserGroupsSchema>
