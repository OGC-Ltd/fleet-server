/**
 * The CPU-bound tasks the pool (./cpu-pool.ts) runs on its worker threads.
 * Each is pure: input in, bytes out. Modules are loaded on first use, so a
 * thread holds only pdfkit and the drawing code, never Prisma or Express.
 *
 * Posted reports (`pdf.posted`) arrive as the request's raw JSON bytes: the
 * parse and the schema check of an 8 MB body (~110 ms) happen here too, off
 * the event loop. A body that fails the schema comes back as TaskError 400
 * carrying zod's issues, and the API answers it exactly as validateBody does.
 */

import type { ZodIssue } from 'zod'

/** A task's failure as the caller sees it: an HTTP status, and zod's issues for a 400. */
export class TaskError extends Error {
  readonly status: number
  readonly issues?: ZodIssue[]
  constructor(message: string, status = 500, issues?: ZodIssue[]) {
    super(message)
    this.name = 'TaskError'
    this.status = status
    this.issues = issues
  }

  static from(e: { name: string; message: string; status?: number; issues?: unknown }): Error {
    if (e.name === 'TaskError') return new TaskError(e.message, e.status ?? 500, e.issues as ZodIssue[] | undefined)
    const err = new Error(e.message)
    err.name = e.name
    return err
  }
}

/** The reports the page makes and posts for the server to draw. */
export const POSTED_REPORTS = ['dormant-assets', 'geofences', 'tat-fuel', 'speed', 'deliveries', 'document'] as const
export type PostedReport = typeof POSTED_REPORTS[number]

export interface PdfOut {
  /** The file's bytes; moved, not copied, back to the API. */
  pdf: Uint8Array
  name: string
}

interface Tasks {
  /** A report the page made, drawn from its posted rows. */
  'pdf.posted': { in: { report: PostedReport; body: Uint8Array; orgCode: string; landscape: boolean | null }; out: PdfOut }
  /** An end-of-shift style document (an edited sheet, or a report's own document). */
  'pdf.shiftDoc': { in: { doc: import('../../modules/reports/end-of-shift.pdf.js').ShiftDoc; landscape: boolean }; out: Uint8Array }
  /** The end-of-shift report, as its own PDF. */
  'pdf.endOfShift': { in: { report: import('../../modules/reports/end-of-shift.js').EndOfShift; orgName: string; reportNo: string; generatedAt: number }; out: Uint8Array }
  /** One movement report or several, as one PDF. */
  'pdf.movements': { in: { reports: import('../../modules/reports/movement-report.service.js').MovementReport[]; landscape: boolean }; out: Uint8Array }
  /** A branded report (/reports/pdf/:kind) from its collected data. */
  'pdf.branded': { in: { data: import('../../modules/reports/report-pdf.renderer.js').ReportData }; out: Uint8Array }
  /** Test only: holds the thread for `ms`, or throws. */
  'test.spin': { in: { ms: number; fail?: string; bytes?: number }; out: Uint8Array }
}
export type TaskKind = keyof Tasks
export type TaskInput<K extends TaskKind> = Tasks[K]['in']
export type TaskOutput<K extends TaskKind> = Tasks[K]['out']

/** A Buffer as a Uint8Array that owns its memory, so it can be transferred. */
function owned(b: Buffer): Uint8Array {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? new Uint8Array(b.buffer, 0, b.byteLength) : new Uint8Array(b)
}

