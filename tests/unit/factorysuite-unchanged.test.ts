import { describe, expect, it } from 'vitest'
import { cardUnchanged, partColumns, partUnchanged, stableJson } from '../../src/providers/raifactorysuite/raifactorysuite.workshop.js'

const row = {
  id: 'c1', cardNumber: 'MUFINDI PAPER MILLS-JC-2026-0247', machine: 'EX-22', status: 'IN_PROGRESS',
  checkedInAt: '2026-11-17T16:34:03.198264', meterIn: 3823.4, fuelDiscrepancy: false, labourCost: null,
}
// What jsonb hands back: the same row with its keys in another order.
const stored = (over: Partial<{ raw: unknown; vehicleId: string | null; repairItemId: string | null; appliedStage: string | null }> = {}) => ({
  raw: Object.fromEntries(Object.entries(row).reverse()), vehicleId: 'v1', repairItemId: 'j1', appliedStage: 'fixing', ...over,
})

describe('stableJson', () => {
  it('ignores key order, at any depth', () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(stableJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }))
  })
  it('still tells values apart', () => {
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: '1' }))
    expect(stableJson({ a: null })).not.toBe(stableJson({}))
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]))
  })
})

describe('cardUnchanged', () => {
  it('skips a card stored with the same row, unit and stage', () => {
    expect(cardUnchanged(stored(), row, 'v1', 'fixing')).toBe(true)
  })
  it('syncs a card seen for the first time', () => {
    expect(cardUnchanged(undefined, row, 'v1', 'fixing')).toBe(false)
  })
  it('syncs a card whose row changed in FactorySuite', () => {
    expect(cardUnchanged(stored(), { ...row, status: 'AWAITING_PARTS' }, 'v1', 'fixing')).toBe(false)
    expect(cardUnchanged(stored(), { ...row, meterIn: 3830.1 }, 'v1', 'fixing')).toBe(false)
  })
  it('syncs a card whose machine now maps to another unit (or to one at all)', () => {
    expect(cardUnchanged(stored(), row, 'v2', 'fixing')).toBe(false)
    expect(cardUnchanged(stored({ vehicleId: null, repairItemId: null, appliedStage: null }), row, 'v1', 'fixing')).toBe(false)
  })
  it('syncs a card whose job is not at its stage yet', () => {
    expect(cardUnchanged(stored({ appliedStage: 'in_workshop' }), row, 'v1', 'fixing')).toBe(false)
  })
  it('skips a card with no job when none is due: untracked machine or cancelled', () => {
    expect(cardUnchanged(stored({ vehicleId: null, repairItemId: null, appliedStage: null }), row, null, 'fixing')).toBe(true)
    expect(cardUnchanged(stored({ repairItemId: null }), row, 'v1', 'void')).toBe(true)
  })
  it('retries a tracked card that should have a job and has none', () => {
    expect(cardUnchanged(stored({ repairItemId: null }), row, 'v1', 'fixing')).toBe(false)
  })
})

describe('partUnchanged', () => {
  const part = {
    id: 'p1', factoryCode: 'MUFINDI PAPER MILLS', partNumber: ' 0010-AB ', description: 'Filter', unit: 'PCS',
    quantityOnHand: 0, minimumLevel: 2, unitCost: null, supplier: null, active: true,
  }
  const cols = partColumns(part as never, 'org1')
  it('skips a part stored exactly as the feed gives it', () => {
    expect(partUnchanged({ ...cols }, cols)).toBe(true)
  })
  it('writes a new part or a changed count', () => {
    expect(partUnchanged(undefined, cols)).toBe(false)
    expect(partUnchanged({ ...cols, quantityOnHand: 4 }, cols)).toBe(false)
    expect(partUnchanged({ ...cols, active: false }, cols)).toBe(false)
  })
})
