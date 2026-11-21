/**
 * FactorySuite's Auto Workshop feeds our repair workflow (operator,
 * 2026-11-18: "feed our workflow"). See docs/factorysuite-workshop-integration.md.
 *
 *   job card checked in   → a repair job at in_workshop, ticketed. A unit the
 *                           Control Room already flagged (waiting for the
 *                           workshop) is that job ARRIVING, not a second job.
 *   repair started        → fixing
 *   awaiting parts        → spare_outsourced
 *   released              → fixed and closed. The Workshop is view-only in
 *                           every org (operator, 2026-11-21), so nobody here
 *                           verifies: FactorySuite's release is the sign-off
 *   cancelled             → void, for a job the card itself raised
 *   breakdown CONFIRMED   → a flag at awaiting_assessment, until a card opens
 *
 * Called from the reconcile loop and on the workshop webhook events. Every
 * pass re-reads the whole feed and writes only what changed. A job moves only
 * FORWARD, and only when its card's stage has changed since the card last
 * moved it (`appliedStage`), so a pass that reads the same card twice does
 * nothing the second time.
 *
 * A card already released on the first (silent) pass, the backlog, or released
 * more than a day before we first see it (an outage), is history: filed closed
 * like any release, and announces nothing.
 */

import { Prisma } from '../../../generated/prisma/client.js'
import { logger } from '../../lib/logger.js'
import { repairSignedOff } from '../fuel/fuel-followup.service.js'
import { prisma } from '../../lib/prisma.js'
import { emitDashboardRepairChanged } from '../../lib/sse.js'
import { MACHINE_FACTORY_TO_ORG } from '../../providers/raifactorysuite/raifactorysuite.machine-sync.js'
import type {
  RaiFactorySuiteBreakdownRow, RaiFactorySuiteJobCardRow, RaiFactorySuitePartRow, RaiFactorySuiteRequisitionRow,
} from '../../providers/raifactorysuite/raifactorysuite.client.js'
import {
  AWAITING_ARRIVAL, boardDays, breakdownColumns, cardStage, cardUnchanged, eatDayStart, categoryFor, jobCardColumns, partColumns,
  partUnchanged, stableJson, stageRank, suspectedFaultOf, type CardStage, type StoredCard,
} from '../../providers/raifactorysuite/raifactorysuite.workshop.js'
import { appendStage, type StageEvent } from './repairs.repository.js'
import { jobSelect, refOf, tell, type Job } from './repairs.workflow.js'
import { COMPLETED_PUSH } from './repairs.workflow.notify.js'
import type { Stage } from './repairs.schema.js'

type Tx = Prisma.TransactionClient
type Card = ReturnType<typeof jobCardColumns> & { id: string }

const BY = 'FactorySuite'
/** Released longer ago than this when first seen = history, filed closed. */
const HISTORY_AFTER_MS = 24 * 3_600_000

const short = (cardNumber: string) => cardNumber.replace(/^.*-JC-/, 'JC-')
/** A job FactorySuite runs is known by its card's number, not one of ours
 *  (operator, 2026-11-21): the ticket IS the card number, e.g. JC-2026-0308. */
const isCardTicket = (t: string | null | undefined) => !!t && t.startsWith('JC-')

interface Context {
  /** factoryCode → our organisation id */
  orgs: Map<string, string>
  /** orgId → (machine reference, folded) → vehicle id */
  vehicles: Map<string, Map<string, string>>
}

const fold = (ref: string) => ref.trim().toUpperCase().replace(/\s+/g, '')

async function context(): Promise<Context> {
  const orgs = new Map<string, string>()
  const vehicles = new Map<string, Map<string, string>>()
  for (const [factory, code] of Object.entries(MACHINE_FACTORY_TO_ORG)) {
    const org = await prisma.organisation.findUnique({ where: { code }, select: { id: true } })
    if (!org) continue
    orgs.set(factory, org.id)
    const rows = await prisma.vehicle.findMany({
      where: { organisationId: org.id, equipmentReference: { not: null } },
      select: { id: true, equipmentReference: true, isActive: true },
      orderBy: { isActive: 'desc' },
    })
    const byRef = new Map<string, string>()
    // Active first: a retired duplicate never takes the reference.
    for (const v of rows) if (!byRef.has(fold(v.equipmentReference!))) byRef.set(fold(v.equipmentReference!), v.id)
    vehicles.set(org.id, byRef)
  }
  return { orgs, vehicles }
}