async function posted(i: TaskInput<'pdf.posted'>): Promise<PdfOut> {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(i.body))
  } catch {
    throw new TaskError('The request body is not valid JSON', 400)
  }
  const schema = await import('../../modules/reports/report.schema.js')
  const draw = await import('../../modules/reports/template-report.pdf.js')
  const check = <T>(s: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: ZodIssue[] } } }): T => {
    const r = s.safeParse(json)
    if (!r.success) throw new TaskError('Validation failed', 400, r.error.issues)
    return r.data
  }
  const o = { orgCode: i.orgCode }
  switch (i.report) {
    case 'dormant-assets': {
      const b = check(schema.dormantPdfBodySchema)
      return { pdf: owned(await draw.renderDormantPdf(b, { ...o, landscape: i.landscape ?? false })), name: draw.dormantFileName(b) }
    }
    case 'geofences': {
      const b = check(schema.geofencePdfBodySchema)
      return { pdf: owned(await draw.renderGeofencePdf(b, { ...o, landscape: i.landscape ?? false })), name: draw.geofenceFileName(b) }
    }
    case 'tat-fuel': {
      const b = check(schema.tatFuelPdfBodySchema)
      // Landscape unless upright is asked for: its 14 columns were made for a wide page
      return { pdf: owned(await draw.renderTatFuelPdf(b, { ...o, landscape: i.landscape ?? true })), name: draw.tatFileName(b) }
    }
    case 'speed': {
      const b = check(schema.speedPdfBodySchema)
      return { pdf: owned(await draw.renderSpeedPdf(b, { ...o, landscape: i.landscape ?? false })), name: draw.speedFileName(b) }
    }
    case 'deliveries': {
      const b = check(schema.deliveriesPdfBodySchema)
      return { pdf: owned(await draw.renderDeliveriesPdf(b, { ...o, landscape: i.landscape ?? false })), name: draw.deliveriesFileName(b) }
    }
    case 'document': {
      const { filename, ...doc } = check(schema.reportDocSchema)
      const { renderShiftDoc } = await import('../../modules/reports/end-of-shift.pdf.js')
      return { pdf: owned(await renderShiftDoc(doc, { landscape: i.landscape ?? false })), name: `${filename}.pdf` }
    }
  }
}

/** Runs one task on the calling thread: the worker's body, and the pool's inline mode. */
export async function runTask<K extends TaskKind>(kind: K, input: TaskInput<K>): Promise<TaskOutput<K>> {
  const i = input as never
  switch (kind) {
    case 'pdf.posted':
      return posted(i) as Promise<TaskOutput<K>>
    case 'pdf.shiftDoc': {
      const { renderShiftDoc } = await import('../../modules/reports/end-of-shift.pdf.js')
      const x = i as TaskInput<'pdf.shiftDoc'>
      return owned(await renderShiftDoc(x.doc, { landscape: x.landscape })) as TaskOutput<K>
    }
    case 'pdf.endOfShift': {
      const { renderEndOfShiftPdf } = await import('../../modules/reports/end-of-shift.pdf.js')
      const x = i as TaskInput<'pdf.endOfShift'>
      return owned(await renderEndOfShiftPdf(x.report, x)) as TaskOutput<K>
    }
    case 'pdf.movements': {
      const { renderMovementReportsPdf } = await import('../../modules/reports/movement-report.pdf.js')
      const x = i as TaskInput<'pdf.movements'>
      return owned(await renderMovementReportsPdf(x.reports, { landscape: x.landscape })) as TaskOutput<K>
    }
    case 'pdf.branded': {
      const { renderReportPdf } = await import('../../modules/reports/report-pdf.renderer.js')
      return owned(await renderReportPdf((i as TaskInput<'pdf.branded'>).data)) as TaskOutput<K>
    }
    case 'test.spin': {
      const x = i as TaskInput<'test.spin'>
      if (x.fail) throw new TaskError(x.fail, 422)
      const until = Date.now() + x.ms
      while (Date.now() < until) { /* hold the thread, as a long drawing does */ }
      if (x.bytes) {
        // Grows the heap until the thread's cap kills it
        const hold: number[][] = []
        for (;;) hold.push(new Array(1e6).fill(hold.length))
      }
      return new Uint8Array([1, 2, 3]) as TaskOutput<K>
    }
  }
  throw new TaskError(`Unknown task ${String(kind)}`, 500)
}
