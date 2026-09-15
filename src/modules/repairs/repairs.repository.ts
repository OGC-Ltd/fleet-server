import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../core/errors/errors.js'
import type {
  CreateRepairReport, ResolveItem, ListReportsQuery, ListItemsQuery,
} from './repairs.schema.js'

/**
 * What every read of an item carries with it.
 *
 * The plate, always. An item names its unit by id, and an id is not something
 * anybody can act on — every screen and every line of the email needs the
 * registration instead.
 */
const itemInclude = {
  vehicle: { select: { id: true, registrationPlate: true, name: true } },
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
          ...(i.faultEpisodeId ? { faultEpisodeId: i.faultEpisodeId } : {}),
          ...(i.faultKind      ? { faultKind:      i.faultKind }      : {}),
          ...(i.sparePart      ? { sparePart:      i.sparePart }      : {}),
          ...(i.problemNote    ? { problemNote:    i.problemNote }    : {}),
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

export async function findReports(orgId: string, q: ListReportsQuery) {
  const rows = await prisma.repairReport.findMany({
    where: { organisationId: orgId, ...(q.cursor ? { id: { lt: q.cursor } } : {}) },
    include: reportInclude,
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  })
  const hasNextPage = rows.length > q.limit
  if (hasNextPage) rows.pop()
  return { data: rows, cursor: hasNextPage ? (rows.at(-1)?.id ?? null) : null, hasNextPage }
}

export async function findReportById(reportId: string, orgId: string) {
  return prisma.repairReport.findFirst({
    where: { id: reportId, organisationId: orgId },
    include: reportInclude,
  })
}

export async function findItems(orgId: string, q: ListItemsQuery) {
  const rows = await prisma.repairReportItem.findMany({
    where: {
      organisationId: orgId,
      ...(q.status === 'open'     ? { resolvedAt: null }         : {}),
      ...(q.status === 'resolved' ? { resolvedAt: { not: null } } : {}),
      ...(q.cursor ? { id: { lt: q.cursor } } : {}),
    },
    include: {
      ...itemInclude,
      report: { select: { id: true, reportedAt: true, reportedBy: { select: { fullName: true } } } },
      resolvedBy: { select: { id: true, fullName: true } },
    },
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  })
  const hasNextPage = rows.length > q.limit
  if (hasNextPage) rows.pop()
  return { data: rows, cursor: hasNextPage ? (rows.at(-1)?.id ?? null) : null, hasNextPage }
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
export async function resolveItem(itemId: string, orgId: string, userId: string, dto: ResolveItem) {
  const { count } = await prisma.repairReportItem.updateMany({
    where: { id: itemId, organisationId: orgId, resolvedAt: null },
    data: {
      resolvedAt:   new Date(),
      resolvedById: userId,
      fixNote:      dto.fixNote,
      ...(dto.recommendation ? { recommendation: dto.recommendation } : {}),
    },
  })
  if (count === 0) return null
  return prisma.repairReportItem.findFirst({
    where: { id: itemId, organisationId: orgId },
    include: itemInclude,
  })
}

/** Does this item exist at all? Separates "already closed" from "never here". */
export async function itemExists(itemId: string, orgId: string): Promise<boolean> {
  const row = await prisma.repairReportItem.findFirst({
    where: { id: itemId, organisationId: orgId },
    select: { id: true },
  })
  return row !== null
}