function vehicleFor(ctx: Context, orgId: string, machine: string) {
  return ctx.vehicles.get(orgId)?.get(fold(machine)) ?? null
}

/** The timeline a card has already been through, as trail entries. */
function cardTimeline(card: Card, upTo: CardStage): StageEvent[] {
  const n = short(card.cardNumber)
  const steps: [Date | null, Stage, string][] = [
    [card.checkedInAt, 'in_workshop', `Checked into the workshop in FactorySuite (${n})`],
    [card.repairStartedAt, 'fixing', `Repair started (${n})${card.diagnosis ? `: ${card.diagnosis}` : ''}`],
    [card.partsRequestedAt, 'spare_outsourced', `Parts requested (${n})`],
    [card.partsReceivedAt, 'fixing', `Parts received (${n})`],
    [card.releasedAt, 'completed', `Released from the workshop (${n})`],
  ]
  const out: StageEvent[] = []
  for (const [at, stage, note] of steps) {
    if (!at || stageRank(stage) > stageRank(upTo === 'void' ? 'completed' : upTo)) continue
    if (stage === 'completed' && upTo !== 'completed') continue
    out.push({ stage, at: at.toISOString(), by: null, byName: BY, note })
  }
  out.sort((a, b) => a.at.localeCompare(b.at))
  if (out.length === 0 || out[out.length - 1]!.stage !== upTo) {
    out.push({ stage: upTo as Stage, at: new Date().toISOString(), by: null, byName: BY, note: `FactorySuite card ${n}: ${card.status}` })
  }
  return out
}

function completion(card: Card, at = card.releasedAt ?? card.workCompletedAt ?? new Date()) {
  return {
    completedAt: at, completedById: null, testResult: 'pass',
    fixNote: card.diagnosis ?? `Released from the workshop in FactorySuite (${short(card.cardNumber)})`,
  }
}

/** A released card closes its job: completed, verified by the release, resolved. */
function release(card: Card) {
  const at = card.releasedAt ?? card.workCompletedAt ?? new Date()
  return { ...completion(card, at), verifiedAt: at, verifyNote: 'Released in FactorySuite', resolvedAt: at }
}

export interface WorkshopSyncReport {
  cards: number
  created: number
  adopted: number
  history: number
  moved: number
  voided: number
  noVehicle: string[]
  breakdowns: number
  flagged: number
  requisitions: number
  parts: number
  /** Cards and parts read but identical to what is stored, so not rewritten. */
  unchanged: number
}

const empty = (): WorkshopSyncReport => ({
  cards: 0, created: 0, adopted: 0, history: 0, moved: 0, voided: 0, noVehicle: [],
  breakdowns: 0, flagged: 0, requisitions: 0, parts: 0, unchanged: 0,
})

// ── Job cards ───────────────────────────────────────────────────────────────

/**
 * An open job the card should be worked under, if there is one: a unit the
 * Control Room flagged and is waiting to reach the workshop (any category: the
 * card is that unit arriving), else an open job of the card's own category,
 * else the job another open card on this unit already runs under.
 */
