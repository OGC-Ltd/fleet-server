// Requests for the Driver conduct follow-up: the cases a report run finds, an
// action recorded on one, and the incidents operators log by hand. Shapes are
// the Reports page's own (new-ui lib/followUp, lib/operatorLog): epoch ms
// times, a case id of "<unit key>|<fleet day>".
import { z } from 'zod'

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A fleet day, YYYY-MM-DD')
const count = z.number().int().min(0).max(100_000).catch(0)
const ms = z.number().int().positive()
const text = (max: number) => z.string().max(max).catch('').default('')

/** One vehicle-day a report run found, as lib/followUp casesFromRun builds it. */
export const foundCaseSchema = z.object({
  id: z.string().min(3).max(200),
  day,
  unitKey: z.string().min(1).max(160),
  plate: z.string().max(60).default(''),
  group: z.string().max(120).nullish(),
  driver: text(160),
  accel: count, brake: count, seatbelt: count, phone: count, covered: count,
  openedAt: ms,
})
export type FoundCase = z.infer<typeof foundCaseSchema>

/** A run's cases; a week of a large fleet stays well under the cap. */
export const foundCasesSchema = z.object({ cases: z.array(foundCaseSchema).max(5_000) })

/** A case as a browser kept it, to bring it here once (lib/followUp exportCases). */
export const storedCaseSchema = foundCaseSchema.extend({
  status: z.enum(['pending', 'done']).catch('pending'),
  action: z.string().max(120).nullish(),
  note: text(1000),
  by: text(160),
  actedAt: ms.nullish(),
})
export type StoredCase = z.infer<typeof storedCaseSchema>
export const importCasesSchema = z.object({ cases: z.array(storedCaseSchema).max(20_000) })

/** What was done on a case; a null action puts it back to pending. */
export const caseActionSchema = z.object({
  action: z.string().min(1).max(120).nullable(),
  note: z.string().max(1000).default(''),
})
export type CaseAction = z.infer<typeof caseActionSchema>

export const listCasesQuerySchema = z.object({ from: day.optional(), to: day.optional() })

export const OPERATOR_KINDS = ['phone', 'seatbelt', 'covered', 'other'] as const

/** An incident an operator logged (lib/operatorLog clean). */
export const incidentSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(OPERATOR_KINDS),
  other: text(120),
  at: ms,
  vehicleId: z.string().max(80).nullish(),
  plate: z.string().max(40).default(''),
  driver: text(120),
  location: text(200),
  status: z.enum(['Online', 'Offline']).catch('Online'),
  details: text(1000),
  by: text(120),
  loggedAt: ms.optional(),
}).refine((e) => Boolean(e.vehicleId || e.plate), { message: 'A unit is needed', path: ['plate'] })
export type IncidentBody = z.infer<typeof incidentSchema>
export const importIncidentsSchema = z.object({ entries: z.array(incidentSchema).max(20_000) })
