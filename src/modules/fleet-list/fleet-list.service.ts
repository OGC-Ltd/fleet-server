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
import { NotFoundError, BadRequestError } from '../../core/errors/errors.js'
import { decodeBase64File, fileUrl, isXlsx, putFile, removeFile, uploadKey, XLSX_TYPE } from '../../lib/uploads.js'
import type { SaveFleetList } from './fleet-list.schema.js'

/** How many past uploads the page is told about. */
export const HISTORY = 20

type Row = {
  id: string; fileName: string | null; unitCount: number; createdAt: Date
  uploadedByName: string | null; entries: Prisma.JsonValue | null
  sheets: Prisma.JsonValue | null; conflicts: Prisma.JsonValue | null
  fileKey?: string | null
}
const version = (r: Row) => ({
  id: r.id,
  fileName: r.fileName,
  count: r.unitCount,
  at: r.createdAt.getTime(),
  by: r.uploadedByName,
  reset: r.entries == null,
  /** The uploaded file is kept (S3) and can be downloaded */
  file: Boolean(r.fileKey),
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

/**
 * Keep an upload; it is the list in use from now. The file goes to S3 first and
 * the row is written only once it is there, so no list is on record without
 * its file. If the row then fails, the file is removed again.
 */
export async function save(organisationId: string, actor: Actor, body: SaveFleetList) {
  const buf = decodeBase64File(body.file)
  if (!isXlsx(buf)) throw new BadRequestError('This is not an Excel workbook (.xlsx).')
  const stored = await putFile(uploadKey('fleet-lists', organisationId, body.fileName), buf, XLSX_TYPE, {
    'organisation-id': organisationId,
    ...(actor.id ? { 'uploaded-by-id': actor.id } : {}),
  })
  try {
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
        fileKey: stored.key,
        fileSize: stored.size,
        fileType: stored.type,
        fileSha256: stored.sha256,
      },
    })
  } catch (err) {
    await removeFile(stored.key)
    throw err
  }
  return current(organisationId)
}

/**
 * A short-lived link to download an uploaded fleet Excel as it was uploaded.
 * Only this organisation's rows; a reset row or a row from before files were
 * kept has none.
 */
export async function fileLink(organisationId: string, id: string) {
  const row = await prisma.fleetListVersion.findFirst({
    where: { id, organisationId },
    select: { fileKey: true, fileName: true },
  })
  if (!row?.fileKey) throw new NotFoundError('Fleet list file')
  const fileName = row.fileName || 'fleet-list.xlsx'
  return { fileName, ...(await fileUrl(row.fileKey, fileName)) }
}

/** Back to the list built into the app; the uploads stay on record. */
export async function reset(organisationId: string, actor: Actor) {
  await prisma.fleetListVersion.create({
    data: { organisationId, entries: Prisma.DbNull, uploadedById: actor.id, uploadedByName: actor.name },
  })
  return current(organisationId)
}
