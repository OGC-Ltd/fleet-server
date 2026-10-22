/**
 * Which units the live fuel pass asks Wialon about. A drain Wialon recognises
 * late used to reach the ledger only on the settle pass, six to thirty hours
 * on (8–22 Oct: 17 SIPHON announced 6.6–20 h late, 14 never).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { findOpenFallVehicles, mergeCandidates } from '../../src/modules/fuel/fuel-sync.service.js'
import { lingersThisCycle } from '../../src/lib/queues/fuel-events.js'

const v = (id: string, plate: string) => ({ id, deviceId: `wialon:${id}`, registrationPlate: plate })

describe('the live pass candidates', () => {
  it('asks about a unit with a parked fall still open, whatever its spread', async () => {
    prismaMock.parkedFuelFall.findMany.mockResolvedValue([{ vehicle: v('1', 'CTR 12') }] as never)
    const since = new Date('2026-10-22T00:00:00Z')
    expect(await findOpenFallVehicles('org_1', since)).toEqual([v('1', 'CTR 12')])
    const q = prismaMock.parkedFuelFall.findMany.mock.calls[0]![0]!
    expect(q.where).toMatchObject({ organisationId: 'org_1', verdict: 'PENDING', settledAt: { gte: since } })
    expect(q.distinct).toEqual(['vehicleId'])
  })

  it('asks about each unit once, in plate order', () => {
    expect(mergeCandidates([v('2', 'FT 05'), v('1', 'CTR 12')], [v('1', 'CTR 12'), v('3', 'AB 01')]).map(x => x.id))
      .toEqual(['3', '1', '2'])
  })

  it('reaches back over the whole window once an hour, on the quarter-hourly cron', () => {
    const hour = Date.parse('2026-10-22T05:00:00Z')
    const ticks = [0, 15, 30, 45, 60].map(m => lingersThisCycle(hour + m * 60_000 + 3_000))
    expect(ticks).toEqual([true, false, false, false, true])
  })
})
