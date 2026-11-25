import { describe, it, expect } from 'vitest'
import { issueChunks, issueReadFrom, keptIssues, mergeIssues, ISSUES_FROM } from '../../src/modules/planner/fuel-issues.js'
import type { RaiFactorySuiteFuelIssueRow } from '../../src/providers/raifactorysuite/raifactorysuite.client.js'

const F = 'MUFINDI PAPER MILLS'
// EX-17 on 19 Nov: SIV-000027, 576 L.
const ex17: RaiFactorySuiteFuelIssueRow = {
  id: 'iss-27', machine: 'EX-17', issueDate: '2026-11-19', quantityIssued: 576, siv: ' SIV-000027 ',
  requestId: 'req-1', fuelingStart: '2026-11-19T08:31:00', fuelingEnd: '2026-11-19T08:44:00', completed: true,
  sensorBeforeLitres: 77, sensorAfterLitres: 641.9, sensorCheck: 'MATCH',
}

describe('Issued fuel kept', () => {
  it('keeps each issue with its litres, voucher and the whole row', () => {
    const [r] = keptIssues(F, 'org', [ex17])
    expect(r).toMatchObject({
      id: `${F}|iss-27`, organisationId: 'org', factoryCode: F, issueId: 'iss-27', day: '2026-11-19', machine: 'EX-17',
      requestId: 'req-1', siv: 'SIV-000027', litres: 576, fuelingStart: '2026-11-19T08:31:00', completed: true,
    })
    expect(r.row.sensorAfterLitres).toBe(641.9)
  })

  it('skips rows without an id, a machine or a day, and keeps a repeated id once', () => {
    const rows = keptIssues(F, 'org', [
      ex17, { ...ex17, quantityIssued: 580 },
      { ...ex17, id: '' }, { ...ex17, id: 'x', machine: '' }, { ...ex17, id: 'y', issueDate: '' },
    ])
    expect(rows.map(r => [r.issueId, r.litres])).toEqual([['iss-27', 580]])
  })

  it('keeps an issue with no litres as null, not 0', () => {
    expect(keptIssues(F, 'org', [{ ...ex17, quantityIssued: null }])[0].litres).toBeNull()
  })

  it('reads in chunks of at most 31 days', () => {
    expect(issueChunks('2026-11-09', '2026-11-26')).toEqual([{ from: '2026-11-09', to: '2026-11-26' }])
    expect(issueChunks('2026-11-01', '2026-12-15')).toEqual([
      { from: '2026-11-01', to: '2026-12-01' }, { from: '2026-12-02', to: '2026-12-15' },
    ])
  })

  it('reads the last three days, and on a first pass back to the last kept day', () => {
    expect(issueReadFrom('2026-11-26', '2026-11-26', false)).toBe('2026-11-24')
    expect(issueReadFrom('2026-11-26', null, true)).toBe(ISSUES_FROM)
    expect(issueReadFrom('2026-11-26', '2026-11-20', true)).toBe('2026-11-18')
    expect(issueReadFrom('2026-11-26', '2026-11-26', true)).toBe('2026-11-24')
    expect(issueReadFrom('2026-11-10', null, false)).toBe(ISSUES_FROM)
  })

  it('serves live rows over kept ones, and kept ones FactorySuite did not return', () => {
    const kept = [{ ...ex17, quantityIssued: 500 }, { ...ex17, id: 'iss-28', machine: 'EX-02' }]
    const out = mergeIssues([ex17], kept)
    expect(out.map(r => [r.id, r.quantityIssued]).sort()).toEqual([['iss-27', 576], ['iss-28', 576]])
    expect(mergeIssues([], kept)).toHaveLength(2)
  })
})
