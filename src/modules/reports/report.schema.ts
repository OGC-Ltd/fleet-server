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
/** A movement report covers a day at most, ending within the last month (telemetry is kept). */
export const MOVEMENT_MAX_WINDOW_H = 24
export const MOVEMENT_MAX_AGE_DAYS = 31
const H = 3_600_000
function movementWindowIssues(from: number, to: number, ctx: z.RefinementCtx) {
  const now = Date.now()
  if (to <= from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The window ends before it starts' })
  if (to - from > MOVEMENT_MAX_WINDOW_H * H) ctx.addIssue({ code: 'custom', path: ['from'], message: `${MOVEMENT_MAX_WINDOW_H} hours at most` })
  if (to > now + 60_000) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The window cannot end in the future' })
  if (to < now - MOVEMENT_MAX_AGE_DAYS * 24 * H) ctx.addIssue({ code: 'custom', path: ['to'], message: `The window must end within the last ${MOVEMENT_MAX_AGE_DAYS} days` })
}

/**
 * The last `hours` up to now (1 to 24, 2 when neither is given), or a window
 * from–to (epoch ms, a day at most, within the last month): hourly reports
 * and a range of days between set hours (operator, 2026-11-02).
 */
export const movementReportQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(MOVEMENT_MAX_WINDOW_H).optional(),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
  /** Keep the units not reporting, which the report leaves out outside Menengai. */
  offline: z.enum(['1']).optional(),
}).superRefine((q, ctx) => {
  if ((q.from == null) !== (q.to == null)) {
    ctx.addIssue({ code: 'custom', path: [q.from == null ? 'from' : 'to'], message: 'Give both from and to, or neither' })
    return
  }
  if (q.from != null && q.to != null) movementWindowIssues(q.from, q.to, ctx)
}).transform(q => ({ ...q, hours: q.hours ?? 2 }))
export type MovementReportQuery = z.infer<typeof movementReportQuerySchema>

/**
 * The Tankers Report's request (operator, 2–4 Nov 2026): the tankers off the
 * Reports page's fleet list, each with its trackers, and the report time
 * (default now). Sent in a body, as the list is too long for a query string.
 */
export const tankersReportBodySchema = z.object({
  to: z.number().int().positive().optional(),
  units: z.array(z.object({
    key: z.string().trim().min(1).max(80),
    plate: z.string().trim().min(1).max(80),
    vehicleIds: z.array(z.string().max(80)).max(10),
  })).max(500),
}).superRefine((q, ctx) => {
  if (q.to != null && q.to > Date.now() + 60_000) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The report time cannot be in the future' })
})
export type TankersReportBody = z.infer<typeof tankersReportBodySchema>

/** The TAT and Fuel and Speed Reports' request: one fleet day. */
export const tatFuelReportQuerySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be YYYY-MM-DD'),
})
export type TatFuelReportQuery = z.infer<typeof tatFuelReportQuerySchema>

/** The most rows one of the PDFs below takes: far past a week of a whole family's visits. */
const PDF_MAX_ROWS = 60_000
const pdfFleet = z.string().trim().min(1).max(200)
const pdfText = z.string().max(400)
const pdfTime = z.number().int().nonnegative()

const dormantRowSchema = z.object({ name: pdfText, lastAt: pdfTime, location: pdfText.nullable().optional() })
/** The Dormant Assets Report as the page made it, for the server to draw. */
export const dormantPdfBodySchema = z.object({
  fleet: pdfFleet,
  now: pdfTime,
  total: z.number().int().nonnegative(),
  never: z.number().int().nonnegative().default(0),
  sections: z.object({
    yesterday: z.array(dormantRowSchema).max(PDF_MAX_ROWS),
    two: z.array(dormantRowSchema).max(PDF_MAX_ROWS),
    over: z.array(dormantRowSchema).max(PDF_MAX_ROWS),
  }),
})
export type DormantPdfBody = z.infer<typeof dormantPdfBodySchema>

