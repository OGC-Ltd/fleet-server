/**
 * The incidents service — the guards around the reports.
 *
 * Two of these are about refusing to answer. An unbounded or year-plus range
 * over a table that collects a row per speeding episode across ~1,500 units is
 * a request to make impossible, not one to serve slowly; and a malformed cursor
 * that quietly restarts at page one is how a "Load more" button ends up looping
 * over the same fifty rows forever.
 *
 * The third is the one that would produce a WRONG NUMBER rather than a slow
 * one: "vs last month" has to distinguish "no incidents last month" from "we
 * were not recording last month". Rendering the second as a 100% improvement is
 * the classic version of this bug.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/modules/incidents/incidents.repository.js', () => ({
  speedingSummary:   vi.fn(),
  speedingList:      vi.fn(),
  speedingInsights:  vi.fn(),
  speedingPrevCount: vi.fn(),
  faultSummary:      vi.fn(),
  faultList:         vi.fn(),
  faultInsights:     vi.fn(),
  captureStart:      vi.fn(),
}))

const repo    = await import('../../src/modules/incidents/incidents.repository.js')
const service = await import('../../src/modules/incidents/incidents.service.js')

const ORG = 'org1'
const from = new Date('2026-09-01T00:00:00Z')
const to   = new Date('2026-09-30T23:59:59Z')
const base = { from, to, sort: 'count' as const, limit: 50 }

beforeEach(() => {
  vi.mocked(repo.speedingSummary).mockResolvedValue({ rows: [], hasNextPage: false })
  vi.mocked(repo.speedingInsights).mockResolvedValue({
    incidents: 10, units: 3, peakKmh: 120, totalSeconds: 600,
    medianDurationSec: 45, repeatUnits: 2,
    hourHistogram: Array(24).fill(0), dowHistogram: Array(7).fill(0),
    worstByCount: null, worstByPeak: null,
  })
  vi.mocked(repo.captureStart).mockResolvedValue({ speeding: from, faults: from })
  vi.mocked(repo.speedingPrevCount).mockResolvedValue(null)
})

describe('the range is bounded', () => {
  it('refuses a span longer than a year', async () => {
    await expect(service.speedingSummary(ORG, {
      ...base, from: new Date('2025-01-01'), to: new Date('2026-06-01'),
    })).rejects.toThrow(/366 days/)
  })

  it('refuses a range that runs backwards', async () => {
    await expect(service.speedingSummary(ORG, { ...base, from: to, to: from }))
      .rejects.toThrow(/must not be before/)
  })

  it('accepts a month', async () => {
    await expect(service.speedingSummary(ORG, base)).resolves.toBeDefined()
    expect(repo.speedingSummary).toHaveBeenCalledWith(ORG, { from, to }, expect.objectContaining({ sort: 'count' }))
  })
})

describe('the aggregate cursor is an offset', () => {
  it('advances by the rows returned and stops at the end', async () => {
    vi.mocked(repo.speedingSummary).mockResolvedValue({
      rows: Array.from({ length: 50 }, (_, i) => ({ vehicleId: `v${i}` })) as never,
      hasNextPage: true,
    })
    const page1 = await service.speedingSummary(ORG, base)
    expect(page1.cursor).toBe('50')

    vi.mocked(repo.speedingSummary).mockResolvedValue({
      rows: [{ vehicleId: 'v50' }] as never, hasNextPage: false,
    })
    const page2 = await service.speedingSummary(ORG, { ...base, cursor: '50' })
    expect(repo.speedingSummary).toHaveBeenLastCalledWith(ORG, { from, to }, expect.objectContaining({ offset: 50 }))
    // Nothing further: a cursor here would page forever.
    expect(page2.cursor).toBeNull()
  })

  it('rejects a malformed cursor rather than silently restarting', async () => {
    await expect(service.speedingSummary(ORG, { ...base, cursor: 'abc' }))
      .rejects.toThrow(/invalid cursor/)
    await expect(service.speedingSummary(ORG, { ...base, cursor: '-1' }))
      .rejects.toThrow(/invalid cursor/)
  })
})

describe('"vs last month" tells absence from zero', () => {
  it('is null when there is no history that far back', async () => {
    vi.mocked(repo.speedingPrevCount).mockResolvedValue(null)
    const out = await service.speedingInsights(ORG, { from, to })
    // The UI renders "no comparison yet". Zero here would read as a 100% drop.
    expect(out.monthOverMonth).toBeNull()
  })

  it('reports a real change when there is', async () => {
    vi.mocked(repo.speedingPrevCount).mockResolvedValue(20)
    const out = await service.speedingInsights(ORG, { from, to })
    expect(out.monthOverMonth).toEqual({ prevIncidents: 20, deltaPct: -50 })
  })

  it('does not divide by a zero previous month', async () => {
    vi.mocked(repo.speedingPrevCount).mockResolvedValue(0)
    const out = await service.speedingInsights(ORG, { from, to })
    expect(out.monthOverMonth).toEqual({ prevIncidents: 0, deltaPct: null })
  })

  it('carries the capture start so a short month can say why', async () => {
    const out = await service.speedingInsights(ORG, { from, to })
    expect(out.captureStartedAt).toEqual(from)
  })
})

describe('fault kinds', () => {
  it('splits a comma list and drops the blanks', async () => {
    vi.mocked(repo.faultSummary).mockResolvedValue({ rows: [], hasNextPage: false })
    await service.faultSummary(ORG, { ...base, kind: 'signal_lost, transit_no_engine ,' })
    expect(repo.faultSummary).toHaveBeenCalledWith(ORG, { from, to },
      expect.objectContaining({ kinds: ['signal_lost', 'transit_no_engine'] }))
  })

  it('passes undefined when no kind is asked for, not an empty list', async () => {
    vi.mocked(repo.faultSummary).mockResolvedValue({ rows: [], hasNextPage: false })
    await service.faultSummary(ORG, base)
    expect(repo.faultSummary).toHaveBeenCalledWith(ORG, { from, to },
      expect.objectContaining({ kinds: undefined }))
  })
})

describe('the detail list is per unit', () => {
  it('passes the vehicle through and keyset-pages on id', async () => {
    vi.mocked(repo.speedingList).mockResolvedValue({ data: [], cursor: null, hasNextPage: false })
    await service.speedingList(ORG, { from, to, vehicleId: 'veh1', limit: 50 })
    expect(repo.speedingList).toHaveBeenCalledWith(ORG, { from, to },
      expect.objectContaining({ vehicleId: 'veh1', limit: 50 }))
  })
})
