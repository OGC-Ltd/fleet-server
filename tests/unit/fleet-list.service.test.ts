import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
// S3 is never called from a unit test: the store is replaced, the pure helpers kept.
vi.mock('../../src/lib/uploads.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/uploads.js')>()
  return {
    ...real,
    putFile: vi.fn(async (key: string, body: Buffer, type: string) => ({ key, size: body.length, type, sha256: 'abc' })),
    removeFile: vi.fn(async () => {}),
    fileUrl: vi.fn(async () => ({ url: 'https://bucket.s3/presigned', expiresIn: 300 })),
  }
})

import { prismaMock } from '../helpers/prisma.mock.js'
import { current, save, reset, fileLink } from '../../src/modules/fleet-list/fleet-list.service.js'
import { saveFleetListSchema } from '../../src/modules/fleet-list/fleet-list.schema.js'
import * as uploads from '../../src/lib/uploads.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = prismaMock as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const u = uploads as any
const at = (iso: string) => new Date(iso)
const upload = {
  id: 'v2', fileName: 'MORL_FLEET.xlsx', unitCount: 1, createdAt: at('2026-11-13T18:00:00Z'), uploadedByName: 'Ann',
  entries: { 'KCK 456G': { driver: 'Stephen Maina Mwangi', status: 'Operational', type: 'TANKER', list: 'MORL TANKER FLEET' } },
  sheets: [{ name: 'MORL TANKER FLEET', count: 1 }], conflicts: [], fileKey: 'fleet-lists/org1/2026/11/13/180000-aa-MORL_FLEET.xlsx',
}
const older = { ...upload, id: 'v1', fileName: 'old.xlsx', createdAt: at('2026-11-12T08:00:00Z'), fileKey: null }
const resetRow = { ...upload, id: 'v3', fileName: null, unitCount: 0, entries: null, sheets: null, conflicts: null, fileKey: null, createdAt: at('2026-11-13T19:00:00Z') }
// An .xlsx is a zip: "PK\x03\x04" then anything
const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('workbook bytes')]).toString('base64')
const body = { fileName: 'MORL_FLEET.xlsx', file: xlsx, entries: upload.entries, sheets: upload.sheets, conflicts: [] }

