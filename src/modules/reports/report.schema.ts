import { z } from 'zod'

export const createPeriodSchema = z.object({
  label: z.string().min(2).max(100),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  periodType: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']),
})

export const createEngineSessionSchema = z.object({
  vehicleId: z.string().cuid(),
  reportingPeriodId: z.string().cuid(),
  beganAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  initialLocation: z.string().max(255).optional(),
  finalLocation: z.string().max(255).optional(),
  engineHoursSeconds: z.number().int().nonnegative(),
  initialEngineHoursSeconds: z.number().int().nonnegative().optional(),
  finalEngineHoursSeconds: z.number().int().nonnegative().optional(),
  totalTimeSeconds: z.number().int().nonnegative(),
  offTimeSeconds: z.number().int().nonnegative().optional(),
  inMotionSeconds: z.number().int().nonnegative().optional(),
  idlingSeconds: z.number().int().nonnegative().optional(),
  mileageKm: z.number().nonnegative().optional(),
  avgSpeedKmh: z.number().nonnegative().optional(),
  maxSpeedKmh: z.number().nonnegative().optional(),
  consumedMl: z.number().int().nonnegative().optional(),
  consumedByFlsMl: z.number().int().nonnegative().optional(),
  consumedFlsMotionMl: z.number().int().nonnegative().optional(),
  consumedFlsIdleMl: z.number().int().nonnegative().optional(),
  avgConsumptionByFls: z.number().nonnegative().optional(),
  avgConsumptionFlsMotion: z.number().nonnegative().optional(),
  avgConsumptionFlsIdle: z.number().nonnegative().optional(),
  avgConsumptionFlsTrips: z.number().nonnegative().optional(),
  initialFuelLevelMl: z.number().int().nonnegative().optional(),
  finalFuelLevelMl: z.number().int().nonnegative().optional(),
  maxFuelLevelMl: z.number().int().nonnegative().optional(),
  minFuelLevelMl: z.number().int().nonnegative().optional(),
})

