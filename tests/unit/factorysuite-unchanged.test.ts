import { describe, expect, it } from 'vitest'
import { cardUnchanged, jobCardColumns, partColumns, partUnchanged, stableJson } from '../../src/providers/raifactorysuite/raifactorysuite.workshop.js'

const row = {
  id: 'c1', factoryCode: 'MUFINDI PAPER MILLS', cardNumber: 'MUFINDI PAPER MILLS-JC-2026-0247', machine: 'EX-22',
  status: 'IN_PROGRESS', priority: 'NORMAL', checkedInAt: '2026-11-17T16:34:03.198264', meterReadingIn: 3823.4,
  fuelDiscrepancy: false, labourCost: null,
}
const colsFor = (r: object, vehicleId: string | null = 'v1', orgId = 'org1') => jobCardColumns(r as never, orgId, vehicleId)
const cols = colsFor(row)
// What the database hands back: the columns as written (dates as new Date
// objects), and the raw row from jsonb with its keys in another order.
const stored = (over: Record<string, unknown> = {}) => ({
  ...colsFor(row), checkedInAt: new Date(cols.checkedInAt!.getTime()),
  raw: Object.fromEntries(Object.entries(row).reverse()), repairItemId: 'j1', appliedStage: 'fixing',
  syncedAt: new Date(0), firstSeenAt: new Date(0), ...over,
}) as never

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
    expect(cardUnchanged(stored(), row, cols, 'fixing')).toBe(true)
  })
  it('syncs a card seen for the first time', () => {
    expect(cardUnchanged(undefined, row, cols, 'fixing')).toBe(false)
  })
  it('syncs a card whose row changed in FactorySuite', () => {
    expect(cardUnchanged(stored(), { ...row, status: 'AWAITING_PARTS' }, colsFor({ ...row, status: 'AWAITING_PARTS' }), 'fixing')).toBe(false)
    expect(cardUnchanged(stored(), { ...row, meterReadingIn: 3830.1 }, colsFor({ ...row, meterReadingIn: 3830.1 }), 'fixing')).toBe(false)
  })
  it('syncs a card whose machine now maps to another unit (or to one at all)', () => {
    expect(cardUnchanged(stored(), row, colsFor(row, 'v2'), 'fixing')).toBe(false)
    expect(cardUnchanged(stored({ vehicleId: null, repairItemId: null, appliedStage: null }), row, cols, 'fixing')).toBe(false)
  })
  it('syncs a card whose job is not at its stage yet', () => {
    expect(cardUnchanged(stored({ appliedStage: 'in_workshop' }), row, cols, 'fixing')).toBe(false)
  })
  it('skips a card with no job when none is due: untracked machine or cancelled', () => {
    expect(cardUnchanged(stored({ vehicleId: null, repairItemId: null, appliedStage: null }), row, colsFor(row, null), 'fixing')).toBe(true)
    expect(cardUnchanged(stored({ repairItemId: null }), row, cols, 'void')).toBe(true)
  })
  it('rewrites a card the feed did not touch when OUR mapping of it changed', () => {
    // A time stored before a fix to how FactorySuite times are read.
    expect(cardUnchanged(stored({ checkedInAt: new Date('2026-11-17T16:34:03.198Z') }), row, cols, 'fixing')).toBe(false)
    // The factory now belongs to another organisation.
    expect(cardUnchanged(stored(), row, colsFor(row, 'v1', 'org2'), 'fixing')).toBe(false)
    // Priority stored in the feed's own wording, before it was normalised.
    expect(cardUnchanged(stored({ priority: 'NORMAL' }), row, cols, 'fixing')).toBe(false)
  })
  it('compares stored dates by instant, not by object', () => {
    expect(cardUnchanged(stored({ checkedInAt: new Date(cols.checkedInAt!.getTime()) }), row, cols, 'fixing')).toBe(true)
  })
  it('retries a tracked card that should have a job and has none', () => {
    expect(cardUnchanged(stored({ repairItemId: null }), row, cols, 'fixing')).toBe(false)
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
