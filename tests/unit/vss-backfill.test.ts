/**
 * The vss-worker's back-fill (lib/queues/vss-backfill): past days never
 * captured, or cut short, are captured again, one lane per organisation,
 * oldest first in each, until VSS asks for a rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>()
  return { ...real, env: { ...real.env, VSS_BACKFILL_DAYS: 13, VSS_ORG_CONCURRENCY: 7 } }
})
const cap = vi.hoisted(() => ({
  held: new Map<string, Array<{ day: string; partial: boolean }>>(),
  calls: [] as string[],
  refuse: null as null | ((orgId: string, day: string) => boolean),
  active: 0,
  maxActive: 0,
}))
vi.mock('../../src/modules/dashcam/dashcam-capture.js', async (orig) => {
  const real = await orig<typeof import('../../src/modules/dashcam/dashcam-capture.js')>()
  const { VssError, VSS_TOO_FREQUENT } = await import('../../src/providers/vss/index.js')
  return {
    ...real,
    dashcamTablesReady: async () => true,
    organisationsWithCameras: async () => [{ id: 'o_a', code: 'AQUAMIST' }, { id: 'o_k', code: 'KABRAS' }, { id: 'o_m', code: 'MENENGAI' }],
    missedDays: async (orgId: string, days: string[]) => {
      const done = new Set((cap.held.get(orgId) ?? []).filter((h) => !h.partial).map((h) => h.day))
      return days.filter((d) => !done.has(d))
    },
    captureDay: async (orgId: string, day: string) => {
      cap.active++
      cap.maxActive = Math.max(cap.maxActive, cap.active)
      try {
        await new Promise((r) => setTimeout(r, 5))
        if (cap.refuse?.(orgId, day)) throw new VssError('Requests too frequent', VSS_TOO_FREQUENT)
        cap.calls.push(`${orgId}|${day}`)
        return { orgId, day, cameras: 1, alarms: 2, added: 2, typed: 0, untyped: 0, partial: false }
      } finally { cap.active-- }
    },
  }
})

const { runVssBackfill, setBackfillGap } = await import('../../src/lib/queues/vss-backfill.js')
const { lastDays } = await import('../../src/modules/dashcam/fleet-day.js')
const { inLanes } = await import('../../src/modules/dashcam/org-lanes.js')
const NOW = Date.parse('2026-11-26T12:00:00+03:00')
const window = lastDays(13, NOW)
const all = (except: string[] = []) => window.filter((d) => !except.includes(d)).map((day) => ({ day, partial: false }))
const of = (orgId: string) => cap.calls.filter((c) => c.startsWith(`${orgId}|`)).map((c) => c.split('|')[1])

beforeEach(() => {
  setBackfillGap(0, 0)
  cap.held.clear(); cap.calls = []; cap.refuse = null; cap.active = 0; cap.maxActive = 0
})

describe('VSS back-fill', () => {
  it('looks back 13 days, never today', () => {
    expect(window[0]).toBe('2026-11-13')
    expect(window.at(-1)).toBe('2026-11-25')
  })

  it('captures only the missed and partial days, oldest first in each organisation', async () => {
    cap.held.set('o_a', [...all(['2026-11-14', '2026-11-20']), { day: '2026-11-20', partial: true }])
    cap.held.set('o_k', all())
    cap.held.set('o_m', all(['2026-11-15', '2026-11-16']))
    const run = await runVssBackfill(NOW)
    expect(of('o_a')).toEqual(['2026-11-14', '2026-11-20'])
    expect(of('o_k')).toEqual([])
    expect(of('o_m')).toEqual(['2026-11-15', '2026-11-16'])
    expect(run.captured).toHaveLength(4)
    expect(run.left).toBe(0)
  })

  it('works on the organisations at the same time', async () => {
    for (const o of ['o_a', 'o_k', 'o_m']) cap.held.set(o, all(['2026-11-14', '2026-11-15']))
    await runVssBackfill(NOW)
    expect(cap.calls).toHaveLength(6)
    expect(cap.maxActive).toBe(3)
  })

  it('nothing missed: no capture at all', async () => {
    for (const o of ['o_a', 'o_k', 'o_m']) cap.held.set(o, all())
    const run = await runVssBackfill(NOW)
    expect(cap.calls).toEqual([])
    expect(run.captured).toEqual([])
  })

  it('when VSS asks for a rest every lane waits, then the same day is tried again', async () => {
    for (const o of ['o_a', 'o_k', 'o_m']) cap.held.set(o, all(['2026-11-14', '2026-11-15']))
    let refused = 0
    cap.refuse = (orgId, day) => orgId === 'o_a' && day === '2026-11-14' && refused++ === 0
    const run = await runVssBackfill(NOW)
    expect(run.rests).toBe(1)
    expect(of('o_a')).toEqual(['2026-11-14', '2026-11-15'])
    expect(cap.calls).toHaveLength(6)
    expect(run.failed).toEqual([])
    expect(run.left).toBe(0)
  })

  it('VSS still refusing after 8 rests: every lane stops, what is left is counted for the next run', async () => {
    for (const o of ['o_a', 'o_k', 'o_m']) cap.held.set(o, all(['2026-11-14', '2026-11-15', '2026-11-16']))
    cap.refuse = (orgId) => orgId === 'o_a'
    const run = await runVssBackfill(NOW)
    expect(run.rests).toBe(8)
    expect(of('o_a')).toEqual([])
    expect(run.failed.map((f) => f.org)).toEqual(['AQUAMIST'])
    expect(run.left).toBe(3 + (6 - cap.calls.length))   // all of AQUAMIST, and whatever the others had not reached
  })
})

describe('inLanes', () => {
  it('runs at most `limit` at a time and every item once', async () => {
    let active = 0, max = 0
    const seen: number[] = []
    await inLanes([1, 2, 3, 4, 5], 2, async (n) => {
      active++; max = Math.max(max, active)
      await new Promise((r) => setTimeout(r, 2))
      seen.push(n); active--
    })
    expect(max).toBe(2)
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })
})