/** The Geofence Report as the page made it. */
export const geofencePdfBodySchema = z.object({
  fleet: pdfFleet,
  from: pdfTime,
  to: pdfTime,
  /** How many geofences were picked; null: all of them. */
  places: z.number().int().nonnegative().nullable().default(null),
  failed: z.number().int().nonnegative().default(0),
  rows: z.array(z.object({
    vehicle: pdfText, vehicleId: z.string().max(100).nullable().optional(), place: pdfText,
    in: pdfTime, out: pdfTime, open: z.boolean().default(false),
  })).max(PDF_MAX_ROWS),
})
export type GeofencePdfBody = z.infer<typeof geofencePdfBodySchema>

const pdfLitres = z.number().nullable()
/** The TAT and Fuel Report as the page made it. */
export const tatFuelPdfBodySchema = z.object({
  fleet: pdfFleet,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be YYYY-MM-DD'),
  group: z.string().max(100).default('all'),
  rows: z.array(z.object({
    vehicleId: z.string().max(100).nullable().optional(),
    plate: pdfText,
    group: z.string().max(100),
    dispatchedAt: pdfTime.nullable(),
    leftAt: pdfTime.nullable(),
    returnedAt: pdfTime.nullable(),
    station: pdfText.nullable(),
    fuel: z.object({ initial: pdfLitres, topUps: pdfLitres, total: pdfLitres, consumption: pdfLitres, theft: pdfLitres, final: pdfLitres }).nullable(),
    km: z.number().nullable(),
    rate: z.number().nullable(),
    tankL: z.number().nullable(),
    comment: z.string().max(100),
    base: pdfText,
  })).max(PDF_MAX_ROWS),
})
export type TatFuelPdfBody = z.infer<typeof tatFuelPdfBodySchema>

/** The Speed Report as the page made it. */
export const speedPdfBodySchema = z.object({
  fleet: pdfFleet,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be YYYY-MM-DD'),
  group: z.string().max(100).default('all'),
  rows: z.array(z.object({
    vehicleId: z.string().max(100).nullable().optional(),
    name: pdfText,
    group: z.string().max(100),
    km: z.number(),
    maxKmh: z.number(),
    limitKmh: z.number(),
    overByKmh: z.number(),
    overKm: z.number(),
    occurrences: z.number().int().nonnegative(),
    peak: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).nullable().optional(),
  })).max(PDF_MAX_ROWS),
})
export type SpeedPdfBody = z.infer<typeof speedPdfBodySchema>

/** The longest period an end-of-shift report may cover: it reads the feeds and the weighbridge day by day. */
export const END_OF_SHIFT_MAX_DAYS = 7

/**
 * The end-of-shift report's period, picked on the Reports page (operator,
 * 2026-11-02): epoch ms. Neither given: today from midnight up to now, as
 * before. Both: from before to, no later than now, at most a week.
 */
function checkShiftPeriod(q: { from?: number; to?: number }, ctx: z.RefinementCtx) {
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
}
export const endOfShiftQuerySchema = z.object({
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
}).superRefine(checkShiftPeriod)
export type EndOfShiftQuery = z.infer<typeof endOfShiftQuerySchema>

/**
 * The same report for one category of the fleet (Menengai's fleet list:
 * Tankers, Finished Goods, …; operator, 2026-11-02): the category's units as
 * the Reports page matched them, and its name for the heading. Sent in a body,
 * as a category of a hundred units is too long for a query string.
 */
export const endOfShiftBodySchema = z.object({
  from: z.number().int().positive().optional(),
  to: z.number().int().positive().optional(),
  vehicleIds: z.array(z.string().max(80)).max(5000).optional(),
  category: z.string().trim().min(1).max(80).optional(),
}).superRefine(checkShiftPeriod)
export type EndOfShiftBody = z.infer<typeof endOfShiftBodySchema>

