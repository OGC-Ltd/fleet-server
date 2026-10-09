import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
vi.mock('../../src/lib/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ur-store-'))
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

/** The store module as a freshly started server would load it. */
async function boot() {
  vi.resetModules()
  vi.stubEnv('USAGE_REVIEW_CACHE_DIR', dir)
  return import('../../src/modules/usage-review/usage-review.store.js')
}

describe('persistentStore', () => {
  it('keeps answers across a restart, and forgets the expired', async () => {
    const a = await boot()
    const s = a.persistentStore<{ name: string } | null>('t1', { hitTtlMs: 60_000, missTtlMs: 1, max: 10 })
    s.set('0.5000,34.5000', { name: 'Sammart Supermarket' })
    s.set('0.6000,34.6000', null)
    a.flushStores()
    expect(fs.existsSync(path.join(dir, 't1.json'))).toBe(true)

    const b = await boot()
    const t = b.persistentStore<{ name: string } | null>('t1', { hitTtlMs: 60_000, missTtlMs: 1, max: 10 })
    expect(t.get('0.5000,34.5000')).toEqual({ name: 'Sammart Supermarket' })
    await new Promise(r => setTimeout(r, 5))
    expect(t.has('0.6000,34.6000')).toBe(false)
  })
  it('holds no more than its limit, dropping the oldest', async () => {
    const a = await boot()
    const s = a.persistentStore<number>('t2', { hitTtlMs: 60_000, missTtlMs: 60_000, max: 2 })
    s.set('a', 1); s.set('b', 2); s.set('c', 3)
    expect([s.has('a'), s.get('b'), s.get('c'), s.size]).toEqual([false, 2, 3, 2])
  })
  it('starts empty from an unreadable file', async () => {
    fs.writeFileSync(path.join(dir, 't3.json'), '{ not json')
    const a = await boot()
    expect(a.persistentStore('t3', { hitTtlMs: 1, missTtlMs: 1, max: 1 }).size).toBe(0)
  })
})
