/**
 * The vss-worker's back-fill (lib/queues/vss-backfill): past days never
 * captured, or cut short, are captured again, oldest first, until VSS asks
 * for a rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
const cap = vi.hoisted(() => ({
  held: new Map<string, Array<{ day: string; partial: boolean }>>(),
  calls: [] as string[],
  refuseAt: -1,
}))
vi.mock('../../src/modules/dashcam/dashcam-capture.js', async (orig) => {
  const real = await orig<typeof import('../../src/modules/dashcam/dashcam-capture.js')>()
  const { VssError, VSS_TOO_FREQUENT } = await import('../../src/providers/vss/index.js')
  return {
    ...real,
    dashcamTablesReady: async () => true,
    organisationsWithCameras: async () => [{ id: 'o_a', code: 'AQUAMIST' }, { id: 'o_m', code: 'MENENGAI' }],
    missedDays: async (orgId: string, days: string[]) => {
      const done = new Set((cap.held.get(orgId) ?? []).filter((h) => !h.partial).map((h) => h.day))
      return days.filter((d) => !done.has(d))
    },
    captureDay: async (orgId: string, day: string) => {
      if (cap.calls.length === cap.refuseAt) throw new VssError('Requests too frequent', VSS_TOO_FREQUENT)
      cap.calls.push(`${orgId}|${day}`)
      return { orgId, day, cameras: 1, alarms: 2, added: 2, typed: 0, untyped: 0, partial: false }
    },
  }
})

const { runVssBackfill, setBackfillGap } = await import('../../src/lib/queues/vss-backfill.js')
const { lastDays } = await import('../../src/modules/dashcam/fleet-day.js')
const NOW = Date.parse('2026-11-26T12:00:00+03:00')
const window = lastDays(13, NOW)
const all = (orgId: string, except: string[] = []) => window.filter((d) => !except.includes(d)).map((day) => ({ day, partial: false }))

beforeEach(() => {
  setBackfillGap(0)
  cap.held.clear(); cap.calls = []; cap.refuseAt = -1
})

describe('VSS back-fill', () => {
  it('looks back 13 days, never today', () => {
    expect(window[0]).toBe('2026-11-13')
    expect(window.at(-1)).toBe('2026-11-25')
  })

  it('captures only the missed and partial days, oldest first across organisations', async () => {
    cap.held.set('o_a', [...all('o_a', ['2026-11-14', '2026-11-20']), { day: '2026-11-20', partial: true }])
    cap.held.set('o_m', all('o_m', ['2026-11-15']))
    const run = await runVssBackfill(NOW)
    expect(cap.calls).toEqual(['o_a|2026-11-14', 'o_m|2026-11-15', 'o_a|2026-11-20'])
    expect(run.captured).toHaveLength(3)
    expect(run.left).toBe(0)
  })

  it('nothing missed: no capture at all', async () => {
    cap.held.set('o_a', all('o_a'))
    cap.held.set('o_m', all('o_m'))
    const run = await runVssBackfill(NOW)
    expect(cap.calls).toEqual([])
    expect(run.captured).toEqual([])
  })

  it('stops when VSS asks for a rest and counts what is left for the next run', async () => {
    cap.held.set('o_a', all('o_a', ['2026-11-14', '2026-11-15', '2026-11-16']))
    cap.held.set('o_m', all('o_m'))
    cap.refuseAt = 1
    const run = await runVssBackfill(NOW)
    expect(cap.calls).toEqual(['o_a|2026-11-14'])
    expect(run.failed).toHaveLength(1)
    expect(run.left).toBe(2)
  })
})
