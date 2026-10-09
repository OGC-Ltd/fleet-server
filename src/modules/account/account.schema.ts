/**
 * What a person may change about their own account.
 *
 * The list is short on purpose, and the shape of the schemas is what enforces
 * it. `.strict()` is doing real work below: Zod strips unknown keys by
 * default, so a body of `{ fullName: 'x', role: 'admin' }` would otherwise be
 * accepted, silently ignored, and answered 200 — which reads to the caller
 * like the role change worked. Refusing it outright is the honest answer and
 * makes the boundary testable.
 */

import { z } from 'zod'

/**
 * The password rule for anything NEW.
 *
 * Twelve, matching the provisioning schema rather than login's eight: login
 * has to keep accepting whatever people already have, but nothing forces a new
 * password to inherit that floor. Length is the only rule — composition rules
 * push people toward `Password1!` and a 12-character passphrase beats it.
 */
export const NEW_PASSWORD = z.string().min(12, 'Use at least 12 characters').max(200)

export const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2, 'Name is too short').max(100),
  })
  .strict()

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: NEW_PASSWORD,
  })
  .strict()

export const forgotPasswordSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
  })
  .strict()

export const setupSchema = z
  .object({
    token: z.string().min(20),
    password: NEW_PASSWORD,
  })
  .strict()

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>
export type SetupDto = z.infer<typeof setupSchema>

/** The first-time tour, seen: the version new-ui showed (lib/productTour). */
export const tourSeenSchema = z
  .object({
    version: z.number().int().min(1).max(1000),
  })
  .strict()

export type TourSeenDto = z.infer<typeof tourSeenSchema>