/**
 * The end-of-shift report as edited on the Reports page (operator,
 * 2026-11-02), sent back to be drawn as the PDF: the document the server
 * answered (end-of-shift.pdf endOfShiftDoc), every text in it as the operator
 * left it. Bounded so a request cannot ask for an unbounded document. The
 * report number and the footer's "made" time are set again by the server.
 */
const docText = z.string().max(600)
const docTone = z.enum(['flag', 'mut']).optional()
const docCell = z.object({
  text: docText, bold: z.boolean().optional(), tone: docTone,
  link: z.string().url().regex(/^https:\/\//).max(300).optional(),
  fill: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
})
const docTable = z.object({
  kind: z.literal('table'),
  cols: z.array(z.object({ w: z.number().min(0).max(300), align: z.enum(['left', 'right', 'center']).optional(), wrap: z.boolean().optional() })).min(1).max(40),
  head: z.array(z.string().max(80)).max(40),
  rows: z.array(z.array(docCell).max(40)).max(5000),
  size: z.number().min(6).max(10).optional(),
})
const docNone = z.object({ kind: z.literal('none'), text: docText })
const docBlock = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('h2'), title: z.string().max(160), aside: z.string().max(160).optional() }),
  z.object({ kind: z.literal('h3'), title: z.string().max(160), aside: z.string().max(160).optional() }),
  z.object({ kind: z.literal('bar'), title: z.string().max(160), aside: z.string().max(160).optional() }),
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
  docName: z.string().max(200).optional(),
  pairs: z.boolean().optional(),
})
export type ShiftDocBody = z.infer<typeof shiftDocSchema>

/** Any other report as edited on its page (new-ui lib/reportDocs): what the sheet held, and what to call the file. */
export const reportDocSchema = shiftDocSchema.extend({ filename: z.string().trim().min(1).max(200) })
export type ReportDocBody = z.infer<typeof reportDocSchema>

/**
 * The movement report as edited on the Reports page, sent back to be drawn as
 * the PDF: the rows the operator kept, with their locations and directions,
 * and how many rows they changed or left out (printed on the PDF). Bounded so
 * a request cannot ask for an unbounded document.
 *
 * The window is one the server answers: it ends no later than now and within
 * the last month, lasts a day at most, and is exactly the hours it says. The
 * report number, date and "Generated" on the PDF come from it.
 */
export const EDITED_REPORT_MAX_AGE_MS = MOVEMENT_MAX_AGE_DAYS * 24 * 3_600_000
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
  hours: z.number().positive().max(MOVEMENT_MAX_WINDOW_H),
  from: z.number(),
  to: z.number(),
  morl: z.string().max(120).nullable(),
  /** The site the directions read against ("MORL", "Sukari"); MORL when an older page leaves it out. */
  site: z.string().max(60).optional(),
  groups: z.array(z.object({ name: z.string().max(160), rows: z.array(movementRowSchema).max(5000) })).max(200),
  edits: z.object({ changed: z.number().int().min(0).max(100_000), removed: z.number().int().min(0).max(100_000) }),
}).superRefine((r, ctx) => {
  movementWindowIssues(r.from, r.to, ctx)
  if (Math.abs(r.to - r.from - r.hours * 3_600_000) > 1_000) {
    ctx.addIssue({ code: 'custom', path: ['from'], message: 'The window does not match the hours of the report' })
  }
})
export type EditedMovementReport = z.infer<typeof editedMovementReportSchema>

/**
 * One report a day over a range of days (a week at most), or, outside
 * Menengai, one a vehicle type a day: a week of up to 8 types. The rows are a
 * day's units either way, so the request stays under the 1 MB body limit.
 */
export const MOVEMENT_MAX_REPORTS = 7 * 8
export const editedMovementReportsSchema = z.object({
  reports: z.array(editedMovementReportSchema).min(1).max(MOVEMENT_MAX_REPORTS),
})
/** The PDF of one edited report, or of several (a window a day over a range of days). */
export const movementPdfBodySchema = z.union([editedMovementReportsSchema, editedMovementReportSchema])
export type MovementPdfBody = z.infer<typeof movementPdfBodySchema>
