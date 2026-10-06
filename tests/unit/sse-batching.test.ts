/**
 * Dashboard SSE delivery: batched per org, one write per client per flush, and
 * a heartbeat that reaches only its own connection.
 *
 * Bench 2026-10-06 (bench/realtime.mjs): the per-client heartbeat timer used to
 * broadcast to the whole org (N² writes — 1000 viewers froze the server for
 * 14 s), and every position went out as its own write per client (a 600-vehicle
 * tick to 3000 viewers froze it for ~7 s). These pin the fixes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Response } from 'express'

type FakeRes = { writes: (string | Buffer)[]; writableLength: number; ended: boolean; write: (c: string | Buffer) => boolean; end: () => void }
const fakeRes = (): FakeRes => {
  const r: FakeRes = {
    writes: [], writableLength: 0, ended: false,
    write(c) { r.writes.push(c); return true },
    end() { r.ended = true },
  }
  return r
}
const asRes = (r: FakeRes) => r as unknown as Response
const text = (r: FakeRes) => r.writes.map(String).join('')
const count = (r: FakeRes, event: string) => text(r).split(`event: ${event}\n`).length - 1

let sse: typeof import('../../src/lib/sse.js')

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  sse = await import('../../src/lib/sse.js')
})
afterEach(() => { vi.useRealTimers() })

describe('batched dashboard delivery', () => {
  it('sends a whole tick to each client in ONE write, frames unchanged', () => {
    const a = fakeRes(), b = fakeRes()
    sse.registerDashboardClient('org', asRes(a))
    sse.registerDashboardClient('org', asRes(b))
    for (let i = 0; i < 600; i++) sse.emitDashboardPosition('org', { vehicleId: `v${i}`, lat: i })
    expect(a.writes).toHaveLength(0)          // nothing until the flush
    vi.advanceTimersByTime(200)
    expect(a.writes).toHaveLength(1)
    expect(b.writes).toHaveLength(1)
    expect(a.writes[0]).toBe(b.writes[0])     // the same Buffer, encoded once
    expect(count(a, 'position')).toBe(600)
    expect(text(a)).toContain('event: position\ndata: {"vehicleId":"v0","lat":0}\n\n')
  })

  it('keeps event order across kinds', () => {
    const a = fakeRes()
    sse.registerDashboardClient('org', asRes(a))
    sse.emitDashboardPosition('org', { vehicleId: 'v1' })
    sse.emitDashboardAlert('org', { vehicleId: 'v1', type: 'x' })
    sse.emitDashboardFeed('org', { vehicleId: 'v1', id: 'f' })
    vi.advanceTimersByTime(200)
    const t = text(a)
    expect(t.indexOf('event: position')).toBeLessThan(t.indexOf('event: alert'))
    expect(t.indexOf('event: alert')).toBeLessThan(t.indexOf('event: feed'))
  })

  it('still filters a vehicle-scoped client, failing closed', () => {
    const scoped = fakeRes()
    sse.registerDashboardClient('org', asRes(scoped), { vehicleIds: new Set(['v1']) })
    sse.emitDashboardPosition('org', { vehicleId: 'v1' })
    sse.emitDashboardPosition('org', { vehicleId: 'v2' })
    sse.emitDashboardRepairChanged('org')      // names no vehicle → withheld
    vi.advanceTimersByTime(200)
    expect(count(scoped, 'position')).toBe(1)
    expect(text(scoped)).toContain('"vehicleId":"v1"')
    expect(text(scoped)).not.toContain('repair_changed')
  })

  it('does not send other orgs\' events', () => {
    const a = fakeRes()
    sse.registerDashboardClient('org', asRes(a))
    sse.emitDashboardPosition('other', { vehicleId: 'v1' })
    vi.advanceTimersByTime(200)
    expect(a.writes).toHaveLength(0)
  })

  it('a client joining mid-window gets only events after it joined', () => {
    const early = fakeRes(), late = fakeRes()
    sse.registerDashboardClient('org', asRes(early))
    sse.emitDashboardPosition('org', { vehicleId: 'before' })
    sse.registerDashboardClient('org', asRes(late))
    sse.emitDashboardPosition('org', { vehicleId: 'after' })
    vi.advanceTimersByTime(200)
    expect(count(early, 'position')).toBe(2)
    expect(count(late, 'position')).toBe(1)
    expect(text(late)).toContain('"vehicleId":"after"')
  })

  it('cuts loose a client that has fallen too far behind', () => {
    const slow = fakeRes(), ok = fakeRes()
    sse.registerDashboardClient('org', asRes(slow))
    sse.registerDashboardClient('org', asRes(ok))
    slow.writableLength = 5 * 1024 * 1024
    sse.emitDashboardPosition('org', { vehicleId: 'v1' })
    vi.advanceTimersByTime(200)
    expect(slow.ended).toBe(true)
    expect(slow.writes).toHaveLength(0)
    expect(ok.writes).toHaveLength(1)
    // …and it is out of the registry: the next tick does not touch it.
    sse.emitDashboardPosition('org', { vehicleId: 'v1' })
    vi.advanceTimersByTime(200)
    expect(slow.writes).toHaveLength(0)
  })
})

describe('replay on connect', () => {
  it('replays the last position of every vehicle in one write, scoped where needed', () => {
    const seed = fakeRes()
    sse.registerDashboardClient('org', asRes(seed))
    sse.emitDashboardPosition('org', { vehicleId: 'v1', n: 1 })
    sse.emitDashboardPosition('org', { vehicleId: 'v1', n: 2 })
    sse.emitDashboardPosition('org', { vehicleId: 'v2', n: 1 })

    const all = fakeRes()
    expect(sse.replayDashboardPositions('org', asRes(all))).toBe(2)
    expect(all.writes).toHaveLength(1)
    expect(text(all)).toContain('"n":2')
    expect(text(all)).not.toContain('"vehicleId":"v1","n":1')

    const scoped = fakeRes()
    expect(sse.replayDashboardPositions('org', asRes(scoped), new Set(['v2']))).toBe(1)
    expect(text(scoped)).not.toContain('"vehicleId":"v1"')
  })
})

describe('heartbeat', () => {
  it('writes to its own connection only', () => {
    const a = fakeRes(), b = fakeRes()
    sse.registerDashboardClient('org', asRes(a))
    sse.registerDashboardClient('org', asRes(b))
    sse.writeHeartbeat(asRes(a))
    vi.advanceTimersByTime(200)
    expect(count(a, 'heartbeat')).toBe(1)
    expect(b.writes).toHaveLength(0)
  })
})

describe('position deltas (/live?delta=1)', () => {
  const deltas = (r: FakeRes) => text(r).split('event: position_delta\ndata: ').slice(1)
    .map((s) => JSON.parse(s.slice(0, s.indexOf('\n\n'))) as Record<string, unknown>[])

  it('sends only the changed fields, one event per run of positions', () => {
    sse.emitDashboardPosition('org', { vehicleId: 'v1', plate: 'KXX 1', lat: 1, lng: 1, movement: { s: 'moving' } })
    sse.emitDashboardPosition('org', { vehicleId: 'v2', plate: 'KXX 2', lat: 5, lng: 5 })
    const d = fakeRes(), full = fakeRes()
    sse.registerDashboardClient('org', asRes(d), { delta: true })
    sse.registerDashboardClient('org', asRes(full))

    sse.emitDashboardPosition('org', { vehicleId: 'v1', plate: 'KXX 1', lat: 2, lng: 1, movement: { s: 'moving' } })
    sse.emitDashboardPosition('org', { vehicleId: 'v2', plate: 'KXX 2', lat: 5, lng: 5 })   // unchanged
    vi.advanceTimersByTime(200)

    expect(deltas(d)).toEqual([[{ vehicleId: 'v1', lat: 2 }]])
    expect(count(d, 'position')).toBe(0)
    // A client that did not ask keeps full frames, unchanged ones included.
    expect(count(full, 'position')).toBe(2)
    expect(text(full)).toContain('"plate":"KXX 1","lat":2')
  })

  it('names a field that disappeared rather than sending null', () => {
    sse.emitDashboardPosition('org', { vehicleId: 'v1', cargoWeightKg: 900, lat: 1 })
    const d = fakeRes()
    sse.registerDashboardClient('org', asRes(d), { delta: true })
    sse.emitDashboardPosition('org', { vehicleId: 'v1', lat: 1, speedKmh: null })
    vi.advanceTimersByTime(200)
    expect(deltas(d)).toEqual([[{ vehicleId: 'v1', speedKmh: null, $del: ['cargoWeightKg'] }]])
  })

  it('sends a nested object whole when anything inside it changed', () => {
    sse.emitDashboardPosition('org', { vehicleId: 'v1', movement: { s: 'moving', since: 'a' } })
    const d = fakeRes()
    sse.registerDashboardClient('org', asRes(d), { delta: true })
    sse.emitDashboardPosition('org', { vehicleId: 'v1', movement: { s: 'resting', since: 'b' } })
    vi.advanceTimersByTime(200)
    expect(deltas(d)).toEqual([[{ vehicleId: 'v1', movement: { s: 'resting', since: 'b' } }]])
  })

  it('a vehicle never seen before goes out whole', () => {
    const d = fakeRes()
    sse.registerDashboardClient('org', asRes(d), { delta: true })
    sse.emitDashboardPosition('org', { vehicleId: 'new', plate: 'KNEW', lat: 3 })
    vi.advanceTimersByTime(200)
    expect(deltas(d)).toEqual([[{ vehicleId: 'new', plate: 'KNEW', lat: 3 }]])
  })

  it('keeps other events in order between runs of positions', () => {
    sse.emitDashboardPosition('org', { vehicleId: 'v1', lat: 1 })
    const d = fakeRes()
    sse.registerDashboardClient('org', asRes(d), { delta: true })
    sse.emitDashboardPosition('org', { vehicleId: 'v1', lat: 2 })
    sse.emitDashboardAlert('org', { vehicleId: 'v1', type: 'x' })
    sse.emitDashboardPosition('org', { vehicleId: 'v1', lat: 3 })
    vi.advanceTimersByTime(200)
    const t = text(d)
    const a = t.indexOf('"lat":2'), b = t.indexOf('event: alert'), c = t.indexOf('"lat":3')
    expect(a).toBeGreaterThan(-1)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
  })

  it('still filters a scoped delta client', () => {
    sse.emitDashboardPosition('org', { vehicleId: 'v1', lat: 1 })
    sse.emitDashboardPosition('org', { vehicleId: 'v2', lat: 1 })
    const d = fakeRes()
    sse.registerDashboardClient('org', asRes(d), { delta: true, vehicleIds: new Set(['v2']) })
    sse.emitDashboardPosition('org', { vehicleId: 'v1', lat: 9 })
    sse.emitDashboardPosition('org', { vehicleId: 'v2', lat: 8 })
    vi.advanceTimersByTime(200)
    expect(deltas(d)).toEqual([[{ vehicleId: 'v2', lat: 8 }]])
  })

  it('writes nothing to a delta client when no vehicle changed', () => {
    sse.emitDashboardPosition('org', { vehicleId: 'v1', lat: 1 })
    const d = fakeRes()
    sse.registerDashboardClient('org', asRes(d), { delta: true })
    sse.emitDashboardPosition('org', { vehicleId: 'v1', lat: 1 })
    vi.advanceTimersByTime(200)
    expect(d.writes).toHaveLength(0)
  })
})
