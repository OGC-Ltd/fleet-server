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

/**
 * How far ahead an estimate is allowed to reach, days.
 *
 * Not a policy about supply chains — it is a typo filter. A technician who
 * means 2026 and types 2036 has produced a job nothing will ever chase, and a
 * year is comfortably past the worst real wait (a sender out of Nairobi) while
 * still catching a slipped digit.
 */
const MAX_ESTIMATE_DAYS = 365

/** Midnight UTC today. The floor an estimate is measured against. */
function utcToday(): Date {
  const n = new Date()
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
}

/**
 * A calendar day, as `YYYY-MM-DD`, parsed to midnight UTC.
 *
 * A STRING ON THE WIRE, NOT A DATE. `z.coerce.date()` would accept the same
 * text and is the obvious choice, but it parses through the runtime's local
 * timezone for a bare date in some engines and not others — which is exactly
 * how "the 25th" becomes the 24th for the half of the fleet east of UTC. The
 * column is `DATE` for the same reason (see the migration). Building the
 * instant from explicit UTC parts is the only version with no conversion in it.
 *
 * `<input type="date">` emits precisely this format, so the dashboard sends
 * what it holds and nothing serialises a Date on the way out.
 */
const calendarDay = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Give the date as YYYY-MM-DD')
  .transform((v) => new Date(`${v}T00:00:00.000Z`))
  // `2026-02-31` has the right shape and is not a day. ISO parsing rejects an
  // out-of-range component rather than rolling it into March, which is the one
  // thing standing between that string and a stored date nobody chose.
  .refine((d) => !Number.isNaN(d.getTime()), 'That is not a real date')
  /*
   * ## The bounds live HERE, on the field, and not on the object below
   *
   * This is not a style preference — it is the difference between a 400 and a
   * 500. Zod runs an object's `.refine()` chain even when a member FAILED its
   * own parse, handing the refinement the raw input it was given. So an
   * object-level rule reading `.getTime()` on this field meets a bare string
   * the moment somebody posts "next Tuesday", and throws a TypeError out of
   * validation — the layer whose entire job is to turn bad input into a
   * message. A refinement attached to the field runs only after the transform
   * has produced a Date, so there is no such state to be in.
   *
   * Today is deliberately allowed: a part collected this afternoon is a real
   * answer, and only YESTERDAY is certainly a mistake. Rejecting today would
   * push a technician to type tomorrow — a date they do not mean, entered to
   * get past a form.
   *
   * Neither bound is a CHECK constraint, because a CHECK comparing to now() is
   * not immutable: it would make the table's validity a function of the clock
   * and fail a restore of rows that were perfectly legal when written.
   */
  .refine((d) => d >= utcToday(), 'That date has already passed')
  .refine(
    (d) => d.getTime() - utcToday().getTime() <= MAX_ESTIMATE_DAYS * 86_400_000,
    'That is more than a year away — check the year',
  )

const itemSchema = z.object({
  targetKind:     z.enum(['probe', 'fault']),
  vehicleId:      z.string().min(1),
  faultEpisodeId: z.string().min(1).optional(),
  faultKind:      z.string().max(64).optional(),
  outcome:        z.enum(OUTCOMES),
  sparePart:      z.string().trim().min(1).max(200).optional(),
  problemNote:    z.string().trim().max(2000).optional(),
  /**
   * When the technician expects the unit back in service.
   *
   * Demanded below for 'needs_spare' and merely ALLOWED for the other two, the
   * same latitude the CHECK constraint gives. A technician mid-repair who
   * knows it will run to Thursday is telling the truth; the dashboard does not
   * offer them the field, but this is the contract and not the form.
   */
  expectedResolutionAt: calendarDay.optional(),
})
  /*
   * The same rules the CHECK constraints hold, restated here so a person
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
  /*
   * And the fourth, which Postgres also holds: outsourcing a part is the one
   * outcome that hands the job to somebody else and then waits, and a wait
   * with no stated end cannot be chased.
   */
  .refine((i) => i.outcome !== 'needs_spare' || !!i.expectedResolutionAt,
    { path: ['expectedResolutionAt'], message: 'Say when you expect this to be resolved' })

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
  /*
   * `open` is the default because the question this endpoint answers on every
   * load of the Probes tab is "what is already reported".
   *
   * 'resolved' and 'unresolved' SPLIT the signed-off jobs rather than nesting,
   * and that is the fix for a real complaint: a job signed off unsuccessfully
   * was filed under "Resolved", which is the one word it is not. It went where
   * nobody would look for it and read as lost. They are now two buckets —
   * "the unit went back into service" and "it did not" — and 'all' is still
   * the union of everything.
   *
   * Both are keyed on `stage` and not on `resolvedAt` alone, because the
   * terminal stage is what says WHICH kind of finished a job is. Postgres
   * guarantees a signed-off job is one of the two (the stage/resolution CHECK
   * in 20260916140000), so the pair cannot leave a row unreachable.
   */
  status: z.enum(['open', 'resolved', 'unresolved', 'all']).default('open'),
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
