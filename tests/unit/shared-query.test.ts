/**
 * One run per question across callers (lib/shared-query). On 2026-11-24 three
 * warm caches started the same "distance covered today" statement in the same
 * second; this is what makes the second and third callers wait on the first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sharedQuery } from '../../src/lib/shared-query.js'

describe('sharedQuery', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('gives callers asking the same question while it runs the same run', async () => {
    let release!: (v: number) => void
    const run = vi.fn(() => new Promise<number>(r => { release = r }))
    const q = sharedQuery((k: string) => k, run, { ttlMs: 45_000 })
    const a = q('org-1'), b = q('org-1'), c = q('org-1')
    expect(run).toHaveBeenCalledTimes(1)
    release(7)
    expect(await Promise.all([a, b, c])).toEqual([7, 7, 7])
  })

  it('runs a different question on its own', async () => {
    const run = vi.fn(async (k: string) => k.length)
    const q = sharedQuery((k: string) => k, run, { ttlMs: 45_000 })
    await Promise.all([q('a'), q('bb')])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('hands out a settled result until the ttl, then runs again', async () => {
    let n = 0
    const q = sharedQuery((k: string) => k, async () => ++n, { ttlMs: 45_000 })
    expect(await q('k')).toBe(1)
    vi.advanceTimersByTime(44_000)
    expect(await q('k')).toBe(1)
    vi.advanceTimersByTime(2_000)
    expect(await q('k')).toBe(2)
  })

  it('never keeps a failure', async () => {
    let n = 0
    const q = sharedQuery((k: string) => k, async () => {
      if (++n === 1) throw new Error('canceling statement due to statement timeout')
      return n
    }, { ttlMs: 45_000 })
    await expect(q('k')).rejects.toThrow('statement timeout')
    expect(await q('k')).toBe(2)
  })

  it('keeps no more than maxEntries', async () => {
    const run = vi.fn(async (k: string) => k)
    const q = sharedQuery((k: string) => k, run, { ttlMs: 45_000, maxEntries: 2 })
    await q('a'); await q('b'); await q('c')
    await q('a')
    expect(run).toHaveBeenCalledTimes(4)
  })
})
