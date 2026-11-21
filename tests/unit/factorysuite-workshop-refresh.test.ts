/**
 * Open Auto Workshop pages re-read on `repair_changed`. The sync must send it
 * whenever a pass changed what we hold from FactorySuite (operator, 2026-11-21:
 * "any changes from factory suite is captured and immediately updated"), not
 * only when a job moved stage, and must stay quiet when nothing changed, or
 * every open page would re-read on every 5-minute pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/redis.js', () => ({
  getCacheRedis: () => null,
  getQueueRedis: () => null,
  isRedisConfigured: () => false,
  CACHE_DB: 0, QUEUE_DB: 1,
  disconnectRedis: async () => {},
}))
vi.mock('../../src/lib/sse.js', () => ({ emitDashboardRepairChanged: vi.fn() }))

import { prismaMock, resetPrismaMock } from '../../src/lib/__mocks__/prisma.js'
import { emitDashboardRepairChanged } from '../../src/lib/sse.js'
import { syncJobCards, syncParts, syncRequisitions } from '../../src/modules/repairs/factorysuite-workshop.sync.js'
import { jobCardColumns, partColumns } from '../../src/providers/raifactorysuite/raifactorysuite.workshop.js'
import type { RaiFactorySuiteJobCardRow, RaiFactorySuitePartRow } from '../../src/providers/raifactorysuite/raifactorysuite.client.js'

const ORG = 'org-kasulu'
const FACTORY = 'MUFINDI PAPER MILLS'
const emit = vi.mocked(emitDashboardRepairChanged)
/* eslint-disable @typescript-eslint/no-explicit-any */
const m = prismaMock as any

// A machine we do not track: the card is stored, no job is made, so before
// this fix nothing ever told the open pages.
const card: RaiFactorySuiteJobCardRow = {
  id: 'jc-1', factoryCode: FACTORY, cardNumber: `${FACTORY}-JC-2026-0300`, machine: 'KSPBUS-01',
  status: 'IN_PROGRESS', checkedInAt: '2026-11-20T08:00:00', reportedFault: 'Engine problem', diagnosis: null,
}
const part: RaiFactorySuitePartRow = {
  id: 'p-1', factoryCode: FACTORY, partNumber: 'FLT-001', description: 'Oil filter', unit: 'pcs',
  quantityOnHand: 4, minimumLevel: 2, unitCost: null, supplier: null, active: true,
}

beforeEach(() => {
  resetPrismaMock()
  emit.mockReset()
  m.organisation.findUnique.mockResolvedValue({ id: ORG })
  m.vehicle.findMany.mockResolvedValue([])
})

describe('job cards', () => {
  it('a card that changed without a job tells its org', async () => {
    m.factorySuiteJobCard.findMany.mockResolvedValue([])
    m.factorySuiteJobCard.findUnique.mockResolvedValue(null)
    await syncJobCards([card], { silent: false })
    expect(m.factorySuiteJobCard.upsert).toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(ORG)
  })

  it('an unchanged card tells nobody', async () => {
    const stored = { id: card.id, ...jobCardColumns(card, ORG, null), raw: card, repairItemId: null, appliedStage: null }
    m.factorySuiteJobCard.findMany.mockResolvedValue([stored])
    await syncJobCards([card], { silent: false })
    expect(m.factorySuiteJobCard.upsert).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('parts', () => {
  const storedPart = (p: RaiFactorySuitePartRow) => {
    const { ...cols } = partColumns(p, ORG)
    return { id: p.id, ...cols }
  }

  it('a stock count that moved tells the org', async () => {
    m.factorySuitePart.findMany.mockResolvedValue([storedPart({ ...part, quantityOnHand: 9 })])
    m.factorySuitePart.deleteMany.mockResolvedValue({ count: 0 })
    await syncParts([part])
    expect(emit).toHaveBeenCalledWith(ORG)
  })

  it('a part FactorySuite stopped serving tells the org', async () => {
    m.factorySuitePart.findMany.mockResolvedValue([storedPart(part)])
    m.factorySuitePart.deleteMany.mockResolvedValue({ count: 1 })
    await syncParts([part])
    expect(emit).toHaveBeenCalledWith(ORG)
  })

  it('the same catalogue tells nobody', async () => {
    m.factorySuitePart.findMany.mockResolvedValue([storedPart(part)])
    m.factorySuitePart.deleteMany.mockResolvedValue({ count: 0 })
    await syncParts([part])
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('requisitions', () => {
  const req = { id: 'rq-1', factoryCode: FACTORY, status: 'RAISED', jobCardNumber: card.cardNumber }

  it('a new or changed requisition tells the org', async () => {
    m.factorySuiteRequisition.findMany.mockResolvedValue([{ id: req.id, raw: { ...req, status: 'DRAFT' } }])
    await syncRequisitions([req] as any)
    expect(emit).toHaveBeenCalledWith(ORG)
  })

  it('the same requisition tells nobody', async () => {
    m.factorySuiteRequisition.findMany.mockResolvedValue([{ id: req.id, raw: { ...req } }])
    await syncRequisitions([req] as any)
    expect(emit).not.toHaveBeenCalled()
  })
})
