import { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../core/errors/errors.js'
import { STAGE_FOR_OUTCOME } from './repairs.schema.js'
import { withEffectiveStage, withEffectiveStages, stageFilter } from './effective-stage.js'
import type {
  CreateRepairReport, ResolveItem, SetStage, ListReportsQuery, ListItemsQuery, Stage,
} from './repairs.schema.js'

/**
 * One line of the tracking line.
 *
 * `byName` is COPIED, not joined. The history is read on a detail panel that
 * already has one query's budget, and a name resolved at write time still
 * reads correctly after the technician leaves the company and their user row
 * is anonymised — which is the whole reason to keep a trail at all.
 */
export type StageEvent = {
  stage:   Stage
  at:      string
  by:      string | null
  byName?: string
  note?:   string
}

export type AssignmentEvent = {
  kind: 'assignment'
  assignedToId: string | null
  assignedToName?: string
  by: string | null
  byName?: string
  at: string
  note?: string
}

export type AssignmentRevokedEvent = {
  kind: 'assignment_revoked'
  assignedToId: string
  by: string
  byName?: string
  at: string
}

export type AssignmentResponseEvent = {
  kind: 'assignment_response'
  status: 'accepted' | 'declined'
  by: string
  byName?: string
  at: string
}

/**
 * Append to the history, defensively.
 *
 * The column is JSONB and therefore `Prisma.JsonValue` — it can legally hold
 * anything, including whatever a future backfill script decides to put there.
 * Anything that is not an array is replaced rather than spread, because
 * spreading a string would produce an array of characters and the tracking
 * line would render one node per letter.
 */
export function appendStage<T extends StageEvent | AssignmentEvent | AssignmentRevokedEvent | AssignmentResponseEvent>(history: unknown, event: T): T[] {
  const prior = Array.isArray(history) ? (history as T[]) : []
  // 200 moves is a job somebody is fighting with a button, not a repair. The
  // cap bounds the column rather than expressing a belief about repairs.
  return [...prior, event].slice(-200)
}

/**
 * What every read of an item carries with it.
 *
 * The plate, always. An item names its unit by id, and an id is not something
 * anybody can act on — every screen and every line of the email needs the
 * registration instead.
 */
const itemInclude = {
  vehicle: { select: { id: true, registrationPlate: true, name: true } },
  assignedTo: { select: { id: true, fullName: true } },
  assignedBy: { select: { id: true, fullName: true } },
} as const

const reportInclude = {
  items:      { include: itemInclude, orderBy: { createdAt: 'asc' as const } },
  reportedBy: { select: { id: true, fullName: true, email: true } },
} as const

/**
 * Prove every target in the payload belongs to this organisation.
 *
 * This is the tenant boundary for the write path, and it is a separate check
 * from the one the middleware makes. `requireOrgAccess` proves the CALLER
 * belongs to the org; this proves the PAYLOAD does. Without it a technician
 * could file a report against another tenant's plate by editing one id in the
 * request body, and the row would be stamped with their org while pointing at
 * a vehicle in somebody else's.
 */
export async function assertTargetsInOrg(orgId: string, items: CreateRepairReport['items']): Promise<void> {
  const vehicleIds = [...new Set(items.map((i) => i.vehicleId))]
  const found = await prisma.vehicle.findMany({
    where: { id: { in: vehicleIds }, organisationId: orgId },
    select: { id: true },
  })
  const ok = new Set(found.map((v) => v.id))
  const strayVehicle = vehicleIds.find((id) => !ok.has(id))
  if (strayVehicle) throw new NotFoundError(`Vehicle ${strayVehicle} is not in this organisation`)

  const episodeIds = [...new Set(items.map((i) => i.faultEpisodeId).filter((x): x is string => !!x))]
  if (episodeIds.length === 0) return
  const episodes = await prisma.sensorFaultEpisode.findMany({
    where: { id: { in: episodeIds }, organisationId: orgId },
    select: { id: true },
  })
  const okEp = new Set(episodes.map((e) => e.id))
  const strayEpisode = episodeIds.find((id) => !okEp.has(id))
  if (strayEpisode) throw new NotFoundError(`Fault episode ${strayEpisode} is not in this organisation`)
}

export async function createReport(orgId: string, userId: string, dto: CreateRepairReport) {
  /*
   * One timestamp for the whole report, not one per item.
   *
   * `new Date()` inside the map would give the items of a single trip
   * microsecond-different first history entries, and the tracking lines of two
   * units reported together would disagree about when the trip happened.
   */
  const filedAt = new Date()

  /*
   * A part named when the job is filed ("needs a spare: Capacitive fuel
   * probe") is an ORDER, and is recorded as one (operator, 2026-10-01): a
   * RepairSparePart row, status ordered, so the job's Spare parts column
   * shows it and it is collected and fitted like any part ordered later. It
   * used to live only in the sparePart text, and the column read "No spare
   * parts ordered" on a job waiting on one.
   */
  const ordersPart = dto.items.some((i) => i.outcome === 'needs_spare' && i.sparePart)
  const reporter = ordersPart
    ? await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } })
    : null

  return prisma.repairReport.create({
    data: {
      organisationId: orgId,
      reportedById:   userId,
      ...(dto.note ? { note: dto.note } : {}),
      items: {
        // organisationId is stamped on every item as well as the report. It is
        // denormalised deliberately: the open-jobs query runs on every load of
        // the Probes tab and should not join to find out whose it is.
        create: dto.items.map((i) => ({
          organisationId: orgId,
          targetKind:     i.targetKind,
          vehicleId:      i.vehicleId,
          outcome:        i.outcome,
          // The ladder starts where the outcome puts it — see
          // STAGE_FOR_OUTCOME for why "needs a spare" is not yet "outsourced".
          stage:          STAGE_FOR_OUTCOME[i.outcome],
          stageChangedAt: filedAt,
          stageHistory:   [{
            stage: STAGE_FOR_OUTCOME[i.outcome], at: filedAt.toISOString(), by: userId,
          }] satisfies StageEvent[],
          ...(i.faultEpisodeId ? { faultEpisodeId: i.faultEpisodeId } : {}),
          ...(i.faultKind      ? { faultKind:      i.faultKind }      : {}),
          ...(i.sparePart      ? { sparePart:      i.sparePart }      : {}),
          ...(i.problemNote    ? { problemNote:    i.problemNote }    : {}),
          // Already a midnight-UTC Date by the time it gets here — zod's
          // `calendarDay` did the parsing, so nothing below this line has to
          // know that the wire format was a string.
          ...(i.expectedResolutionAt ? { expectedResolutionAt: i.expectedResolutionAt } : {}),
          ...(i.outcome === 'needs_spare' && i.sparePart ? {
            spareParts: {
              create: [{
                organisationId: orgId,
                name:           i.sparePart,
                // The job's estimate is the only promised day the form asks for.
                ...(i.expectedResolutionAt ? { expectedAt: i.expectedResolutionAt } : {}),
                note:           'Filed as: Needs a spare part',
                orderedById:    userId,
                orderedBy:      reporter?.fullName ?? null,
                orderedAt:      filedAt,
              }],
            },
          } : {}),
        })),
      },
    },
    include: reportInclude,
  })
}

