import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CpuPool, PoolBusyError, TaskAbortedError, TaskTimeoutError } from '../../src/lib/offload/cpu-pool.js'
import { TaskError } from '../../src/lib/offload/cpu-tasks.js'

// Real worker threads (started with tsx, as under `npm run dev`). Most tests
// share one pool: starting a thread is the expensive part, and a suite that
// starts many slows every other file running beside it.
let shared: CpuPool
beforeAll(() => { shared = new CpuPool({ size: 1, maxQueue: 4, timeoutMs: 30_000 }) })
afterAll(async () => { await shared.close() })
let pool: CpuPool | null = null
afterEach(async () => { await pool?.close(); pool = null })

/** The longest the event loop was held while `p` ran, sampled every 5 ms. */
async function worstLag<T>(p: Promise<T>): Promise<{ value: T; lagMs: number }> {
  let worst = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - 5)
    last = now
  }, 5)
  try {
    return { value: await p, lagMs: worst }
  } finally {
    clearInterval(timer)
  }
}

describe('CpuPool', () => {
  it('runs a task on a thread while the event loop stays free', async () => {
    // Warm the thread up first: its start-up (tsx compiling the worker) is not the point here
    await shared.run('test.spin', { ms: 1 })
    const { value, lagMs } = await worstLag(shared.run('test.spin', { ms: 400 }))
    expect([...value]).toEqual([1, 2, 3])
    // 400 ms of synchronous work on the thread; the loop never waits anywhere near that
    expect(lagMs).toBeLessThan(100)
  }, 60_000)

  it('runs at most `size` at once and refuses beyond the queue', async () => {
    pool = new CpuPool({ size: 1, maxQueue: 1, timeoutMs: 30_000 })
    const started: number[] = []
    const a = pool.run('test.spin', { ms: 200 }, { onStart: () => started.push(1) })
    const b = pool.run('test.spin', { ms: 10 }, { onStart: () => started.push(2) })
    expect(pool.stats()).toMatchObject({ running: 1, queued: 1 })
    await expect(pool.run('test.spin', { ms: 10 })).rejects.toBeInstanceOf(PoolBusyError)
    await Promise.all([a, b])
    expect(started).toEqual([1, 2])
  }, 60_000)

  it('stops a task past its deadline, and the next one still runs', async () => {
    await expect(shared.run('test.spin', { ms: 5_000 }, { timeoutMs: 300 })).rejects.toBeInstanceOf(TaskTimeoutError)
    await expect(shared.run('test.spin', { ms: 1 })).resolves.toBeInstanceOf(Uint8Array)
  }, 60_000)

  it('drops a queued task whose deadline passes before it starts', async () => {
    const long = shared.run('test.spin', { ms: 600 })
    let started = false
    const late = shared.run('test.spin', { ms: 1 }, { timeoutMs: 200, onStart: () => { started = true } })
    await expect(late).rejects.toBeInstanceOf(TaskTimeoutError)
    await long
    expect(started).toBe(false)
  }, 60_000)

  it('cancels a running task when its signal aborts (the client went away)', async () => {
    await shared.run('test.spin', { ms: 1 })
    const ac = new AbortController()
    const t0 = Date.now()
    const p = shared.run('test.spin', { ms: 10_000 }, { signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    await expect(p).rejects.toBeInstanceOf(TaskAbortedError)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(shared.stats().running).toBe(0)
    await expect(shared.run('test.spin', { ms: 1 })).resolves.toBeInstanceOf(Uint8Array)
  }, 60_000)

  it("carries a task's own error and status back", async () => {
    const err = await shared.run('test.spin', { ms: 1, fail: 'no rows' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TaskError)
    expect(err).toMatchObject({ message: 'no rows', status: 422 })
  }, 60_000)

  it('fails only the task whose thread runs out of memory', async () => {
    pool = new CpuPool({ size: 1, maxQueue: 4, timeoutMs: 60_000, maxOldGenerationSizeMb: 64 })
    const err = await pool.run('test.spin', { ms: 1, bytes: 1 }).catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 413 })
    await expect(pool.run('test.spin', { ms: 1 })).resolves.toBeInstanceOf(Uint8Array)
  }, 90_000)

  it('runs on the calling thread in inline mode', async () => {
    pool = new CpuPool({ size: 1, maxQueue: 0, timeoutMs: 5_000, inline: true })
    await expect(pool.run('test.spin', { ms: 1 })).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })
})
