/**
 * The client's fleet list (driver, status and TYPE by plate) for an
 * organisation, uploaded once for everyone (operator, 2026-11-13: "every user
 * has to upload that, which is not ok"). It was kept in each browser.
 *
 * Every upload is a new row and none is ever changed or deleted, so what the
 * list said on a day can always be found. The newest row is the list in use;
 * going back to the list built into the app (Menengai's MORL_FLEET) is a row
 * of its own, with no entries.
 */
import { Prisma } from '../../../generated/prisma/client.js'
import { prisma } from '../../lib/prisma.js'
import type { SaveFleetList } from './fleet-list.schema.js'

/** How many past uploads the page is told about. */
export const HISTORY = 20

type Row = {
  id: string; fileName: string | null; unitCount: number; createdAt: Date
  uploadedByName: string | null; entries: Prisma.JsonValue | null
  sheets: Prisma.JsonValue | null; conflicts: Prisma.JsonValue | null
}
const version = (r: Row) => ({
  id: r.id,
  fileName: r.fileName,
  count: r.unitCount,
  at: r.createdAt.getTime(),
  by: r.uploadedByName,
  reset: r.entries == null,
})

/** The list in use (null: none uploaded, or put back to the built-in one) and the last uploads. */
export async function current(organisationId: string) {
  const rows: Row[] = await prisma.fleetListVersion.findMany({
    where: { organisationId },
    orderBy: { createdAt: 'desc' },
    take: HISTORY,
  })
  const top = rows[0]
  return {
    current: top && top.entries != null
      ? { ...version(top), entries: top.entries, sheets: top.sheets ?? [], conflicts: top.conflicts ?? [] }
      : null,
    history: rows.map(version),
  }
}

export type Actor = { id: string | null; name: string | null }

/** Keep an upload; it is the list in use from now. */
export async function save(organisationId: string, actor: Actor, body: SaveFleetList) {
  await prisma.fleetListVersion.create({
    data: {
      organisationId,
      fileName: body.fileName,
      entries: body.entries,
      unitCount: Object.keys(body.entries).length,
      sheets: body.sheets,
      conflicts: body.conflicts,
      uploadedById: actor.id,
      uploadedByName: actor.name,
    },
  })
  return current(organisationId)
}

/** Back to the list built into the app; the uploads stay on record. */
export async function reset(organisationId: string, actor: Actor) {
  await prisma.fleetListVersion.create({
    data: { organisationId, entries: Prisma.DbNull, uploadedById: actor.id, uploadedByName: actor.name },
  })
  return current(organisationId)
}