/**
 * Record what became of the mail.
 *
 * Its own call rather than part of the create, because the send happens after
 * the transaction commits — see the ordering note in the service.
 */
export async function setEmailOutcome(
  reportId: string,
  status: string,
  detail: { recipients: string[]; sent: string[]; failed: string[] },
) {
  return prisma.repairReport.update({
    where: { id: reportId },
    data: {
      emailStatus: status,
      emailDetail: detail,
      ...(status === 'sent' || status === 'partial' ? { emailSentAt: new Date() } : {}),
    },
  })
}

/** A report's own items, read the way every other surface reads them. Without
 *  this a report opened from the list would draw a tracking line one rung
 *  behind the same job on the Repairs tab. */
const reportWithEffectiveStages = <T extends { items: Parameters<typeof withEffectiveStage>[0][] }>(r: T): T =>
  ({ ...r, items: withEffectiveStages(r.items) })

export async function findReports(orgId: string, q: ListReportsQuery) {
  const rows = await prisma.repairReport.findMany({
    where: { organisationId: orgId, ...(q.cursor ? { id: { lt: q.cursor } } : {}) },
    include: reportInclude,
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  })
  const hasNextPage = rows.length > q.limit
  if (hasNextPage) rows.pop()
  return {
    data: rows.map(reportWithEffectiveStages),
    cursor: hasNextPage ? (rows.at(-1)?.id ?? null) : null,
    hasNextPage,
  }
}

