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
  status: z.enum(['open', 'active', 'closed', 'audit', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type ListFollowUpQuery = z.infer<typeof listFollowUpQuerySchema>

/** A note, and the reason given for a decision. Required: an escalation or a
 *  de-escalation with no reason on record cannot be reviewed later. */
export const followUpNoteSchema = z.object({
  note: z.string().trim().min(3).max(2000),
})
export type FollowUpNoteDto = z.infer<typeof followUpNoteSchema>

/**
 * What an escalation is FOR. Escalating no longer means only "confirmed
 * theft": a false alert escalated as a faulty probe goes to Repairs and the
 * Fuel Audit instead. One button with a reason under it, not a button per
 * reason, so the next kind of escalation is one more value here.
 */
export const ESCALATION_REASONS = ['theft', 'probe_fault'] as const
export type EscalationReason = (typeof ESCALATION_REASONS)[number]

/** Escalating a case: the note, and what it is escalated as. */
export const escalateFollowUpSchema = z.object({
  note: z.string().trim().min(3).max(2000),
  reason: z.enum(ESCALATION_REASONS).default('theft'),
})
export type EscalateFollowUpDto = z.infer<typeof escalateFollowUpSchema>

/** An administrator deciding a live alert from its window, without deleting it
 *  first. The note is required for the same reason as followUpNoteSchema;
 *  `reason` says what an escalation is for and is ignored on a de-escalation. */
export const reviewTheftSchema = z.object({
  outcome: z.enum(['ESCALATED', 'DEESCALATED']),
  note: z.string().trim().min(3).max(2000),
  reason: z.enum(ESCALATION_REASONS).default('theft'),
})
export type ReviewTheftDto = z.infer<typeof reviewTheftSchema>

/** An administrator handing a follow-up to somebody; the note is optional. */
export const assignFollowUpSchema = z.object({
  assigneeId: z.string().trim().min(1),
  note: z.string().trim().max(2000).optional(),
})
export type AssignFollowUpDto = z.infer<typeof assignFollowUpSchema>

/** An administrator taking a follow-up back; the reason is optional. */
export const recallFollowUpSchema = z.object({
  note: z.string().trim().max(2000).optional(),
})
export type RecallFollowUpDto = z.infer<typeof recallFollowUpSchema>

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
  reviewStatus: z.enum(['none', 'DISMISSED', 'UNDER_REVIEW', 'CONFIRMED_THEFT', 'NOT_THEFT', 'PROBE_FAULT']).optional(),
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

// ── Signal alerts — see fuel-signal-alerts ──────────────────────────────────

const profileType = z.enum(['truck', 'car', 'bus', 'motorcycle', 'excavator', 'generator', 'bulldozer', 'forklift'])

/**
 * Overrides for the profile a vehicle would otherwise resolve to. `consumption`
 * is litres per the profile's work unit (km or engine-hour).
 */
const profileOverrides = {
  profile:       profileType.optional(),
  consumption:   z.coerce.number().positive().optional(),
  tankCapacityL: z.coerce.number().positive().optional(),
}

/** GET /signal-alerts/vehicles/:vehicleId. Defaults to the last 24 hours. */
export const signalAlertQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to:   z.coerce.date().optional(),
  ...profileOverrides,
})
export type SignalAlertQuery = z.infer<typeof signalAlertQuerySchema>

const signalSampleSchema = z.object({
  /** ISO string or epoch milliseconds. */
  t:            z.coerce.date(),
  fuelL:        z.number().nonnegative().nullable(),
  ax:           z.number().nullable().optional(),
  ay:           z.number().nullable().optional(),
  az:           z.number().nullable().optional(),
  /** Cumulative odometer km or engine-hours, in the profile's unit. */
  work:         z.number().nullable().optional(),
  workMeasured: z.boolean().optional(),
  speedKmh:     z.number().nonnegative().nullable().optional(),
  ignitionOff:  z.boolean().nullable().optional(),
})

/**
 * POST /signal-alerts/evaluate and /signal-alerts/vehicles/:vehicleId/evaluate.
 *
 * The cap is set by the app-wide 1 MB JSON limit, not by the detector:
 * measured, 10,000 samples with all three axes come to 1,057 KB even with
 * epoch-ms `t` and floats at 2 dp, and 1,599 KB with ISO times and full
 * precision. 8,000 compact samples fit; verbose ones hit the 413 first. Each
 * request is a fresh detector, so a caller splitting a long series loses the
 * filter state at every split.
 */
export const evaluateSignalsSchema = z.object({
  ...profileOverrides,
  samples: z.array(signalSampleSchema).min(1).max(8_000),
})
export type EvaluateSignalsDto = z.infer<typeof evaluateSignalsSchema>
