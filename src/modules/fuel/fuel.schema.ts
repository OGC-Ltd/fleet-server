import { z } from 'zod'

const cursorListBase = z.object({
  vehicleId: z.string().cuid().optional(),
  reportingPeriodId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const createFillingSchema = z.object({
  vehicleId: z.string().cuid(),
  reportingPeriodId: z.string().cuid(),
  filledAt: z.coerce.date(),
  location: z.string().max(255).optional(),
  mileageAtFillKm: z.number().nonnegative().optional(),
  initialFuelLevelMl: z.number().int().nonnegative().optional(),
  filledMl: z.number().int().positive(),
  finalFuelLevelMl: z.number().int().nonnegative().optional(),
})

export const listFillingQuerySchema = cursorListBase

// ── Follow-ups on dismissed incidents — see FuelTheftFollowUp ───────────────

export const listFollowUpQuerySchema = z.object({
  status: z.enum(['open', 'active', 'closed', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type ListFollowUpQuery = z.infer<typeof listFollowUpQuerySchema>

/** A note, and the reason given for a decision. Required: an escalation or a
 *  de-escalation with no reason on record cannot be reviewed later. */
export const followUpNoteSchema = z.object({
  note: z.string().trim().min(3).max(2000),
})
export type FollowUpNoteDto = z.infer<typeof followUpNoteSchema>

/** An administrator handing a follow-up to somebody; the note is optional. */
export const assignFollowUpSchema = z.object({
  assigneeId: z.string().trim().min(1),
  note: z.string().trim().max(2000).optional(),
})
export type AssignFollowUpDto = z.infer<typeof assignFollowUpSchema>

export const createTheftSchema = z.object({
  vehicleId: z.string().cuid(),
  driverId: z.string().cuid().optional(),
  reportingPeriodId: z.string().cuid(),
  beganAt: z.coerce.date(),
  detectedAt: z.coerce.date(),
  initialLocation: z.string().max(255).optional(),
  initialFuelLevelMl: z.number().int().nonnegative().optional(),
  finalFuelLevelMl: z.number().int().nonnegative().optional(),
  stolenMl: z.number().int().positive(),
  initialSpeedKmh: z.number().nonnegative().optional(),
  finalSpeedKmh: z.number().nonnegative().optional(),
})

export const listTheftQuerySchema = cursorListBase.extend({
  /** Filter by what reviewers concluded; `none` = never deleted. See
   *  FuelTheft.reviewStatus. */
  reviewStatus: z.enum(['none', 'DISMISSED', 'UNDER_REVIEW', 'CONFIRMED_THEFT', 'NOT_THEFT']).optional(),
})

/** The review-outcome analytics window, on when the fuel left (`beganAt`). */
export const theftOutcomesQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})
export type TheftOutcomesQuery = z.infer<typeof theftOutcomesQuerySchema>

export type CreateFillingDto = z.infer<typeof createFillingSchema>
export type ListFillingQuery = z.infer<typeof listFillingQuerySchema>
export type CreateTheftDto = z.infer<typeof createTheftSchema>
export type ListTheftQuery = z.infer<typeof listTheftQuerySchema>