export async function findReportById(reportId: string, orgId: string) {
  const row = await prisma.repairReport.findFirst({
    where: { id: reportId, organisationId: orgId },
    include: reportInclude,
  })
  return row && reportWithEffectiveStages(row)
}

export async function assignItem(itemId: string, orgId: string, assignedById: string, dto: { technicianId?: string | null; reason?: string }): Promise<{ item: any | null; reason: 'ok' | 'closed' | 'invalid_assignee' }> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.repairReportItem.findFirst({
      where: { id: itemId, organisationId: orgId, resolvedAt: null },
      select: { id: true, assignedToId: true, stageHistory: true, assignedAt: true, assignedById: true },
    })
    if (!current) return { item: null, reason: 'closed' }

    const technicianId = dto.technicianId ?? null
    if (technicianId) {
      /*
       * REACHABLE, not employed here. This asked `{ id, organisationId }` — the
       * home-organisation COLUMN alone — while the picker in front of it is
       * built from listOrgUsers, which uses HOME ORGANISATION OR A LIVE
       * MEMBERSHIP. Anybody working across sites therefore appeared in the
       * dropdown, was accepted by the authorization check, and was then
       * rejected here. See users/user.repository.findReachable, which is the
       * canonical form of this predicate and carries the full reasoning; it is
       * inlined rather than called because this runs inside a transaction.
       */
      const tech = await tx.user.findFirst({
        where: {
          id: technicianId,
          deletedAt: null,
          OR: [
            { organisationId: orgId },
            { memberships: { some: { organisationId: orgId, revokedAt: null } } },
          ],
        },
        select: { id: true },
      })
      if (!tech) return { item: null, reason: 'invalid_assignee' }
    }

    const now = new Date()
    const { count } = await tx.repairReportItem.updateMany({
      where: { id: itemId, organisationId: orgId, resolvedAt: null },
      data: {
        assignedToId: technicianId,
        assignedById: assignedById,
        assignedAt: now,
          assignmentNote: dto.reason ?? null,
          assignmentStatus: technicianId ? 'pending' : 'accepted',
          stageHistory: appendStage(
            current.assignedToId && current.assignedToId !== technicianId
              ? appendStage(current.stageHistory, {
                kind: 'assignment_revoked', assignedToId: current.assignedToId,
                by: assignedById, at: now.toISOString(),
                ...(await byName(tx, assignedById)),
              } satisfies AssignmentRevokedEvent)
              : current.stageHistory,
            {
          kind: 'assignment',
          assignedToId: technicianId,
          by: assignedById,
          at: now.toISOString(),
          ...(dto.reason ? { note: dto.reason } : {}),
            } satisfies AssignmentEvent,
          ),
      },
    })

    if (count === 0) return { item: null, reason: 'closed' }

    const item = await tx.repairReportItem.findFirst({
      where: { id: itemId, organisationId: orgId },
      include: itemInclude,
    })
    return { item: item && withEffectiveStage(item), reason: 'ok' }
  })
}

