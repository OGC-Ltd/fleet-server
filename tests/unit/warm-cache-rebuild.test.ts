/**
 * `rebuild`: build a key again now, because the caller knows its data changed.
 *
 * A build already running may have read the database before the change, so
 * joining it would hand back the old answer. rebuild waits for it and builds
 * once more; callers who ask during that wait share the one extra build.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { createWarmCache } from '../../src/lib/warm-cache.js'

describe('warm-cache rebuild', () => {
  it('builds again even when the key is fresh', async () => {
    let n = 0
    const cache = createWarmCache<string>({ name: 'rb1', compute: async (k) => `${k}:v${++n}` })

    expect(await cache.get('org')).toBe('org:v1')
    expect(await cache.rebuild('org')).toBe('org:v2')
    expect(await cache.get('org')).toBe('org:v2')
  })

  it('does not join a build already running: it builds once more after it', async () => {
    let n = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const cache = createWarmCache<string>({
      name: 'rb2',
      compute: async (k) => { const mine = ++n; if (mine === 1) await gate; return `${k}:v${mine}` },
    })

    const first = cache.get('org')        // build 1 starts, before the change
    const after = cache.rebuild('org')    // the change lands; ask again
    release()

    expect(await first).toBe('org:v1')
    expect(await after).toBe('org:v2')
    expect(n).toBe(2)
  })

  it('shares one follow-up build among everyone who asks during a running one', async () => {
    let n = 0
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const cache = createWarmCache<string>({
      name: 'rb3',
      compute: async (k) => { const mine = ++n; if (mine === 1) await gate; return `${k}:v${mine}` },
    })

    const first = cache.get('org')
    const asks = [cache.rebuild('org'), cache.rebuild('org'), cache.rebuild('org')]
    release()
    await first

    expect(await Promise.all(asks)).toEqual(['org:v2', 'org:v2', 'org:v2'])
    expect(n).toBe(2)
  })

  it('still builds again after a running build fails', async () => {
    let n = 0
    let fail!: () => void
    const gate = new Promise<void>((_, reject) => { fail = () => reject(new Error('timeout')) })
    const cache = createWarmCache<string>({
      name: 'rb4',
      compute: async (k) => { const mine = ++n; if (mine === 1) await gate; return `${k}:v${mine}` },
    })

    const first = cache.get('org').catch(() => 'failed')
    const after = cache.rebuild('org')
    fail()

    expect(await first).toBe('failed')
    expect(await after).toBe('org:v2')
  })
})
