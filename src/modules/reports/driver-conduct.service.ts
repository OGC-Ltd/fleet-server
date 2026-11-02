/**
 * Driver conduct follow-up, kept here rather than in each browser (operator,
 * 2 Nov 2026: the count beside Reports differed from machine to machine).
 *
 * The Reports page still works out the cases when it runs the report (new-ui
 * lib/followUp casesFromRun: one per vehicle per fleet day that calls for
 * follow-up) and sends them here. A run updates a case's counts and driver;
 * what an operator recorded on it - status, action, note, who and when - is
 * never overwritten by a run. The incidents operators log by hand (lib/
 * operatorLog) live here too. Times go out as epoch ms, as the page keeps them.
 */
import type { DriverConductCase, OperatorIncident } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../core/errors/errors.js'
import type { FoundCase, StoredCase, CaseAction, IncidentBody } from './driver-conduct.schema.js'

/** A case as the page holds it. */
export interface ConductCase {
  id: string
  day: string
  unitKey: string
  plate: string
  group: string | null
  driver: string
  accel: number; brake: number; seatbelt: number; phone: number; covered: number
  openedAt: number
  status: 'pending' | 'done'
  action: string | null
  note: string
  by: string
  actedAt: number | null
}

/** The most the page is sent at once; years of a fleet's cases stay under it. */
export const MAX_CASES = 10_000

export function toCase(r: DriverConductCase): ConductCase {
  return {
    id: r.caseKey, day: r.day, unitKey: r.unitKey, plate: r.plate, group: r.groupName, driver: r.driver,
    accel: r.accel, brake: r.brake, seatbelt: r.seatbelt, phone: r.phone, covered: r.covered,
    openedAt: r.openedAt.getTime(),
    status: r.status === 'done' ? 'done' : 'pending',
    action: r.action, note: r.note, by: r.actedBy, actedAt: r.actedAt?.getTime() ?? null,
  }
}

const counts = (f: FoundCase) => ({
  day: f.day, unitKey: f.unitKey, plate: f.plate, groupName: f.group ?? null, driver: f.driver,
  accel: f.accel, brake: f.brake, seatbelt: f.seatbelt, phone: f.phone, covered: f.covered,
})

export async function listCases(orgId: string, q: { from?: string; to?: string } = {}): Promise<ConductCase[]> {
  const rows = await prisma.driverConductCase.findMany({
    where: { organisationId: orgId, day: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } },
    orderBy: { openedAt: 'asc' },
    take: MAX_CASES,
  })
  return rows.map(toCase)
}

/** The sidebar's count: cases nobody has acted on. */
export const pendingCount = (orgId: string) =>
  prisma.driverConductCase.count({ where: { organisationId: orgId, status: 'pending' } })

/**
 * What a run should write for each case it found, against what is stored:
 * new ones open pending; known ones take the run's counts and driver, the
 * earlier of the two openings, and keep everything an operator recorded.
 */
export function planFound(stored: Map<string, { openedAt: Date }>, found: FoundCase[]) {
  const create: FoundCase[] = []
  const update: Array<{ caseKey: string; data: ReturnType<typeof counts> & { openedAt: Date } }> = []
  for (const f of new Map(found.map((x) => [x.id, x])).values()) {
    const old = stored.get(f.id)
    if (!old) create.push(f)
    else update.push({ caseKey: f.id, data: { ...counts(f), openedAt: new Date(Math.min(old.openedAt.getTime(), f.openedAt)) } })
  }
  return { create, update }
}

export async function mergeFound(orgId: string, found: FoundCase[]): Promise<ConductCase[]> {
  if (found.length) {
    const stored = await prisma.driverConductCase.findMany({
      where: { organisationId: orgId, caseKey: { in: found.map((f) => f.id) } },
      select: { caseKey: true, openedAt: true },
    })
    const { create, update } = planFound(new Map(stored.map((s) => [s.caseKey, s])), found)
    await prisma.$transaction([
      ...(create.length ? [prisma.driverConductCase.createMany({
        data: create.map((f) => ({ organisationId: orgId, caseKey: f.id, ...counts(f), openedAt: new Date(f.openedAt) })),
        skipDuplicates: true,
      })] : []),
      ...update.map((u) => prisma.driverConductCase.update({
        where: { organisationId_caseKey: { organisationId: orgId, caseKey: u.caseKey } },
        data: u.data,
      })),
    ])
  }
  return listCases(orgId)
}

/** Record what was done on a case, by the signed-in user; a null action reopens it. */
export async function recordAction(orgId: string, caseKey: string, a: CaseAction, by: string): Promise<ConductCase> {
  const where = { organisationId_caseKey: { organisationId: orgId, caseKey } }
  const found = await prisma.driverConductCase.findUnique({ where, select: { id: true } })
  if (!found) throw new NotFoundError('That follow-up case was not found')
  const row = await prisma.driverConductCase.update({
    where,
    data: a.action
      ? { status: 'done', action: a.action, note: a.note.slice(0, 1000), actedBy: by, actedAt: new Date() }
      : { status: 'pending', action: null, note: '', actedBy: '', actedAt: null },
  })
  return toCase(row)
}