export async function respondToAssignment(
  itemId: string,
  orgId: string,
  userId: string,
  status: 'accepted' | 'declined',
): Promise<{ item: any | null; reason: 'ok' | 'not_assignee' | 'closed' }> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.repairReportItem.findFirst({
      where: { id: itemId, organisationId: orgId, resolvedAt: null },
      select: { id: true, assignedToId: true, stageHistory: true },
    })
    if (!current) return { item: null, reason: 'closed' as const }
    if (current.assignedToId !== userId) return { item: null, reason: 'not_assignee' as const }

    const at = new Date()
    const { count } = await tx.repairReportItem.updateMany({
      where: { id: itemId, organisationId: orgId, resolvedAt: null, assignedToId: userId },
      data: {
        assignmentStatus: status,
        stageHistory: appendStage(current.stageHistory, {
          kind: 'assignment_response', status, by: userId, at: at.toISOString(),
          ...(await byName(tx, userId)),
        } satisfies AssignmentResponseEvent),
      },
    })
    if (count === 0) return { item: null, reason: 'closed' as const }

    const item = await tx.repairReportItem.findFirst({
      where: { id: itemId, organisationId: orgId },
      include: itemInclude,
    })
    return { item: item && withEffectiveStage(item), reason: 'ok' as const }
  })
}

export async function findItems(orgId: string, q: ListItemsQuery, vehicleScope: Set<string> | null = null) {
  const rows = await prisma.repairReportItem.findMany({
    where: {
      organisationId: orgId,
      ...(vehicleScope ? { vehicleId: { in: [...vehicleScope] } } : {}),
      ...(q.queue ? { queue: q.queue } : {}),
      ...(q.status === 'open'       ? { resolvedAt: null }                              : {}),
      // Signed off, split by WHICH end it reached. See the note on `status` in
      // repairs.schema: a failed job filed under "Resolved" is a job nobody
      // finds again.
      ...(q.status === 'resolved'   ? { resolvedAt: { not: null }, stage: 'fixed'  }     : {}),
      ...(q.status === 'unresolved' ? { resolvedAt: { not: null }, stage: 'failed' }     : {}),
      // Translated rather than matched literally — a job whose fix date has
      // passed reads as 'fixing' everywhere, so the filter has to agree.
      ...(q.stage ? stageFilter(q.stage) : {}),
      ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}),
      ...(q.cursor ? { id: { lt: q.cursor } } : {}),
    },
    include: {
      ...itemInclude,
      report: { select: { id: true, reportedAt: true, reportedBy: { select: { fullName: true } } } },
      resolvedBy: { select: { id: true, fullName: true } },
      workshopTechnician: { select: { id: true, fullName: true } },
      // The live workshop day, for the Repairs list's Workshop day column.
      bookings: {
        where: { status: { in: ['booked', 'arrived'] } },
        select: { id: true, bookingDate: true, status: true, workshop: { select: { name: true } } },
        take: 1,
      },
    },
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  })
  const hasNextPage = rows.length > q.limit
  if (hasNextPage) rows.pop()
  return {
    data: withEffectiveStages(rows),
    cursor: hasNextPage ? (rows.at(-1)?.id ?? null) : null,
    hasNextPage,
  }
}

/**
 * Close one item, once.
 *
 * `updateMany` with `resolvedAt: null` in the WHERE rather than a plain
 * `update`, so a second attempt matches nothing and returns 0 instead of
 * overwriting the first technician's notes with the second's. The caller turns
 * that 0 into a 409; a silent overwrite would lose the account of the fix that
 * actually happened.
 */
/**
 * Close one item, once, and land it on a terminal stage.
 *
 * `updateMany` with `resolvedAt: null` in the WHERE rather than a plain
 * `update`, so a second attempt matches nothing and returns 0 instead of
 * overwriting the first technician's notes with the second's. The caller turns
 * that 0 into a 409; a silent overwrite would lose the account of the fix that
 * actually happened.
 *
 * A transaction now, because the stage history has to be read before it can be
 * appended to. The guard in the WHERE is still what does the concurrency work
 * — the read only exists to build the new array.
 */
