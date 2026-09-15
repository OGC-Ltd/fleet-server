import { z } from 'zod'

/**
 * The three outcomes a technician can record against a unit.
 *
 * These strings are also a Postgres CHECK constraint (migration
 * 20260916120000_repair_reports) and a label map on the dashboard. Adding a
 * fourth means touching all three, in that order.
 */
const OUTCOMES = ['fixing', 'needs_spare', 'cannot_fix'] as const

/**
 * Where a job can be, and the ladder it climbs.
 *
 * Also a CHECK constraint (migration 20260916140000_repair_item_stage) and a
 * label map on the dashboard, the same three-places rule the outcomes have.
 *
 * 'fixed' is absent from `setStageSchema` below on purpose: it is a claim
 * somebody has to stand behind, so it is reachable only through the resolve
 * route, which demands an account of the fix. Postgres holds that rule too.
 */
export const STAGES = ['pending', 'spare_outsourced', 'fixing', 'fixed', 'failed'] as const
export type Stage = (typeof STAGES)[number]

/**
 * The stage a filed outcome lands on.
 *
 * NOTHING SEEDS 'pending', AND THAT IS THE POINT. 'pending' is what a broken
 * probe IS before anybody has been out to it — a fault the fleet can see and
 * nobody has taken on. It has no row in this table, so it is computed on the
 * dashboard from probe health, and the first thing filing a report does is
 * take the unit OUT of it.
 *
 * Which is why 'needs_spare' lands on 'spare_outsourced': by the time a
 * technician has stood at the unit and named the part, the waiting has started
 * and the report is what sets the order going. An earlier version landed it
 * back on 'pending' to distinguish "named" from "ordered", and that read as
 * the report having achieved nothing.
 */
export const STAGE_FOR_OUTCOME: Record<(typeof OUTCOMES)[number], Stage> = {
  fixing:      'fixing',
  needs_spare: 'spare_outsourced',
  cannot_fix:  'failed',
}

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
  /*
   * How it ended. Defaulting to 'fixed' keeps every existing caller correct
   * and matches the common close; 'failed' is the unit that came off the road
   * for good, and it must be a DIFFERENT terminal stage rather than a fixed
   * one with a sad note, because the ladder is what somebody scans.
   */
  verdict:        z.enum(['fixed', 'failed']).default('fixed'),
})

/**
 * Move an OPEN job between the working stages.
 *
 * No 'fixed' here — see STAGES. The note is short by design: it is a line on a
 * tracking line ("part ordered from Nairobi"), not the account of the repair,
 * which belongs to the sign-off and has ten times the budget.
 */
export const setStageSchema = z.object({
  stage: z.enum(['pending', 'spare_outsourced', 'fixing', 'failed']),
  note:  z.string().trim().max(500).optional(),
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
  // Narrower than `status`, and orthogonal to it: "what is waiting on a part"
  // is a question about the ladder, not about the sign-off.
  stage:  z.enum(STAGES).optional(),
  // One unit's repair history — the detail panel's tracking line. Served by
  // the [vehicle_id, created_at] index the table has carried from the start.
  vehicleId: z.string().min(1).optional(),
})

export type CreateRepairReport = z.infer<typeof createRepairReportSchema>
export type RepairItemInput    = CreateRepairReport['items'][number]
export type ResolveItem        = z.infer<typeof resolveItemSchema>
export type SetStage           = z.infer<typeof setStageSchema>
export type ListReportsQuery   = z.infer<typeof listReportsQuerySchema>
export type ListItemsQuery     = z.infer<typeof listItemsQuerySchema>
