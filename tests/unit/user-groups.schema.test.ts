import { describe, expect, it } from 'vitest'
import { createUserGroupSchema, updateUserGroupSchema } from '../../src/modules/users/user-groups.schema.js'

describe('user group organisation scope schemas', () => {
  it('accepts a group shared by multiple organisations', () => {
    expect(createUserGroupSchema.safeParse({
      name: 'Dispatch',
      organisationIds: ['org-one', 'org-two'],
    }).success).toBe(true)
  })

  it('keeps the single-organisation create contract compatible', () => {
    expect(createUserGroupSchema.safeParse({
      name: 'Dispatch',
      organisationId: 'org-one',
    }).success).toBe(true)
  })

  it('rejects empty or duplicate organisation selections', () => {
    expect(createUserGroupSchema.safeParse({
      name: 'Dispatch',
      organisationIds: [],
    }).success).toBe(false)
    expect(updateUserGroupSchema.safeParse({
      organisationIds: ['org-one', 'org-one'],
    }).success).toBe(false)
  })

  it('accepts organisation-only updates', () => {
    expect(updateUserGroupSchema.safeParse({
      organisationIds: ['org-one', 'org-two'],
    }).success).toBe(true)
  })
})