export async function resolveItem(itemId: string, orgId: string, userId: string, dto: ResolveItem) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.repairReportItem.findFirst({
      where:  { id: itemId, organisationId: orgId, resolvedAt: null },
      select: { id: true, stageHistory: true },
    })
    if (!current) return null

    const at = new Date()
    const { count } = await tx.repairReportItem.updateMany({
      where: { id: itemId, organisationId: orgId, resolvedAt: null },
      data: {
        resolvedAt:   at,
        resolvedById: userId,
        fixNote:      dto.fixNote,
        /*
         * The sign-off is the ONLY way to reach 'fixed' — see STAGES, and the
         * CHECK that holds the same rule where the API cannot be bypassed. A
         * failed sign-off lands on 'failed' and closes the job just the same:
         * the unit is off the list, and the ladder says why.
         */
        stage:          dto.verdict,
        stageChangedAt: at,
        stageHistory:   appendStage(current.stageHistory, {
          stage: dto.verdict,
          at:    at.toISOString(),
          by:    userId,
          ...(await byName(tx, userId)),
          note:  dto.fixNote,
        }),
        ...(dto.recommendation ? { recommendation: dto.recommendation } : {}),
      },
    })
    if (count === 0) return null

    const saved = await tx.repairReportItem.findFirst({
      where: { id: itemId, organisationId: orgId },
      include: itemInclude,
    })
    return saved && withEffectiveStage(saved)
  })
}

/**
 * Move an open job along the ladder.
 *
 * Shaped exactly like `resolveItem`, and for the same reason: the WHERE still
 * carries `resolvedAt: null`, so a move that races a sign-off matches nothing
 * and returns 0 rather than reopening a closed job by writing a stage over it.
 * The read before it only decides which of 404 / 409 the caller is told.
 *
 * A move to the stage the job is already at is refused rather than recorded.
 * Two clicks on "Fixing" should not draw two nodes on the tracking line.
 */
export async function setStage(itemId: string, orgId: string, userId: string, dto: SetStage) {
  return prisma.$transaction(async (tx) => {
    const current = await tx.repairReportItem.findFirst({
      where:  { id: itemId, organisationId: orgId, resolvedAt: null },
      select: { id: true, stage: true, stageHistory: true },
    })
    if (!current) return { item: null, reason: 'closed' as const }
    if (current.stage === dto.stage) return { item: null, reason: 'nochange' as const }

    const at = new Date()
    const { count } = await tx.repairReportItem.updateMany({
      where: { id: itemId, organisationId: orgId, resolvedAt: null, stage: current.stage },
      data: {
        stage:          dto.stage,
        stageChangedAt: at,
        stageHistory:   appendStage(current.stageHistory, {
          stage: dto.stage,
          at:    at.toISOString(),
          by:    userId,
          ...(await byName(tx, userId)),
          ...(dto.note ? { note: dto.note } : {}),
        }),
      },
    })
    if (count === 0) return { item: null, reason: 'closed' as const }

    const item = await tx.repairReportItem.findFirst({
      where: { id: itemId, organisationId: orgId },
      include: itemInclude,
    })
    return { item: item && withEffectiveStage(item), reason: 'ok' as const }
  })
}

/** The actor's name, copied onto the history entry. `{}` when unknown, so the
 *  spread adds nothing rather than an explicit undefined. */
async function byName(tx: Prisma.TransactionClient, userId: string): Promise<{ byName?: string }> {
  const u = await tx.user.findUnique({ where: { id: userId }, select: { fullName: true } })
  return u?.fullName ? { byName: u.fullName } : {}
}

/** One item, by id, tenant-scoped. The no-op stage move's answer. */
export async function findItemById(itemId: string, orgId: string) {
  const row = await prisma.repairReportItem.findFirst({
    where: { id: itemId, organisationId: orgId },
    include: itemInclude,
  })
  return row && withEffectiveStage(row)
}

/** Does this item exist at all? Separates "already closed" from "never here". */
/**
 * Who a job belongs to: the person it was given to, and the person who raised
 * it. Enough to decide a sign-off and nothing more, so it stays one indexed
 * read on the path of a write.
 *
 * `reportedById` lives on the REPORT, not the item — six units reported in one
 * visit share one author — so it is lifted through the relation here rather
 * than at every call site.
 */
