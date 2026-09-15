import { z } from 'zod'

/**
 * The three outcomes a technician can record against a unit.
 *
 * These strings are also a Postgres CHECK constraint (migration
 * 20260916120000_repair_reports) and a label map on the dashboard. Adding a
 * fourth means touching all three, in that order.
 */
const OUTCOMES = ['fixed', 'needs_spare', 'cannot_fix'] as const

const itemSchema = z.object({
  targetKind:     z.enum(['probe', 'fault']),
  vehicleId:      z.string().min(1),
  faultEpisodeId: z.string().min(1).optional(),
  faultKind:      z.string().max(64).optional(),
  outcome:        z.enum(OUTCOMES),
  sparePart:      z.string().trim().min(1).max(200).optional(),
  problemNote:    z.string().trim().max(2000).optional(),
})
  /*
   * The same three rules the CHECK constraints hold, restated here so a person
   * gets a 400 naming the field they left blank rather than a P2010 carrying a
   * constraint name. The database keeps its copy because the next caller may
   * not be this API.
   */
  .refine((i) => i.outcome !== 'needs_spare' || !!i.sparePart,
    { path: ['sparePart'], message: 'Name the spare part needed' })
  .refine((i) => i.outcome !== 'cannot_fix' || !!i.problemNote,
    { path: ['problemNote'], message: 'Say what stopped the repair' })
  .refine((i) => (i.targetKind === 'fault') === !!i.faultEpisodeId,
    { path: ['faultEpisodeId'], message: 'A fault item must name its episode, and a probe item must not' })

export const createRepairReportSchema = z.object({
  note:  z.string().trim().max(2000).optional(),
  // 200 is a trip nobody made. It bounds the email body and the transaction
  // rather than expressing a belief about how many probes can fail at once.
  items: z.array(itemSchema).min(1).max(200),
})
  .refine(
    (o) => new Set(
      o.items.map((i) => `${i.targetKind}:${i.vehicleId}:${i.faultEpisodeId ?? ''}`),
    ).size === o.items.length,
    { path: ['items'], message: 'The same unit appears twice in this report' },
  )

export const resolveItemSchema = z.object({
  // Required: "resolved" with no account of what was done is a status change,
  // not a record. The recommendation is optional because most fixes have none.
  fixNote:        z.string().trim().min(1).max(2000),
  recommendation: z.string().trim().max(2000).optional(),
})

export const listReportsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit:  z.coerce.number().int().min(1).max(100).default(20),
})

export const listItemsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit:  z.coerce.number().int().min(1).max(200).default(100),
  // `open` is the default because the question this endpoint answers on every
  // load of the Probes tab is "what is already reported".
  status: z.enum(['open', 'resolved', 'all']).default('open'),
})

export type CreateRepairReport = z.infer<typeof createRepairReportSchema>
export type RepairItemInput    = CreateRepairReport['items'][number]
export type ResolveItem        = z.infer<typeof resolveItemSchema>
export type ListReportsQuery   = z.infer<typeof listReportsQuerySchema>
export type ListItemsQuery     = z.infer<typeof listItemsQuerySchema>