export const listPeriodQuerySchema = z.object({
  periodType: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const listEngineSessionQuerySchema = z.object({
  vehicleId: z.string().cuid().optional(),
  reportingPeriodId: z.string().cuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const listSummaryQuerySchema = z.object({
  reportingPeriodId: z.string().cuid().optional(),
  vehicleId: z.string().cuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type CreatePeriodDto = z.infer<typeof createPeriodSchema>
export type CreateEngineSessionDto = z.infer<typeof createEngineSessionSchema>
export type ListPeriodQuery = z.infer<typeof listPeriodQuerySchema>
export type ListEngineSessionQuery = z.infer<typeof listEngineSessionQuerySchema>
export type ListSummaryQuery = z.infer<typeof listSummaryQuerySchema>

/** The movement report's window: the last 2 or the last 4 hours. */
export const movementReportQuerySchema = z.object({
  hours: z.coerce.number().refine(h => h === 2 || h === 4, { message: 'hours must be 2 or 4' }).default(2),
})
export type MovementReportQuery = z.infer<typeof movementReportQuerySchema>

/** The longest period an end-of-shift report may cover: it reads the feeds and the weighbridge day by day. */
export const END_OF_SHIFT_MAX_DAYS = 7

/**
 * The end-of-shift report's period, picked on the Reports page (operator,
 * 2026-11-02): epoch ms. Neither given: today from midnight up to now, as
 * before. Both: from before to, no later than now, at most a week.
 */
export const endOfShiftQuerySchema = z.object({
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
}).superRefine((q, ctx) => {
  if ((q.from == null) !== (q.to == null)) {
    ctx.addIssue({ code: 'custom', path: [q.from == null ? 'from' : 'to'], message: 'Give both from and to, or neither' })
    return
  }
  if (q.from == null || q.to == null) return
  if (q.from >= q.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The period ends before it starts' })
  if (q.to > Date.now() + 60_000) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The period cannot end in the future' })
  if (q.to - q.from > END_OF_SHIFT_MAX_DAYS * 86_400_000) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: `${END_OF_SHIFT_MAX_DAYS} days at most` })
  }
})
export type EndOfShiftQuery = z.infer<typeof endOfShiftQuerySchema>

/**
 * The end-of-shift report as edited on the Reports page (operator,
 * 2026-11-02), sent back to be drawn as the PDF: the document the server
 * answered (end-of-shift.pdf endOfShiftDoc), every text in it as the operator
 * left it. Bounded so a request cannot ask for an unbounded document. The
 * report number and the footer's "made" time are set again by the server.
 */
const docText = z.string().max(600)
const docTone = z.enum(['flag', 'mut']).optional()
const docCell = z.object({ text: docText, bold: z.boolean().optional(), tone: docTone })
const docTable = z.object({
  kind: z.literal('table'),
  cols: z.array(z.object({ w: z.number().min(0).max(200), align: z.enum(['left', 'right', 'center']).optional() })).min(1).max(12),
  head: z.array(z.string().max(80)).max(12),
  rows: z.array(z.array(docCell).max(12)).max(2000),
  size: z.number().min(6).max(10).optional(),
})
const docNone = z.object({ kind: z.literal('none'), text: docText })
const docBlock = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('h2'), title: z.string().max(160), aside: z.string().max(160).optional() }),
  z.object({ kind: z.literal('h3'), title: z.string().max(160), aside: z.string().max(160).optional() }),
  z.object({ kind: z.literal('figures'), items: z.array(z.object({ label: z.string().max(160), value: z.string().max(160), flag: z.boolean().optional() })).max(12) }),
  docTable,
  docNone,
  z.object({ kind: z.literal('note'), text: z.string().max(2000) }),
  z.object({ kind: z.literal('pair'), halves: z.array(z.object({ title: z.string().max(160), aside: z.string().max(160).optional(), body: z.discriminatedUnion('kind', [docTable, docNone]) })).max(2) }),
  z.object({ kind: z.literal('handover'), lines: z.array(z.string().max(300)).max(20), signatures: z.array(z.string().max(120)).max(2) }),
])
export const shiftDocSchema = z.object({
  title: z.string().max(120),
  reportNo: z.string().max(80),
  date: z.string().max(40),
  meta: z.array(z.object({ label: z.string().max(60), value: z.string().max(300) })).max(8),
  blocks: z.array(docBlock).max(300),
  footer: z.string().max(300),
})
export type ShiftDocBody = z.infer<typeof shiftDocSchema>

/**
 * The movement report as edited on the Reports page, sent back to be drawn as
 * the PDF: the rows the operator kept, with their locations and directions,
 * and how many rows they changed or left out (printed on the PDF). Bounded so
 * a request cannot ask for an unbounded document.
 *
 * The window is the one the server answered: it ends no later than now and
 * within the last day, and is exactly the hours asked for. The report number,
 * date and "Generated" on the PDF come from it, so it cannot be set freely.
 */
export const EDITED_REPORT_MAX_AGE_MS = 24 * 3_600_000
const movementRowSchema = z.object({
  vehicleId: z.string().max(80),
  plate: z.string().max(40),
  grouping: z.string().max(160),
  lastAt: z.number().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  location: z.string().trim().max(200).nullable(),
  speedKmh: z.number().nullable(),
  state: z.enum(['to', 'from', 'at', 'moving', 'stopped', 'no-fix']),
  kmToMorl: z.number().nullable(),
  closerKm: z.number().nullable(),
  stale: z.boolean(),
})
export const editedMovementReportSchema = z.object({
  hours: z.number().refine(h => h === 2 || h === 4, { message: 'hours must be 2 or 4' }),
  from: z.number(),
  to: z.number(),
  morl: z.string().max(120).nullable(),
  groups: z.array(z.object({ name: z.string().max(160), rows: z.array(movementRowSchema).max(5000) })).max(200),
  edits: z.object({ changed: z.number().int().min(0).max(100_000), removed: z.number().int().min(0).max(100_000) }),
}).superRefine((r, ctx) => {
  const now = Date.now()
  if (r.to > now + 60_000 || r.to < now - EDITED_REPORT_MAX_AGE_MS) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'The report is more than a day old or in the future: run it again' })
  }
  if (r.to - r.from !== r.hours * 3_600_000) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'The window does not match the hours of the report' })
  }
})
export type EditedMovementReport = z.infer<typeof editedMovementReportSchema>