/**
 * Cases a browser kept, brought here once: a case not held is added as it
 * was; one held already takes the browser's record only when that was acted
 * on later (the rule the page's own Import used).
 */
export function planImport(stored: Map<string, { actedAt: Date | null }>, incoming: StoredCase[]) {
  const create: StoredCase[] = []
  const update: StoredCase[] = []
  for (const c of new Map(incoming.map((x) => [x.id, x])).values()) {
    const old = stored.get(c.id)
    if (!old) create.push(c)
    else if ((c.actedAt ?? 0) > (old.actedAt?.getTime() ?? 0)) update.push(c)
  }
  return { create, update }
}

const recorded = (c: StoredCase) => ({
  status: c.status === 'done' && c.action ? 'done' : 'pending',
  action: c.status === 'done' ? c.action ?? null : null,
  note: c.status === 'done' ? c.note : '',
  actedBy: c.status === 'done' ? c.by : '',
  actedAt: c.status === 'done' && c.actedAt ? new Date(c.actedAt) : null,
})

export async function importCases(orgId: string, incoming: StoredCase[]): Promise<{ added: number; cases: ConductCase[] }> {
  const stored = await prisma.driverConductCase.findMany({
    where: { organisationId: orgId, caseKey: { in: incoming.map((c) => c.id) } },
    select: { caseKey: true, actedAt: true },
  })
  const { create, update } = planImport(new Map(stored.map((s) => [s.caseKey, s])), incoming)
  await prisma.$transaction([
    ...(create.length ? [prisma.driverConductCase.createMany({
      data: create.map((c) => ({ organisationId: orgId, caseKey: c.id, ...counts(c), openedAt: new Date(c.openedAt), ...recorded(c) })),
      skipDuplicates: true,
    })] : []),
    ...update.map((c) => prisma.driverConductCase.update({
      where: { organisationId_caseKey: { organisationId: orgId, caseKey: c.id } },
      data: recorded(c),
    })),
  ])
  return { added: create.length, cases: await listCases(orgId) }
}

// ── incidents operators logged ──────────────────────────────────────────────

export interface LoggedIncident {
  id: string; kind: string; other: string; at: number; vehicleId: string | null; plate: string
  driver: string; location: string; status: 'Online' | 'Offline'; details: string; by: string; loggedAt: number
}

export function toIncident(r: OperatorIncident): LoggedIncident {
  return {
    id: r.id, kind: r.kind, other: r.other, at: r.at.getTime(), vehicleId: r.vehicleId, plate: r.plate,
    driver: r.driver, location: r.location, status: r.status === 'Offline' ? 'Offline' : 'Online',
    details: r.details, by: r.loggedBy, loggedAt: r.loggedAt.getTime(),
  }
}

const incidentFields = (e: IncidentBody) => ({
  kind: e.kind, other: e.kind === 'other' ? e.other : '', at: new Date(e.at), vehicleId: e.vehicleId ?? null,
  plate: e.plate, driver: e.driver, location: e.location, status: e.status, details: e.details,
})

export async function listIncidents(orgId: string): Promise<LoggedIncident[]> {
  const rows = await prisma.operatorIncident.findMany({ where: { organisationId: orgId }, orderBy: { at: 'desc' }, take: MAX_CASES })
  return rows.map(toIncident)
}

/** Add or change an entry. A new one is logged by the signed-in user; an edit keeps who logged it. */
export async function saveIncident(orgId: string, e: IncidentBody, by: string): Promise<LoggedIncident> {
  const old = await prisma.operatorIncident.findUnique({ where: { id: e.id }, select: { organisationId: true } })
  if (old && old.organisationId !== orgId) throw new NotFoundError('That incident was not found')
  const row = old
    ? await prisma.operatorIncident.update({ where: { id: e.id }, data: incidentFields(e) })
    : await prisma.operatorIncident.create({ data: { id: e.id, organisationId: orgId, ...incidentFields(e), loggedBy: by, loggedAt: new Date() } })
  return toIncident(row)
}

export async function deleteIncident(orgId: string, id: string): Promise<void> {
  const { count } = await prisma.operatorIncident.deleteMany({ where: { id, organisationId: orgId } })
  if (!count) throw new NotFoundError('That incident was not found')
}

/** Entries a browser kept, brought here once; one held already (same id) is left as it is. */
export async function importIncidents(orgId: string, entries: IncidentBody[]): Promise<{ added: number; entries: LoggedIncident[] }> {
  const { count } = entries.length
    ? await prisma.operatorIncident.createMany({
      data: entries.map((e) => ({
        id: e.id, organisationId: orgId, ...incidentFields(e), loggedBy: e.by, loggedAt: new Date(e.loggedAt ?? e.at),
      })),
      skipDuplicates: true,
    })
    : { count: 0 }
  return { added: count, entries: await listIncidents(orgId) }
}
