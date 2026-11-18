import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Archived geofences (archived_at set) are out of use everywhere but kept in
 * the table. These pin the readers that decide or draw something to live
 * fences only, and the Planner to treating an archived fence as gone.
 */
vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/notifications/notification.store.js', () => ({ publishNotification: vi.fn() }))
const { prismaMock } = await import('../helpers/prisma.mock.js')
const { hidesInactiveFences, LIVE_FENCE, NO_WIALON_ZONE_IMPORT_ORGS } = await import('../../src/lib/fence-archive.js')
const repo = await import('../../src/modules/geofences/geofence.repository.js')
const { loadOrgZones, invalidateZoneCache } = await import('../../src/lib/zone-presence.js')
const { fenceCustomer } = await import('../../src/modules/planner/planner.service.js')
const { geofenceListQuerySchema } = await import('../../src/modules/geofences/geofence.schema.js')

beforeEach(() => { vi.clearAllMocks() })

describe('fence-archive', () => {
  it('hides inactive fences for Menengai only', () => {
    expect(hidesInactiveFences('MENENGAI')).toBe(true)
    expect(hidesInactiveFences('menengai')).toBe(true)
    expect(hidesInactiveFences('KASULU')).toBe(false)
    expect(hidesInactiveFences(null)).toBe(false)
  })

  it('stops Menengai importing Wialon zones', () => {
    expect(NO_WIALON_ZONE_IMPORT_ORGS).toContain('MENENGAI')
    expect(NO_WIALON_ZONE_IMPORT_ORGS).not.toContain('KASULU')
  })
})

describe('readers skip archived fences', () => {
  it('live zone presence loads only live fences', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([] as never)
    invalidateZoneCache('org-z')
    await loadOrgZones('org-z')
    expect(prismaMock.geofence.findMany.mock.calls[0]![0]!.where).toMatchObject({ organisationId: 'org-z', ...LIVE_FENCE })
  })

  it('the map GeoJSON serves only live fences', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([] as never)
    await repo.findAllAsGeoJSON('org1')
    expect(prismaMock.geofence.findMany.mock.calls[0]![0]!.where).toEqual({ organisationId: 'org1', archivedAt: null })
  })

  it('the list shows live fences by default and archived ones on request', async () => {
    prismaMock.geofence.findMany.mockResolvedValue([] as never)
    await repo.findAll('org1', geofenceListQuerySchema.parse({}))
    expect(prismaMock.geofence.findMany.mock.calls[0]![0]!.where).toMatchObject({ archivedAt: null })
    await repo.findAll('org1', geofenceListQuerySchema.parse({ archived: 'true' }))
    expect(prismaMock.geofence.findMany.mock.calls[1]![0]!.where).toMatchObject({ archivedAt: { not: null } })
  })

  it('an archived fence cannot be edited', async () => {
    prismaMock.geofence.findFirst.mockResolvedValue({ id: 'g1', externalId: null, archivedAt: new Date() } as never)
    await expect(repo.update('g1', 'org1', { purpose: 'shop' } as never)).rejects.toThrow(/archived/)
    expect(prismaMock.geofence.update).not.toHaveBeenCalled()
  })
})

describe('Planner treats an archived fence as gone', () => {
  it('fences the customer again when its fence is archived', async () => {
    prismaMock.plannerCustomer.findFirst.mockResolvedValue({ id: 'c1', customerCode: '10023', geofenceId: 'wialon-fence' } as never)
    // The live-fence lookup finds nothing: the row exists but is archived.
    prismaMock.geofence.findFirst.mockResolvedValue(null)
    prismaMock.geofence.create.mockResolvedValue({ id: 'f-new' } as never)
    prismaMock.$transaction.mockImplementation(((fn: (tx: unknown) => unknown) => fn(prismaMock)) as never)
    await fenceCustomer('org1', 'c1', { name: 'Shop', lat: -0.3, lng: 36.1, radiusM: 100 })
    expect(prismaMock.geofence.findFirst.mock.calls[0]![0]!.where).toMatchObject({ id: 'wialon-fence', archivedAt: null })
    expect(prismaMock.plannerCustomer.update.mock.calls[0]![0]!.data).toEqual({ geofenceId: 'f-new' })
  })
})
