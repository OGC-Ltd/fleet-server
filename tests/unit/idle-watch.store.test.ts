import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { saveEpisodes, listEpisodes } from '../../src/modules/idle-watch/idle-watch.store.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = prismaMock as any
const NOW = Date.parse('2026-11-13T09:00:00Z')

const alert = (over: Record<string, unknown> = {}) => ({
  key: 'v1|idle|1000', vehicleId: 'v1', plate: 'KCN 901F', size: '30T', designation: 'Tanker',
  since: Date.parse('2026-11-13T05:30:00Z'), sinceExact: true,
  idleMs: 2.5 * 3_600_000, standingMs: 3.5 * 3_600_000, severity: 'warning' as const,
  lat: -0.3, lng: 36.1, engineOn: false, lastSeenAt: NOW,
  nearest: { name: 'Nakuru depot', category: 'depot', metres: 1234.4 },
  ...over,
})

describe('saveEpisodes', () => {
  beforeEach(() => {
    p.idleEpisode.upsert.mockResolvedValue({})
    p.idleEpisode.updateMany.mockResolvedValue({ count: 0 })
  })

  it('keeps one row per stop, keyed by the alert, in minutes', async () => {
    await saveEpisodes('org1', [alert()], NOW)
    const call = p.idleEpisode.upsert.mock.calls[0][0]
    expect(call.where).toEqual({ key: 'v1|idle|1000' })
    expect(call.create).toMatchObject({ organisationId: 'org1', plate: 'KCN 901F', idleMinutes: 150, standingMinutes: 210, severity: 'warning', place: 'Nakuru depot', placeMetres: 1234 })
    // A warning seen again never lowers a row that reached critical.
    expect(call.update.severity).toBeUndefined()
    expect(call.update.endedAt).toBeNull()
  })

  it('marks critical once reached', async () => {
    await saveEpisodes('org1', [alert({ severity: 'critical' })], NOW)
    expect(p.idleEpisode.upsert.mock.calls[0][0].update.severity).toBe('critical')
  })

  it('ends the open rows of units no longer idle', async () => {
    await saveEpisodes('org1', [alert()], NOW)
    expect(p.idleEpisode.updateMany).toHaveBeenCalledWith({
      where: { organisationId: 'org1', endedAt: null, key: { notIn: ['v1|idle|1000'] } },
      data:  { endedAt: new Date(NOW) },
    })
  })

  it('ends every open row when nothing is idle', async () => {
    await saveEpisodes('org1', [], NOW)
    expect(p.idleEpisode.upsert).not.toHaveBeenCalled()
    expect(p.idleEpisode.updateMany.mock.calls[0][0].where.key).toEqual({ notIn: [] })
  })
})

describe('listEpisodes', () => {
  it('asks for stops overlapping the days, within the caller scope', async () => {
    p.idleEpisode.findMany.mockResolvedValue([])
    const from = new Date('2026-11-10T21:00:00Z')
    const to = new Date('2026-11-12T20:59:59Z')
    await listEpisodes('org1', { from, to, q: 'kcn', vehicleIds: new Set(['v1']) })
    const where = p.idleEpisode.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({
      organisationId: 'org1',
      since: { lte: to },
      OR: [{ endedAt: null }, { endedAt: { gte: from } }],
      plate: { contains: 'kcn', mode: 'insensitive' },
      vehicleId: { in: ['v1'] },
    })
  })
})
