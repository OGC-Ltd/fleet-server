/**
 * Wialon deltas: every message read, each row stamped when the tracker
 * recorded it.
 *
 * `avl_evts` hands over every message a tracker uploaded since the last call —
 * often several per unit, recorded over the last minute or two. These pin that
 * each is read in the order it was recorded, that each fix earning a row
 * becomes a frame at its own time with its own fuel and ignition, and that the
 * sweep never makes them look stale.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { messageTime, MESSAGE_CLOCK_AHEAD_S } from '../../src/providers/wialon/wialon.client.js'
import { WialonLiveAdapter, MIN_ROW_GAP_S } from '../../src/providers/wialon/wialon.adapter.js'

const T = 1_790_464_315 // unix seconds, 2026-09-27
const U = 30364291      // MUFINDI - EX 03

describe('messageTime', () => {
  it("uses the message's own time, not the batch's", () => {
    expect(messageTime(T, undefined, T + 104)).toEqual({ t: T, own: true })
  })

  it("falls back to the position's time where the message has none", () => {
    expect(messageTime(undefined, T, T + 10)).toEqual({ t: T, own: true })
  })

  it('lets the batch time stand in only when there is no other', () => {
    expect(messageTime(undefined, undefined, T)).toEqual({ t: T, own: false })
    expect(messageTime(null, 'x', T)).toEqual({ t: T, own: false })
  })

  it('keeps a backlog message at the hour it was recorded', () => {
    // A tracker out of coverage uploads its buffer when it comes back.
    expect(messageTime(T - 3 * 3600, undefined, T)).toEqual({ t: T - 3 * 3600, own: true })
  })

  it("disbelieves a tracker clock running ahead of Wialon's", () => {
    expect(messageTime(T + MESSAGE_CLOCK_AHEAD_S, undefined, T)).toEqual({ t: T + MESSAGE_CLOCK_AHEAD_S, own: true })
    expect(messageTime(T + MESSAGE_CLOCK_AHEAD_S + 1, undefined, T)).toEqual({ t: T, own: false })
  })

  it('believes the message when Wialon sent no batch time', () => {
    expect(messageTime(T, undefined, undefined)).toEqual({ t: T, own: true })
  })

  it('returns null when there is no time at all', () => {
    expect(messageTime(undefined, undefined, undefined)).toBeNull()
  })
})

describe('WialonLiveAdapter — one frame per message', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  /** A 100 L tank: raw 0–4000, 0.025 L a step. Raw 2000 is 50 L. */
  const SENSORS = {
    1: { n: 'Main Tank Fuel Level (100L)', t: 'fuel level', p: 'io_270', tbl: [{ x: 0, a: 0.025, b: 0 }, { x: 4000, a: 0.025, b: 0 }] },
  }
  const unit = (t: number, p: Record<string, unknown> = { io_270: 2000 }) =>
    ({ id: U, nm: 'MUFINDI - EX 03', sens: SENSORS, pos: { t, y: -8.6, x: 35.3, s: 0, c: 0, sc: 12 }, lmsg: { t, p } })
  /** One avl_evts message the way this subscription delivers it: `d` is the raw message, its position has no `t`. */
  const msg = (t: number, p: Record<string, unknown>, at: [number, number] | null = [-8.6 + t % 1000 * 1e-5, 35.3], s = 12) =>
    ({ i: U, t: 'm', d: { t, tp: 'ud', ...(at ? { pos: { y: at[0], x: at[1], s, c: 90, sc: 11 } } : {}), p } })

  /**
   * A fetch stub for the calls the adapter makes. `search_items` answers from
   * `sweeps` in turn (the last repeats) and each `avl_evts` from `batches` in
   * turn, then empty — the first `avl_evts` is the drain inside the first sweep.
   */
  function stubWialon(sweeps: unknown[][], batches: unknown[]) {
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
    let s = 0, b = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/avl_evts?')) return reply(batches[b++] ?? { tm: T + 999, events: [] })
      switch (new URL(url).searchParams.get('svc')) {
        case 'token/login':       return reply({ eid: 'sid-test', au: 'test' })
        case 'core/search_items': { const items = sweeps[Math.min(s++, sweeps.length - 1)]!; return reply({ items, totalItemsCount: items.length }) }
        default:                  return reply({})
      }
    }))
  }
  const EMPTY = { tm: T, events: [] }
  const secs = (f: { capturedAt: Date }) => f.capturedAt.getTime() / 1000

  it('stamps each message with the time the tracker recorded it, not when the batch arrived', async () => {
    stubWialon([[unit(T)]], [EMPTY, { tm: T + 150, events: [
      msg(T + 30, { io_270: 1990 }, [-8.601, 35.301]),
      msg(T + 60, { io_270: 1980 }, [-8.602, 35.302]),
      msg(T + 90, { io_270: 1970 }, [-8.603, 35.303]),
    ] }])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()                  // the sweep
    const frames = await adapter.fetchAll()   // one batch, three messages

    expect(frames.map(secs)).toEqual([T + 30, T + 60, T + 90])
    expect(frames.map(f => [f.lat, f.lng])).toEqual([[-8.601, 35.301], [-8.602, 35.302], [-8.603, 35.303]])
    expect(frames.map(f => f.fuelLevelMl)).toEqual([49_750, 49_500, 49_250])
    expect(frames.every(f => !('time' in (f.rawPayload as object)))).toBe(true)
  })

  it("reads each message's own fuel and ignition, carrying them only across a message without them", async () => {
    stubWialon([[unit(T, { io_270: 2400, io_239: 0 })]], [EMPTY, { tm: T + 100, events: [
      msg(T + 20, { io_270: 2000, io_239: 1 }),
      msg(T + 40, { io_239: 0 }),       // no probe value in this record
      msg(T + 60, { io_270: 1000 }),    // no ignition line in this one
    ] }])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    const [swept] = await adapter.fetchAll()
    expect(swept?.fuelLevelMl).toBe(60_000)
    const frames = await adapter.fetchAll()

    expect(frames.map(f => f.fuelLevelMl)).toEqual([50_000, 50_000, 25_000])
    expect(frames.map(f => f.engineOn)).toEqual([true, false, false])
    expect(frames.every(f => f.ignitionKnown)).toBe(true)
  })

  it('puts a batch in the order its messages were recorded', async () => {
    stubWialon([[unit(T)]], [EMPTY, { tm: T + 100, events: [
      msg(T + 90, { io_270: 1970 }), msg(T + 30, { io_270: 1990 }), msg(T + 60, { io_270: 1980 }),
    ] }])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()
    const frames = await adapter.fetchAll()
    expect(frames.map(secs)).toEqual([T + 30, T + 60, T + 90])
    expect(frames.map(f => f.fuelLevelMl)).toEqual([49_750, 49_500, 49_250])
  })

  it('drops a message no newer than the last fix, and does not let it wind the fuel back', async () => {
    stubWialon([[unit(T)]], [
      EMPTY,
      { tm: T + 70, events: [msg(T + 60, { io_270: 2000 })] },
      // Late and repeated: an older record, and the same one again.
      { tm: T + 80, events: [msg(T + 30, { io_270: 1000 }), msg(T + 60, { io_270: 2000 })] },
      { tm: T + 100, events: [msg(T + 90, { io_239: 1 })] },
    ])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()
    expect((await adapter.fetchAll()).map(secs)).toEqual([T + 60])
    expect(await adapter.fetchAll()).toEqual([])
    const [next] = await adapter.fetchAll()
    expect(secs(next!)).toBe(T + 90)
    expect(next!.fuelLevelMl).toBe(50_000)
  })

  it('counts the readings of a message with no fix toward the next frame', async () => {
    stubWialon([[unit(T)]], [EMPTY, { tm: T + 100, events: [
      msg(T + 30, { io_270: 2000 }),
      msg(T + 45, { io_270: 1800 }, null),   // no position in this record
      msg(T + 60, { io_239: 1 }),
    ] }])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()
    const frames = await adapter.fetchAll()
    expect(frames.map(secs)).toEqual([T + 30, T + 60])
    expect(frames.map(f => f.fuelLevelMl)).toEqual([50_000, 45_000])
  })

  it("lets the batch time stand in for a tracker clock running ahead, and marks the frame", async () => {
    stubWialon([[unit(T)]], [EMPTY, { tm: T + 100, events: [msg(T + 3600, { io_270: 2000 })] }])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()
    const [frame] = await adapter.fetchAll()
    expect(secs(frame!)).toBe(T + 100)
    expect(frame!.rawPayload).toMatchObject({ time: 'batch' })
  })

  it('keeps a probe fault until a message that reads the probe says otherwise', async () => {
    stubWialon([[unit(T)]], [EMPTY, { tm: T + 100, events: [
      msg(T + 20, { io_270: 4095 }),   // pegged at the line ceiling: a fault, no level
      msg(T + 40, { io_239: 1 }),      // says nothing about the probe
      msg(T + 60, { io_270: 2000 }),   // reads sanely again
    ] }])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()
    const frames = await adapter.fetchAll()
    expect(frames.map(f => f.flags.fuelProbeFault)).toEqual([true, true, false])
    expect(frames.map(f => f.fuelLevelMl)).toEqual([50_000, 50_000, 50_000])
  })

  it('drains the queue before the sweep, so the sweep never makes the messages behind its newest fix look stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T * 1000)
    // Second sweep: Wialon already has the fix at T+90, while its messages
    // from T+30 and T+60 are still in the event queue.
    stubWialon([[unit(T)], [unit(T + 90, { io_270: 1970 })]], [EMPTY, { tm: T + 150, events: [
      msg(T + 30, { io_270: 1990 }), msg(T + 60, { io_270: 1980 }), msg(T + 90, { io_270: 1970 }),
    ] }])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()
    vi.setSystemTime((T + 150) * 1000)       // past the 2-minute reconcile
    const frames = await adapter.fetchAll()

    expect(frames.map(secs)).toEqual([T + 30, T + 60, T + 90])
    expect(frames.map(f => f.fuelLevelMl)).toEqual([49_750, 49_500, 49_250])
  })

  it('still fills in from the sweep for a unit the events never mentioned', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T * 1000)
    stubWialon([[unit(T)], [unit(T + 90, { io_270: 1970 })]], [EMPTY, EMPTY])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()
    vi.setSystemTime((T + 150) * 1000)
    const frames = await adapter.fetchAll()
    expect(frames.map(secs)).toEqual([T + 90])
    expect(frames[0]!.fuelLevelMl).toBe(49_250)
  })

  it(`stores a fix every ${MIN_ROW_GAP_S} s at most, and every start, stop and ignition flip`, async () => {
    const here: [number, number] = [-8.6, 35.3]
    stubWialon([[unit(T, { io_270: 2000, io_239: 1 })]], [EMPTY, { tm: T + 100, events: [
      msg(T + 30, { io_270: 2000, io_239: 1 }),   // moves off: a row
      msg(T + 33, { io_270: 1900 }),              // 3 s on: read, no row
      msg(T + 36, { io_270: 1800 }),              // read, no row
      msg(T + 45, { io_239: 1 }),                 // 15 s on: a row, with the 1800 read above
      msg(T + 47, { io_239: 1 }, here, 0),        // stops: a row
      msg(T + 49, { io_239: 1 }, here, 0),        // no row
      msg(T + 50, { io_239: 0 }, here, 0),        // engine off: a row
      msg(T + 52, { io_239: 0 }, here, 0),        // no row
    ] }])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()
    const frames = await adapter.fetchAll()

    expect(frames.map(secs)).toEqual([T + 30, T + 45, T + 47, T + 50])
    expect(frames.map(f => f.fuelLevelMl)).toEqual([50_000, 45_000, 45_000, 45_000])
    expect(frames.map(f => f.engineOn)).toEqual([true, true, true, false])
    expect(frames.map(f => f.speedKmh)).toEqual([12, 12, 0, 0])
  })

  it('does not let the sweep write back a fix the thinning left out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T * 1000)
    stubWialon([[unit(T)], [unit(T + 35, { io_270: 1990 })]], [
      EMPTY,
      { tm: T + 40, events: [msg(T + 30, { io_270: 2000 }), msg(T + 35, { io_270: 1990 })] },
    ])
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()
    expect((await adapter.fetchAll()).map(secs)).toEqual([T + 30])
    vi.setSystemTime((T + 150) * 1000)
    expect(await adapter.fetchAll()).toEqual([])
  })
})