async function adoptable(tx: Tx, orgId: string, vehicleId: string, category: string): Promise<Job | null> {
  const open = await tx.repairReportItem.findMany({
    where: { organisationId: orgId, vehicleId, resolvedAt: null, targetKind: 'unit' },
    select: { ...jobSelect, fsJobCards: { select: { status: true } }, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const waiting = open.find((j) => (AWAITING_ARRIVAL as readonly string[]).includes(j.stage) && j.fsJobCards.length === 0)
  if (waiting) return waiting
  return open.find((j) => j.faultCategory === category) ?? null
}

async function createJob(tx: Tx, card: Card, orgId: string, vehicleId: string, stage: CardStage, history: boolean) {
  const category = categoryFor(card.reportedFault, card.diagnosis)
  const suspected = suspectedFaultOf(card)
  const at = card.checkedInAt ?? new Date()
  const ticketNo = short(card.cardNumber)
  const closed = stage === 'completed'
  const voided = stage === 'void'
  const finalStage: Stage = closed ? 'fixed' : voided ? 'void' : stage
  const trail = cardTimeline(card, stage)
  if (closed) {
    trail.push({
      stage: 'fixed', at: (card.releasedAt ?? new Date()).toISOString(), by: null, byName: BY,
      note: history ? 'Released in FactorySuite before the platform saw the card: filed as history'
        : 'Released in FactorySuite: fixed and available',
    })
  }
  const report = await tx.repairReport.create({
    data: {
      organisationId: orgId, reportedById: null, source: 'factorysuite', reportedAt: at,
      note: `FactorySuite job card ${card.cardNumber}`, emailStatus: 'no-recipients',
      items: {
        create: [{
          organisationId: orgId, targetKind: 'unit', vehicleId, outcome: 'flagged',
          faultCategory: category, suspectedFault: suspected, problemNote: suspected,
          diagnosis: card.diagnosis,
          stage: finalStage, queue: 'workshop', path: 'physical', forwardedAt: at,
          ticketNo, ticketIssuedAt: at, stageChangedAt: new Date(trail[trail.length - 1]!.at),
          stageHistory: trail as unknown as Prisma.InputJsonValue,
          ...(closed ? release(card) : {}),
          ...(voided ? { voidReason: `FactorySuite card ${short(card.cardNumber)} cancelled`, resolvedAt: new Date() } : {}),
        }],
      },
    },
    select: { items: { select: jobSelect } },
  })
  return report.items[0]!
}

/** Move an open job forward to the card's stage, guarded on the stage it was read at. */
async function advance(tx: Tx, job: Job, card: Card, to: CardStage, adopting: boolean) {
  const n = short(card.cardNumber)
  const data: Prisma.RepairReportItemUncheckedUpdateManyInput = {}
  if (!job.diagnosis && card.diagnosis) data.diagnosis = card.diagnosis
  if (adopting || (AWAITING_ARRIVAL as readonly string[]).includes(job.stage)) {
    data.queue = 'workshop'
    data.path = 'physical'
    // The card's number replaces ours; a job another card already named keeps that card's.
    if (!isCardTicket(job.ticketNo)) {
      data.ticketNo = short(card.cardNumber)
      data.ticketIssuedAt = card.checkedInAt ?? new Date()
    }
    await tx.workshopBooking.updateMany({
      where: { repairItemId: job.id, status: 'booked' },
      data: { status: 'arrived', arrivedAt: card.checkedInAt ?? new Date() },
    })
  }

  if (to === 'void') {
    // Only a job the card raised dies with it. A job the Control Room flagged
    // goes on: the trail says the card was cancelled, and somebody decides.
    const raisedByCard = await tx.repairReport.count({ where: { items: { some: { id: job.id } }, source: 'factorysuite' } })
    const note = `FactorySuite card ${n} cancelled`
    if (raisedByCard) {
      const { count } = await tx.repairReportItem.updateMany({
        where: { id: job.id, resolvedAt: null, stage: job.stage },
        data: {
          ...data, stage: 'void', stageChangedAt: new Date(), voidReason: note, resolvedAt: new Date(),
          stageHistory: appendStage(job.stageHistory, { stage: 'void', at: new Date().toISOString(), by: null, byName: BY, note }),
        },
      })
      return count ? 'void' as const : null
    }
    await tx.repairReportItem.updateMany({
      where: { id: job.id, resolvedAt: null },
      data: { ...data, stageHistory: appendStage(job.stageHistory, { stage: job.stage as Stage, at: new Date().toISOString(), by: null, byName: BY, note }) },
    })
    return null
  }

  // Never backwards. A job the app already completed (or verified, which
  // closes it) is ahead of a card still in progress.
  if (stageRank(to) < stageRank(job.stage) || to === job.stage) {
    if (Object.keys(data).length) await tx.repairReportItem.updateMany({ where: { id: job.id, resolvedAt: null }, data })
    return null
  }
  const at = to === 'completed' ? (card.releasedAt ?? new Date())
    : to === 'fixing' ? (card.partsReceivedAt ?? card.repairStartedAt ?? new Date())
      : to === 'spare_outsourced' ? (card.partsRequestedAt ?? new Date())
        : (card.checkedInAt ?? new Date())
  const note = {
    in_workshop: `Checked into the workshop in FactorySuite (${n})`,
    fixing: card.partsReceivedAt && job.stage === 'spare_outsourced' ? `Parts received (${n})` : `Repair started (${n})`,
    spare_outsourced: `Waiting on parts in FactorySuite (${n})`,
    completed: `Released from the workshop in FactorySuite (${n})`,
  }[to]
  const event = { stage: to, at: at.toISOString(), by: null, byName: BY, note }
  // Released closes the job: no one in the app verifies (view-only Workshop).
  const { count } = await tx.repairReportItem.updateMany({
    where: { id: job.id, resolvedAt: null, stage: job.stage },
    data: to === 'completed'
      ? {
        ...data, ...release(card), stage: 'fixed', stageChangedAt: new Date(),
        stageHistory: appendStage(appendStage(job.stageHistory, event),
          { stage: 'fixed', at: at.toISOString(), by: null, byName: BY, note: 'Released in FactorySuite: fixed and available' }),
      }
      : {
        ...data, stage: to, stageChangedAt: new Date(),
        stageHistory: appendStage(job.stageHistory, event),
      },
  })
  return count ? to : null
}

interface Outcome { orgId: string; job: Job; event: 'created' | 'adopted' | 'moved' | 'history' | 'void'; to: string }

async function syncCard(
  row: RaiFactorySuiteJobCardRow, ctx: Context, now: Date, report: WorkshopSyncReport, backlog: boolean,
  stored: StoredCard | undefined,
): Promise<Outcome | 'unchanged' | null> {
  const orgId = ctx.orgs.get(row.factoryCode)
  if (!orgId || !row.id || !row.cardNumber || !row.machine) return null
  const vehicleId = vehicleFor(ctx, orgId, row.machine)
  const stage = cardStage(row)
  report.cards++
  if (!vehicleId) report.noVehicle.push(row.machine)
  const cols = jobCardColumns(row, orgId, vehicleId)
  if (cardUnchanged(stored, row, cols, stage)) return 'unchanged'
  const card: Card = { id: row.id, ...cols }

  return prisma.$transaction(async (tx) => {
    const prev = await tx.factorySuiteJobCard.findUnique({ where: { id: row.id }, select: { repairItemId: true, appliedStage: true } })
    await tx.factorySuiteJobCard.upsert({
      where: { id: row.id },
      create: { id: row.id, ...cols, raw: row as unknown as Prisma.InputJsonValue },
      update: { ...cols, raw: row as unknown as Prisma.InputJsonValue, syncedAt: now },
    })
    if (!vehicleId) return null
    if (prev?.repairItemId && prev.appliedStage === stage) return null

    let outcome: Outcome | null = null
    if (prev?.repairItemId) {
      const job = await tx.repairReportItem.findFirst({ where: { id: prev.repairItemId, resolvedAt: null }, select: jobSelect })
      const moved = job ? await advance(tx, job, card, stage, false) : null
      if (job && moved) outcome = { orgId, job, event: moved === 'void' ? 'void' : 'moved', to: moved }
    } else {
      // The first (silent) pass is the backlog: everything it finds released
      // was released without us, so it is history. Later, a card released
      // more than a day before we first see it (an outage) is history too.
      const history = stage === 'completed' && !!card.releasedAt && (backlog || now.getTime() - card.releasedAt.getTime() > HISTORY_AFTER_MS)
      const existing = history || stage === 'void' ? null : await adoptable(tx, orgId, vehicleId, categoryFor(card.reportedFault, card.diagnosis))
      if (existing) {
        await advance(tx, existing, card, stage, true)
        await tx.factorySuiteJobCard.update({ where: { id: row.id }, data: { repairItemId: existing.id } })
        outcome = { orgId, job: existing, event: 'adopted', to: stage }
      } else if (stage === 'void') {
        // A card cancelled before we ever saw it raised nothing.
      } else {
        const job = await createJob(tx, card, orgId, vehicleId, stage, history)
        await tx.factorySuiteJobCard.update({ where: { id: row.id }, data: { repairItemId: job.id } })
        outcome = { orgId, job, event: history ? 'history' : 'created', to: job.stage }
      }
    }
    await tx.factorySuiteJobCard.update({ where: { id: row.id }, data: { appliedStage: stage } })
    return outcome
  })
}

async function announce(o: Outcome, card: RaiFactorySuiteJobCardRow) {
  const n = short(card.cardNumber)
  const closed = o.to === 'completed' || o.to === 'fixed'
  const ref = refOf(o.job, closed ? 'fixed' : o.to)
  if (closed) {
    await tell(ref, {
      key: 'verified', severity: 'info', headline: 'Released from the workshop: unit available',
      text: `released in FactorySuite (${n}); the unit is fixed and available${card.diagnosis ? `: ${card.diagnosis}` : ''}`,
      lines: [
        { label: 'Job card', value: card.cardNumber },
        ...(card.reportedFault ? [{ label: 'Reported fault', value: card.reportedFault }] : []),
        ...(card.diagnosis ? [{ label: 'Diagnosis', value: card.diagnosis }] : []),
      ],
      audience: ['channel'], source: 'repair_verified', push: COMPLETED_PUSH,
    })
  } else if (o.event === 'adopted') {
    await tell(ref, {
      key: `arrived-${n}`, severity: 'info', headline: 'Flagged unit reached the workshop',
      text: `checked into the workshop in FactorySuite (${n})`,
      lines: [{ label: 'Job card', value: card.cardNumber }],
      audience: ['control_room'],
    })
  } else if (o.event === 'void') {
    await tell(ref, {
      key: 'void', severity: 'info', headline: 'Workshop job card cancelled',
      text: `FactorySuite card ${n} cancelled; the repair job is void`, audience: ['control_room'],
    })
  }
}

export async function syncJobCards(rows: RaiFactorySuiteJobCardRow[], opts: { silent: boolean; now?: Date }, report = empty()) {
  const now = opts.now ?? new Date()
  const ctx = await context()
  const touched = new Set<string>()
  // What is stored, read once, so an unchanged card costs no transaction.
  const ids = rows.map((r) => r.id).filter(Boolean)
  const stored = new Map(
    (await prisma.factorySuiteJobCard.findMany({
      // Every column, not just raw: the mapping is compared too (cardUnchanged).
      where: { id: { in: ids } },
    })).map(({ id, ...s }) => [id, s as StoredCard] as const),
  )
  const unchanged: string[] = []
  for (const row of rows) {
    try {
      const o = await syncCard(row, ctx, now, report, opts.silent, stored.get(row.id))
      if (o === 'unchanged') { unchanged.push(row.id); continue }
      // Written, so something on the card moved (a diagnosis, a parts time, a
      // status inside one stage): open Auto Workshop pages read it again even
      // when no job changed stage.
      const org = ctx.orgs.get(row.factoryCode)
      if (org) touched.add(org)
      if (!o) continue
      if (o.event === 'created') report.created++
      else if (o.event === 'adopted') report.adopted++
      else if (o.event === 'history') report.history++
      else if (o.event === 'void') report.voided++
      else report.moved++
      // A release closes the job, so the sign-off chain runs as on a verify:
      // Fuel Audit cases close and "Probe reported" lifts.
      if (o.event !== 'history' && (o.to === 'completed' || o.to === 'fixed')) await repairSignedOff(o.orgId, o.job.id)
      if (!opts.silent && o.event !== 'history') await announce(o, row)
    } catch (err) {
      logger.warn({ err, card: row.cardNumber }, 'FactorySuite workshop: could not sync a job card')
    }
  }
  // Read this pass, as the changed ones are: one statement for all of them.
  if (unchanged.length) await prisma.factorySuiteJobCard.updateMany({ where: { id: { in: unchanged } }, data: { syncedAt: now } })
  report.unchanged += unchanged.length
  for (const orgId of touched) emitDashboardRepairChanged(orgId)
  return report
}

// ── Breakdowns ──────────────────────────────────────────────────────────────

/**
 * A CONFIRMED breakdown is a unit down in the field that the workshop has
 * accepted. Until a card opens on it, it is a flag in our workflow, waiting
 * for the Control Room's assessment (roadworthy, tow or field inspection).
 * The card, when it opens, adopts that job. One already carded raises nothing.
 */
export async function syncBreakdowns(rows: RaiFactorySuiteBreakdownRow[], opts: { silent: boolean; now?: Date }, report = empty()) {
  const now = opts.now ?? new Date()
  const ctx = await context()
  const touched = new Set<string>()
  for (const row of rows) {
    const orgId = ctx.orgs.get(row.factoryCode)
    if (!orgId || !row.id || !row.machine) continue
    report.breakdowns++
    const vehicleId = vehicleFor(ctx, orgId, row.machine)
    const cols = breakdownColumns(row, orgId, vehicleId)
    try {
      const raised = await prisma.$transaction(async (tx) => {
        const prev = await tx.factorySuiteBreakdown.findUnique({ where: { id: row.id }, select: { repairItemId: true, raw: true } })
        if (!prev || stableJson(prev.raw) !== stableJson(row)) touched.add(orgId)
        await tx.factorySuiteBreakdown.upsert({
          where: { id: row.id },
          create: { id: row.id, ...cols, raw: row as unknown as Prisma.InputJsonValue },
          update: { ...cols, raw: row as unknown as Prisma.InputJsonValue, syncedAt: now },
        })
        if (prev?.repairItemId || !vehicleId || row.status.toUpperCase() !== 'CONFIRMED' || row.jobCardNumber) return null
        const category = categoryFor(cols.reportedFault)
        const open = await tx.repairReportItem.findFirst({
          where: { organisationId: orgId, vehicleId, resolvedAt: null, targetKind: 'unit', faultCategory: category },
          select: { id: true },
        })
        if (open) {
          await tx.factorySuiteBreakdown.update({ where: { id: row.id }, data: { repairItemId: open.id } })
          return null
        }
        const at = cols.decidedAt ?? cols.reportedAt ?? now
        const fault = cols.reportedFault ?? 'Breakdown reported in FactorySuite'
        const where = cols.location ? ` at ${cols.location}` : ''
        const r = await tx.repairReport.create({
          data: {
            organisationId: orgId, reportedById: null, source: 'factorysuite', reportedAt: cols.reportedAt ?? at,
            note: `FactorySuite breakdown${where}: ${fault}`, emailStatus: 'no-recipients',
            items: {
              create: [{
                organisationId: orgId, targetKind: 'unit', vehicleId, outcome: 'flagged',
                faultCategory: category, suspectedFault: `${fault}${where}`, problemNote: `${fault}${where}`,
                stage: 'awaiting_assessment', queue: 'workshop', path: 'physical', forwardedAt: at,
                stageChangedAt: at,
                stageHistory: [{
                  stage: 'awaiting_assessment', at: at.toISOString(), by: null, byName: BY,
                  note: `Breakdown confirmed in FactorySuite${where}: to the Control Room for assessment`,
                }] as unknown as Prisma.InputJsonValue,
              }],
            },
          },
          select: { items: { select: jobSelect } },
        })
        const job = r.items[0]!
        await tx.factorySuiteBreakdown.update({ where: { id: row.id }, data: { repairItemId: job.id } })
        return { job, orgId }
      })
      if (!raised) continue
      report.flagged++
      touched.add(raised.orgId)
      if (!opts.silent) {
        await tell(refOf(raised.job), {
          key: 'flagged', severity: 'warning', headline: 'Breakdown reported: assess it',
          text: `breakdown confirmed in FactorySuite: ${raised.job.vehicle.registrationPlate}`,
          lines: [
            { label: 'Fault', value: cols.reportedFault ?? '—' },
            ...(cols.location ? [{ label: 'Location', value: cols.location }] : []),
          ],
          audience: ['control_room'], source: 'repair_flag',
        })
      }
    } catch (err) {
      logger.warn({ err, breakdown: row.id }, 'FactorySuite workshop: could not sync a breakdown')
    }
  }
  for (const orgId of touched) emitDashboardRepairChanged(orgId)
  return report
}

// ── Requisitions and parts ──────────────────────────────────────────────────

/** Stored raw: no requisition had been raised when this was written. */
export async function syncRequisitions(rows: RaiFactorySuiteRequisitionRow[], report = empty()) {
  const ctx = await context()
  const touched = new Set<string>()
  const stored = new Map(
    (await prisma.factorySuiteRequisition.findMany({ where: { id: { in: rows.map((r) => r.id).filter(Boolean) } }, select: { id: true, raw: true } }))
      .map((r) => [r.id, stableJson(r.raw)] as const),
  )
  for (const row of rows) {
    const orgId = ctx.orgs.get(row.factoryCode)
    if (!orgId || !row.id) continue
    const cols = {
      organisationId: orgId, factoryCode: row.factoryCode,
      status: typeof row.status === 'string' ? row.status : null,
      jobCardNumber: typeof row.jobCardNumber === 'string' ? row.jobCardNumber : null,
      raw: row as unknown as Prisma.InputJsonValue,
    }
    await prisma.factorySuiteRequisition.upsert({
      where: { id: row.id }, create: { id: row.id, ...cols }, update: { ...cols, syncedAt: new Date() },
    })
    if (stored.get(row.id) !== stableJson(row)) touched.add(orgId)
    report.requisitions++
  }
  for (const orgId of touched) emitDashboardRepairChanged(orgId)
  if (rows.length && report.requisitions) {
    logger.info({ sample: rows[0] }, 'FactorySuite workshop: requisitions are live; map them onto spare parts')
  }
  return report
}

/**
 * The catalogue is replaced per factory: what FactorySuite served is what we
 * hold. A part it stopped serving is dropped, so a part cut off by its
 * 1000-row cap can come and go between passes.
 */
export async function syncParts(rows: RaiFactorySuitePartRow[], report = empty()) {
  const ctx = await context()
  const byOrg = new Map<string, RaiFactorySuitePartRow[]>()
  for (const row of rows) {
    const orgId = ctx.orgs.get(row.factoryCode)
    if (!orgId || !row.id || !row.partNumber) continue
    byOrg.set(orgId, [...(byOrg.get(orgId) ?? []), row])
  }
  for (const [orgId, parts] of byOrg) {
    const now = new Date()
    // Only parts whose stock, cost or wording moved are written; the stores
    // count rarely changes, so most hours this is a handful, not 1,000.
    const stored = new Map(
      (await prisma.factorySuitePart.findMany({
        where: { organisationId: orgId },
        select: {
          id: true, organisationId: true, factoryCode: true, partNumber: true, description: true, unit: true,
          quantityOnHand: true, minimumLevel: true, unitCost: true, supplier: true, active: true,
        },
      })).map(({ id, ...p }) => [id, p as Record<string, unknown>] as const),
    )
    const changed = parts.filter((row) => !partUnchanged(stored.get(row.id), partColumns(row, orgId)))
    let dropped = 0
    await prisma.$transaction(async (tx) => {
      for (const row of changed) {
        const cols = partColumns(row, orgId)
        await tx.factorySuitePart.upsert({ where: { id: row.id }, create: { id: row.id, ...cols }, update: { ...cols, syncedAt: now } })
      }
      await tx.factorySuitePart.updateMany({ where: { id: { in: parts.map((r) => r.id) } }, data: { syncedAt: now } })
      dropped = (await tx.factorySuitePart.deleteMany({ where: { organisationId: orgId, syncedAt: { lt: now } } })).count
    }, { timeout: 60_000 })
    // Stock moved, or a part came or went: open Stores tables read again.
    if (changed.length || dropped) emitDashboardRepairChanged(orgId)
    report.parts += parts.length
    report.unchanged += parts.length - changed.length
  }
  return report
}

// ── Reads for the app ───────────────────────────────────────────────────────

/** The stores part picker: search by number or description, stock first. */
export async function searchParts(orgId: string, q: string | undefined, opts: { lowOnly?: boolean; limit?: number } = {}) {
  const term = q?.trim()
  const rows = await prisma.factorySuitePart.findMany({
    where: {
      organisationId: orgId, active: true,
      ...(term ? { OR: [
        { partNumber: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
      ] } : {}),
    },
    orderBy: [{ quantityOnHand: { sort: 'desc', nulls: 'last' } }, { description: 'asc' }],
    // FactorySuite serves at most 1,000 parts: the Stores table may read them all.
    take: opts.lowOnly ? 2000 : Math.min(opts.limit ?? 50, 1000),
  })
  const out = rows.map((p) => ({
    id: p.id, partNumber: p.partNumber, description: p.description, unit: p.unit,
    quantityOnHand: p.quantityOnHand, minimumLevel: p.minimumLevel, unitCost: p.unitCost, supplier: p.supplier,
    inStock: (p.quantityOnHand ?? 0) > 0,
    belowMinimum: p.minimumLevel != null && (p.quantityOnHand ?? 0) < p.minimumLevel,
    syncedAt: p.syncedAt,
  }))
  return opts.lowOnly ? out.filter((p) => p.belowMinimum).slice(0, opts.limit ?? 200) : out
}

/** One unit's FactorySuite job cards, newest first: its workshop history. */
export async function vehicleJobCards(orgId: string, vehicleId: string, limit = 50) {
  return prisma.factorySuiteJobCard.findMany({
    where: { organisationId: orgId, vehicleId },
    orderBy: { checkedInAt: { sort: 'desc', nulls: 'last' } },
    take: limit,
    omit: { raw: true },
  })
}

/** The workshop board: every open card, and a summary of the period. */
export async function workshopBoard(orgId: string, days = 7) {
  // Whole East Africa days, today included, so the first bar of the chart is not a part day.
  const since = eatDayStart(new Date(), days - 1)
  const [open, recent, first] = await Promise.all([
    prisma.factorySuiteJobCard.findMany({
      where: { organisationId: orgId, status: { notIn: ['RELEASED', 'CANCELLED'] } },
      orderBy: { checkedInAt: 'asc' },
      omit: { raw: true },
      include: { vehicle: { select: { id: true, registrationPlate: true, name: true } }, repairItem: { select: { id: true, stage: true, ticketNo: true } } },
    }),
    // Checked in OR released in the window: a card in for a fortnight still counts on the day it leaves.
    prisma.factorySuiteJobCard.findMany({
      where: { organisationId: orgId, OR: [{ checkedInAt: { gte: since } }, { releasedAt: { gte: since } }] },
      select: { status: true, checkedInAt: true, releasedAt: true, fuelDiscrepancy: true, category: true, priority: true, isService: true },
    }),
    // The feed's first card: days before it are days FactorySuite had not started, not quiet days.
    prisma.factorySuiteJobCard.aggregate({ where: { organisationId: orgId }, _min: { checkedInAt: true } }),
  ])
  const inWindow = (d: Date | null) => !!d && d >= since
  const opened = recent.filter((c) => inWindow(c.checkedInAt))
  const released = recent.filter((c) => inWindow(c.releasedAt))
  const hours = released.filter((c) => c.checkedInAt)
    .map((c) => (c.releasedAt!.getTime() - c.checkedInAt!.getTime()) / 3_600_000).sort((a, b) => a - b)
  return {
    open,
    summary: {
      days, cards: opened.length, released: released.length,
      fuelDiscrepancies: opened.filter((c) => c.fuelDiscrepancy).length,
      major: opened.filter((c) => c.category === 'MAJOR').length,
      urgent: opened.filter((c) => c.priority === 'Urgent').length,
      services: opened.filter((c) => c.isService).length,
      medianHoursInWorkshop: hours.length ? Math.round(hours[Math.floor(hours.length / 2)]! * 10) / 10 : null,
      firstCardAt: first._min.checkedInAt,
      byDay: boardDays(days, opened.map((c) => c.checkedInAt!), released.map((c) => c.releasedAt!), new Date(), first._min.checkedInAt),
    },
  }
}