export async function findItemOwnership(itemId: string, orgId: string) {
  const row = await prisma.repairReportItem.findFirst({
    where:  { id: itemId, organisationId: orgId },
    select: { assignedToId: true, resolvedAt: true, report: { select: { reportedById: true } } },
  })
  if (!row) return null
  return {
    assignedToId: row.assignedToId ?? null,
    reportedById: row.report?.reportedById ?? null,
    resolved:     row.resolvedAt != null,
  }
}

export async function itemExists(itemId: string, orgId: string): Promise<boolean> {
  const row = await prisma.repairReportItem.findFirst({
    where: { id: itemId, organisationId: orgId },
    select: { id: true },
  })
  return row !== null
}

// ---------------------------------------------------------------------------
// Who a triage may be handed to
// ---------------------------------------------------------------------------

/**
 * Every technician this organisation may hand a triage to.
 *
 * ## Why this lives here and not on the user roster
 *
 * The picker used to call the roster (`GET /organisations/:orgId/users?
 * access=system`), pull back up to a hundred rows and decide in the BROWSER
 * which of them held `technician`. Two things were wrong with that.
 *
 *   1. The roster is GROUP-SCOPED (users/user.service.listUsers). Group is a
 *      grouping of PEOPLE for the purpose of administering them: Offgrid staff
 *      must not administer Kasulu staff. Assignment is not administration, and
 *      the operator bounded it differently and explicitly: the assignee must be
 *      a technician IN THE SAME ORGANISATION, and NEED NOT BE IN THE SAME
 *      GROUP. Those two rules disagree, and the roster answers the wrong one.
 *
 *      That disagreement is not hypothetical. ControlTech are contractors --
 *      their own group -- who service units across all four tenants. They are
 *      the assignees this feature exists for, and the first administrator to
 *      turn `USER_GROUP_ENFORCE` on would have watched them vanish from the
 *      picker with no error and nothing logged.
 *
 *   2. Deciding a rule in the browser is not deciding it. The old client held
 *      its own copy of the role list, which is how it came to offer names the
 *      server refuses (see repairs.authz).
 *
 * So the server answers the question, in the module that owns the rule, and
 * the client renders what it is given.
 *
 * ## The filter, and why each clause is here
 *
 * IN THIS ORGANISATION -- home organisation or a live membership, the same
 * two-armed test the roster runs and `repairs.authz.isMemberOf` runs. Using
 * only the column would miss a contractor who is employed by nobody here and
 * granted a membership, which is exactly ControlTech's shape.
 *
 * HOLDING `technician` HERE -- the role row must be scoped to this
 * organisation, so a technician of Kabras is not offered for a Menengai job.
 * A platform-wide grant (organisation_id IS NULL) is deliberately NOT accepted:
 * the only roles that carry one are super_admin and director, and neither may
 * receive a triage.
 *
 * NOT SUSPENDED, NOT TERMINATED, NOT DELETED -- they cannot sign in to work it.
 *
 * Every clause above matches `canReceiveTriage`, which is what the assign
 * endpoint enforces. This list and that check must agree, or the picker offers
 * somebody the next request refuses.
 */
export type Assignee = {
  id:       string
  fullName: string | null
  email:    string | null
}

export async function findAssignees(orgId: string): Promise<Assignee[]> {
  return prisma.user.findMany({
    where: {
      deletedAt: null,
      status:    { notIn: ['SUSPENDED', 'TERMINATED'] },
      OR: [
        { organisationId: orgId },
        { memberships: { some: { organisationId: orgId, revokedAt: null } } },
      ],
      userRoles: {
        some: {
          revokedAt: null,
          role: { slug: 'technician', organisationId: orgId },
        },
      },
    },
    select:  { id: true, fullName: true, email: true },
    orderBy: [{ fullName: 'asc' }, { email: 'asc' }],
  })
}
