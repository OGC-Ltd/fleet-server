/** The Wialon view's open / resolved and "faulty for" filters on one record (operator, 2026-11-27). */
import { describe, it, expect, vi } from 'vitest'
vi.mock('../../src/lib/prisma.js')
import { keepsEpisode } from '../../src/modules/incidents/incidents.repository.js'

const NOW = Date.parse('2026-11-27T12:00:00Z')
const H = 3_600_000
const open = (hoursAgo: number) => ({ startedAt: new Date(NOW - hoursAgo * H), recoveredAt: null })
const closed = (hours: number) => ({ startedAt: new Date(NOW - 100 * H), recoveredAt: new Date(NOW - 100 * H + hours * H) })

describe('keeping a record by the filters', () => {
  it('open and resolved', () => {
    expect(keepsEpisode(open(1), { state: 'open' }, NOW)).toBe(true)
    expect(keepsEpisode(closed(1), { state: 'open' }, NOW)).toBe(false)
    expect(keepsEpisode(closed(1), { state: 'resolved' }, NOW)).toBe(true)
    expect(keepsEpisode(open(1), { state: 'resolved' }, NOW)).toBe(false)
  })
  it('how long it lasted: to now while open, to recovery once closed', () => {
    expect(keepsEpisode(open(13), { minHours: 12 }, NOW)).toBe(true)
    expect(keepsEpisode(open(11), { minHours: 12 }, NOW)).toBe(false)
    expect(keepsEpisode(closed(30), { minHours: 24, maxHours: 48 }, NOW)).toBe(true)
    expect(keepsEpisode(closed(50), { minHours: 24, maxHours: 48 }, NOW)).toBe(false)
    expect(keepsEpisode(closed(2), {}, NOW)).toBe(true)
  })
})