describe('the fleet list kept for the organisation (2026-11-13)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    p.fleetListVersion.create.mockResolvedValue({})
  })

  it('the newest upload is the list in use, the older ones listed, with whether each file is kept', async () => {
    p.fleetListVersion.findMany.mockResolvedValue([upload, older])
    const got = await current('org1')
    expect(p.fleetListVersion.findMany.mock.calls[0][0]).toMatchObject({ where: { organisationId: 'org1' }, orderBy: { createdAt: 'desc' } })
    expect(got.current).toMatchObject({ id: 'v2', fileName: 'MORL_FLEET.xlsx', count: 1, by: 'Ann', entries: upload.entries, file: true })
    expect(got.history.map((h) => [h.id, h.file])).toEqual([['v2', true], ['v1', false]])
  })

  it('none uploaded, or put back to the built-in list: no list in use', async () => {
    p.fleetListVersion.findMany.mockResolvedValue([])
    expect((await current('org1')).current).toBeNull()
    p.fleetListVersion.findMany.mockResolvedValue([resetRow, upload])
    const got = await current('org1')
    expect(got.current).toBeNull()
    expect(got.history[0]).toMatchObject({ reset: true, file: false })
  })

  it('an upload is a new row; nothing is updated or deleted', async () => {
    p.fleetListVersion.findMany.mockResolvedValue([upload])
    await save('org1', { id: 'u1', name: 'Ann' }, body)
    expect(p.fleetListVersion.create.mock.calls[0][0].data).toMatchObject({ organisationId: 'org1', unitCount: 1, uploadedById: 'u1', uploadedByName: 'Ann' })
    await reset('org1', { id: 'u1', name: 'Ann' })
    expect(p.fleetListVersion.create).toHaveBeenCalledTimes(2)
    expect(p.fleetListVersion.update).not.toHaveBeenCalled()
    expect(p.fleetListVersion.delete).not.toHaveBeenCalled()
    expect(p.fleetListVersion.deleteMany).not.toHaveBeenCalled()
  })

  it('the file goes to S3 under the organisation before the row, and the row records where', async () => {
    p.fleetListVersion.findMany.mockResolvedValue([upload])
    await save('org1', { id: 'u1', name: 'Ann' }, body)
    const [key, buf, type] = u.putFile.mock.calls[0]
    expect(key).toMatch(/^fleet-lists\/org1\/\d{4}\/\d{2}\/\d{2}\/\d{6}-[0-9a-f]{12}-MORL_FLEET\.xlsx$/)
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    expect(type).toBe(uploads.XLSX_TYPE)
    expect(u.putFile.mock.invocationCallOrder[0]).toBeLessThan(p.fleetListVersion.create.mock.invocationCallOrder[0])
    expect(p.fleetListVersion.create.mock.calls[0][0].data).toMatchObject({ fileKey: key, fileSize: buf.length, fileType: uploads.XLSX_TYPE, fileSha256: 'abc' })
  })

  it('a file that is not an .xlsx is refused and nothing is kept', async () => {
    await expect(save('org1', { id: 'u1', name: 'Ann' }, { ...body, file: Buffer.from('name,driver\nKAA,Ann').toString('base64') }))
      .rejects.toThrow(/not an Excel workbook/)
    expect(u.putFile).not.toHaveBeenCalled()
    expect(p.fleetListVersion.create).not.toHaveBeenCalled()
  })

  it('S3 refuses the file: no row is written', async () => {
    u.putFile.mockRejectedValueOnce(new Error('S3 down'))
    await expect(save('org1', { id: 'u1', name: 'Ann' }, body)).rejects.toThrow('S3 down')
    expect(p.fleetListVersion.create).not.toHaveBeenCalled()
  })

  it('the row cannot be written: the file just stored is removed again', async () => {
    p.fleetListVersion.create.mockRejectedValueOnce(new Error('db down'))
    await expect(save('org1', { id: 'u1', name: 'Ann' }, body)).rejects.toThrow('db down')
    expect(u.removeFile).toHaveBeenCalledWith(u.putFile.mock.calls[0][0])
  })

  it('a download link is only for this organisation\'s row with a kept file', async () => {
    p.fleetListVersion.findFirst.mockResolvedValueOnce({ fileKey: upload.fileKey, fileName: 'MORL_FLEET.xlsx' })
    expect(await fileLink('org1', 'v2')).toEqual({ fileName: 'MORL_FLEET.xlsx', url: 'https://bucket.s3/presigned', expiresIn: 300 })
    expect(p.fleetListVersion.findFirst.mock.calls[0][0].where).toEqual({ id: 'v2', organisationId: 'org1' })
    expect(u.fileUrl).toHaveBeenCalledWith(upload.fileKey, 'MORL_FLEET.xlsx')
    p.fleetListVersion.findFirst.mockResolvedValueOnce({ fileKey: null, fileName: null })
    await expect(fileLink('org1', 'v3')).rejects.toThrow(/not found/)
    p.fleetListVersion.findFirst.mockResolvedValueOnce(null)
    await expect(fileLink('org2', 'v2')).rejects.toThrow(/not found/)
  })

  it('keeps only plate, driver, status, type and sheet; an empty list or no file is refused', () => {
    const parsed = saveFleetListSchema.parse({ fileName: 'f.xlsx', file: xlsx, entries: { 'KAA 001A': { driver: 'A', status: 'B', type: 'FUSO', list: 'X', phone: '0700', id: '123' } } })
    expect(parsed.entries['KAA 001A']).toEqual({ driver: 'A', status: 'B', type: 'FUSO', list: 'X' })
    expect(saveFleetListSchema.safeParse({ fileName: 'f.xlsx', file: xlsx, entries: {} }).success).toBe(false)
    expect(saveFleetListSchema.safeParse({ fileName: 'f.xlsx', entries: parsed.entries }).success).toBe(false)
  })
})
