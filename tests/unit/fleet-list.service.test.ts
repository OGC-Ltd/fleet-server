import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { current, save, reset } from '../../src/modules/fleet-list/fleet-list.service.js'
import { saveFleetListSchema } from '../../src/modules/fleet-list/fleet-list.schema.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = prismaMock as any
const at = (iso: string) => new Date(iso)
const upload = {
  id: 'v2', fileName: 'MORL_FLEET.xlsx', unitCount: 1, createdAt: at('2026-11-13T18:00:00Z'), uploadedByName: 'Ann',
  entries: { 'KCK 456G': { driver: 'Stephen Maina Mwangi', status: 'Operational', type: 'TANKER', list: 'MORL TANKER FLEET' } },
  sheets: [{ name: 'MORL TANKER FLEET', count: 1 }], conflicts: [],
}
const older = { ...upload, id: 'v1', fileName: 'old.xlsx', createdAt: at('2026-11-12T08:00:00Z') }
const resetRow = { ...upload, id: 'v3', fileName: null, unitCount: 0, entries: null, sheets: null, conflicts: null, createdAt: at('2026-11-13T19:00:00Z') }

describe('the fleet list kept for the organisation (2026-11-13)', () => {
  beforeEach(() => { p.fleetListVersion.create.mockResolvedValue({}) })

  it('the newest upload is the list in use, the older ones listed', async () => {
    p.fleetListVersion.findMany.mockResolvedValue([upload, older])
    const got = await current('org1')
    expect(p.fleetListVersion.findMany.mock.calls[0][0]).toMatchObject({ where: { organisationId: 'org1' }, orderBy: { createdAt: 'desc' } })
    expect(got.current).toMatchObject({ id: 'v2', fileName: 'MORL_FLEET.xlsx', count: 1, by: 'Ann', entries: upload.entries })
    expect(got.history.map((h) => h.id)).toEqual(['v2', 'v1'])
  })

  it('none uploaded, or put back to the built-in list: no list in use', async () => {
    p.fleetListVersion.findMany.mockResolvedValue([])
    expect((await current('org1')).current).toBeNull()
    p.fleetListVersion.findMany.mockResolvedValue([resetRow, upload])
    const got = await current('org1')
    expect(got.current).toBeNull()
    expect(got.history[0]).toMatchObject({ reset: true })
  })

  it('an upload is a new row; nothing is updated or deleted', async () => {
    p.fleetListVersion.findMany.mockResolvedValue([upload])
    await save('org1', { id: 'u1', name: 'Ann' }, { fileName: 'MORL_FLEET.xlsx', entries: upload.entries, sheets: upload.sheets, conflicts: [] })
    expect(p.fleetListVersion.create.mock.calls[0][0].data).toMatchObject({ organisationId: 'org1', unitCount: 1, uploadedById: 'u1', uploadedByName: 'Ann' })
    await reset('org1', { id: 'u1', name: 'Ann' })
    expect(p.fleetListVersion.create).toHaveBeenCalledTimes(2)
    expect(p.fleetListVersion.update).not.toHaveBeenCalled()
    expect(p.fleetListVersion.delete).not.toHaveBeenCalled()
    expect(p.fleetListVersion.deleteMany).not.toHaveBeenCalled()
  })

  it('keeps only plate, driver, status, type and sheet; an empty file is refused', () => {
    const parsed = saveFleetListSchema.parse({ fileName: 'f.xlsx', entries: { 'KAA 001A': { driver: 'A', status: 'B', type: 'FUSO', list: 'X', phone: '0700', id: '123' } } })
    expect(parsed.entries['KAA 001A']).toEqual({ driver: 'A', status: 'B', type: 'FUSO', list: 'X' })
    expect(saveFleetListSchema.safeParse({ fileName: 'f.xlsx', entries: {} }).success).toBe(false)
  })
})
