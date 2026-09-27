/**
 * Accelerometer ingest: Teltonika AVL 17/18/19 off Wialon messages, into g.
 *
 * Every value below was seen on the live account on 2026-09-27 — the units are
 * named — except where a case says it is testing a guard.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readAccelerometer } from '../../src/providers/wialon/wialon.sensors.js'
import { accelColumns } from '../../src/modules/ingest/ingest.service.js'
import { WialonLiveAdapter } from '../../src/providers/wialon/wialon.adapter.js'
import type { TelemetryPayload } from '../../src/modules/ingest/ingest.schema.js'

describe('readAccelerometer', () => {
  it('reads axes Wialon already sends in g', () => {
    // MUFINDI - EX 03, parked: a constant offset, which is what this unit reads.
    expect(readAccelerometer({ io_17: -0.061, io_18: 0.698, io_19: -1.695 }))
      .toEqual({ x: -0.061, y: 0.698, z: -1.695 })
  })

  it("converts a tracker's raw milli-g, negatives in 16-bit two's complement", () => {
    // CPO - MENENGAI - KCH 045A: 44, 65517, 65503 is +44, -19, -33 mG.
    const a = readAccelerometer({ io_17: 44, io_18: 65517, io_19: 65503 })!
    expect(a.x).toBeCloseTo(0.044, 6)
    expect(a.y).toBeCloseTo(-0.019, 6)
    expect(a.z).toBeCloseTo(-0.033, 6)
  })

  it('reads small whole numbers as milli-g too', () => {
    // CIVIL - Menengai - EXCAVATOR001: 57, 109, 13. Read as g these would be
    // 57 g and 109 g, which no machine on a site experiences.
    const a = readAccelerometer({ io_17: 57, io_18: 109, io_19: 13 })!
    expect(a).toEqual({ x: 0.057, y: 0.109, z: 0.013 })
  })

  it('keeps an all-zero reading as zero', () => {
    expect(readAccelerometer({ io_17: 0, io_18: 0, io_19: 0 })).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('reads the axes a unit sends and leaves the missing one null', () => {
    // MUFINDI - FT 05 sends Y and Z but never X.
    expect(readAccelerometer({ io_18: 0.047, io_19: -0.345 })).toEqual({ x: null, y: 0.047, z: -0.345 })
  })

  it('accepts numbers sent as text', () => {
    expect(readAccelerometer({ io_17: '0.025', io_18: '0.035', io_19: '-0.001' }))
      .toEqual({ x: 0.025, y: 0.035, z: -0.001 })
  })

  it('returns null for a message with no axes — most of the fleet', () => {
    expect(readAccelerometer({ io_270: 3064, io_239: 0, pwr_ext: 25.5 })).toBeNull()
    expect(readAccelerometer({})).toBeNull()
    expect(readAccelerometer(undefined)).toBeNull()
  })

  it('does not read the accel_x/y/z event traces', () => {
    // MUFINDI : MTR 18 burst sample: raw milli-g with gravity, ~1,000 samples
    // sharing one timestamp. A trace of an event, not a reading of the fix.
    expect(readAccelerometer({ accel_x: 1124, accel_y: 47, accel_z: -1633 })).toBeNull()
  })

  it('drops an axis past the ±16 g a tracker can report', () => {
    // A guard, not a live value.
    expect(readAccelerometer({ io_17: 20.5, io_18: 0.1, io_19: -0.2 })).toEqual({ x: null, y: 0.1, z: -0.2 })
    expect(readAccelerometer({ io_17: 99.5, io_18: -40.25, io_19: 17.5 })).toBeNull()
  })

  it('ignores values that are not numbers', () => {
    expect(readAccelerometer({ io_17: 'n/a', io_18: null, io_19: NaN })).toBeNull()
  })
})

describe('accelColumns', () => {
  const dto = (over: Partial<TelemetryPayload> = {}): TelemetryPayload =>
    ({ deviceId: 'wialon:1', capturedAt: new Date('2026-09-27T00:00:00Z'), ...over }) as TelemetryPayload

  it('writes all three columns, null where the frame has no axis', () => {
    expect(accelColumns(dto({ accelYG: 0.047, accelZG: -0.345 })))
      .toEqual({ accelXG: null, accelYG: 0.047, accelZG: -0.345 })
    expect(accelColumns(dto())).toEqual({ accelXG: null, accelYG: null, accelZG: null })
  })

  it('refuses a value no accelerometer produces rather than storing it', () => {
    // The poller skips the HTTP schema parse, so this is the last guard.
    expect(accelColumns(dto({ accelXG: 44, accelYG: Number.NaN, accelZG: Infinity })))
      .toEqual({ accelXG: null, accelYG: null, accelZG: null })
  })
})

describe('WialonLiveAdapter — axes ride on the fix they were measured at', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const T = 1_790_464_315 // unix seconds, 2026-09-27

  /** A fetch stub answering the handful of Wialon calls the adapter makes. */
  function stubWialon(units: unknown[], events: unknown) {
    const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('/avl_evts?')) return reply(events)
      switch (new URL(url).searchParams.get('svc')) {
        case 'token/login':       return reply({ eid: 'sid-test', au: 'test' })
        case 'core/search_items': return reply({ items: units, totalItemsCount: units.length })
        default:                  return reply({})
      }
    }))
  }

  const pos = (t?: number) => ({ ...(t != null ? { t } : {}), y: -4.53, x: 30.12, s: 0, c: 0, sc: 12 })

  it('takes the sweep frame\'s axes from the last message only when it IS that fix', async () => {
    stubWialon([
      // Last message is this fix's own record: axes ride on it, raw kept for audit.
      { id: 30364291, nm: 'MUFINDI - EX 03', pos: pos(T), lmsg: { t: T, p: { io_17: -0.061, io_18: 0.698, io_19: -1.695 } } },
      // Last message is newer than the fix: its axes belong to another instant.
      { id: 30364545, nm: 'MUFINDI - FT 05', pos: pos(T - 600), lmsg: { t: T, p: { io_18: 0.047, io_19: -0.345 } } },
      // A milli-g unit, converted on the way in.
      { id: 29000001, nm: 'CPO - MENENGAI - KCH 045A', pos: pos(T), lmsg: { t: T, p: { io_17: 44, io_18: 65517, io_19: 65503 } } },
      // A unit with no axes at all.
      { id: 30311756, nm: 'MUFINDI - EX 01', pos: pos(T), lmsg: { t: T, p: { io_270: 2990, io_239: 1 } } },
    ], { tm: T, events: [] })

    const frames = await new WialonLiveAdapter('test-token', 'https://wialon.test').fetchAll()
    const by = (id: number) => frames.find(f => f.deviceId === `wialon:${id}`)!

    expect(by(30364291).accelG).toEqual({ x: -0.061, y: 0.698, z: -1.695 })
    expect(by(30364291).rawPayload).toMatchObject({ accel_raw: { io_17: -0.061, io_18: 0.698, io_19: -1.695 } })
    expect(by(30364545).accelG).toBeNull()
    expect(by(30364545).rawPayload).not.toHaveProperty('accel_raw')
    expect(by(29000001).accelG?.y).toBeCloseTo(-0.019, 6)
    expect(by(30311756).accelG).toBeNull()
  })

  it('reads a delta frame\'s axes from the message the event carries', async () => {
    stubWialon(
      [{ id: 30364291, nm: 'MUFINDI - EX 03', pos: pos(T), lmsg: { t: T, p: {} } }],
      // The shape avl_evts returns on this subscription: the raw message as `d`,
      // its position without a `t`, its params in `p`.
      { tm: T + 120, events: [
        { i: 30364291, t: 'm', d: { t: T + 60, tp: 'ud', pos: pos(), p: { io_17: 0.12, io_18: 0.66, io_19: -1.7, io_270: 3000 } } },
      ] },
    )
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()               // the sweep
    const [delta] = await adapter.fetchAll() // the delta

    expect(delta?.accelG).toEqual({ x: 0.12, y: 0.66, z: -1.7 })
    // The timestamp rule is unchanged by this: a delta position has no `t`,
    // so the batch time stands in (see WialonClient.pollEvents).
    expect(delta?.capturedAt.getTime()).toBe((T + 120) * 1000)
  })

  it('leaves a delta frame without axes when its message has none', async () => {
    stubWialon(
      [{ id: 30311756, nm: 'MUFINDI - EX 01', pos: pos(T), lmsg: { t: T, p: {} } }],
      { tm: T + 30, events: [{ i: 30311756, t: 'm', d: { t: T + 30, pos: pos(), p: { io_270: 2990 } } }] },
    )
    const adapter = new WialonLiveAdapter('test-token', 'https://wialon.test')
    await adapter.fetchAll()
    const [delta] = await adapter.fetchAll()
    expect(delta?.accelG).toBeNull()
  })
})
