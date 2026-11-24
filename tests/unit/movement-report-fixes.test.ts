/**
 * Where each unit was at the start and the end of a Movements window
 * (reports/movement-report.service): one indexed look per unit, never one
 * search over every fleet's fixes (2026-11-24: a past hour took about a minute
 * and came back empty past the proxy's 30 s).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
import { prismaMock } from '../helpers/prisma.mock.js'
const { lastFixesAt, firstFixesIn } = await import('../../src/modules/reports/movement-report.service.js')

const calls: { sql: string; values: unknown[] }[] = []
let answer: unknown[] = []
const H = 3_600_000
const TO = Date.parse('2026-11-24T15:00:00+03:00')
const sqlOf = (strings: TemplateStringsArray) => strings.join('?').replace(/\s+/g, ' ')

beforeEach(() => {
  calls.length = 0
  answer = []
  ;(prismaMock.$queryRaw as any).mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: sqlOf(strings), values })
    return Promise.resolve(answer)
  })
})

describe('the end of a past window: each unit’s last fix', () => {
  it('looks per unit, back from the end, one fix each, within the week', async () => {
    answer = [{ vehicle_id: 'v1', lat: 0.5, lng: 34.6, speed_kmh: 0, captured_at: new Date(TO - 5 * 60_000) }]
    const got = await lastFixesAt(['v1', 'v2'], TO, 'org')
    const { sql, values } = calls[0]
    expect(sql).toContain('FROM unnest(?::text[]) AS v(id) CROSS JOIN LATERAL')
    expect(sql).toContain('WHERE vehicle_id = v.id')
    expect(sql).toContain('ORDER BY captured_at DESC LIMIT 1')
    expect(sql).not.toContain('DISTINCT ON')
    expect(values).toEqual([['v1', 'v2'], new Date(TO), new Date(TO - 7 * 24 * H)])
    expect(got.get('v1')).toEqual({ lat: 0.5, lng: 34.6, speedKmh: 0, at: TO - 5 * 60_000 })
    expect(got.has('v2')).toBe(false)
  })

  it('asks nothing for no units, and a failed read leaves the units without a fix', async () => {
    expect((await lastFixesAt([], TO, 'org')).size).toBe(0)
    expect(calls).toHaveLength(0)
    ;(prismaMock.$queryRaw as any).mockImplementation(() => Promise.reject(new Error('timeout')))
    expect((await lastFixesAt(['v1'], TO, 'org')).size).toBe(0)
  })
})

describe('the start of a window: each unit’s first fix in it', () => {
  it('looks per unit, forward from the start, one fix each, inside the window only', async () => {
    answer = [{ vehicle_id: 'v1', lat: 0.4, lng: 34.5 }]
    const got = await firstFixesIn(['v1'], TO - H, TO, 'org')
    const { sql, values } = calls[0]
    expect(sql).toContain('CROSS JOIN LATERAL')
    expect(sql).toContain('ORDER BY captured_at ASC LIMIT 1')
    expect(sql).not.toContain('DISTINCT ON')
    expect(values).toEqual([['v1'], new Date(TO - H), new Date(TO)])
    expect(got).toEqual([{ vehicle_id: 'v1', lat: 0.4, lng: 34.5 }])
  })

  it('asks nothing for no units, and a failed read gives no directions rather than an error', async () => {
    expect(await firstFixesIn([], TO - H, TO, 'org')).toEqual([])
    expect(calls).toHaveLength(0)
    ;(prismaMock.$queryRaw as any).mockImplementation(() => Promise.reject(new Error('timeout')))
    expect(await firstFixesIn(['v1'], TO - H, TO, 'org')).toEqual([])
  })
})
