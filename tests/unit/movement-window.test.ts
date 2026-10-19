/**
 * A vehicle's gate and zone crossings reach the live feed as ONE line per
 * five-minute window — operator screenshot 2026-10-16, KTCC 774G, three lines
 * for one trip through the Sukari gate. The rows behind them stay one per event.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/sse.js', () => ({ emitDashboardFeed: vi.fn() }))
vi.mock('../../src/lib/notifications/notification-cache.js', () => ({ cacheNotification: vi.fn() }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { emitDashboardFeed } from '../../src/lib/sse.js'
import { cacheNotification } from '../../src/lib/notifications/notification-cache.js'
import { publishNotification, __resetPublishDedupe } from '../../src/lib/notifications/notification.store.js'
import {
  groupMovementItems, flushAllMovementWindows, __resetMovementWindows, MOVEMENT_WINDOW_MS,
} from '../../src/lib/notifications/movement-window.js'

// 01:33 EAT on 16 Oct.
const T = Date.parse('2026-10-15T22:33:00Z')
const WHO = 'KTCC 774G · Ramadhan Kanduyi Murefu'

const ev = (over: Record<string, unknown>) => ({
  orgId: 'org_1', source: 'telemetry', severity: 'info' as const,
  plate: 'KTCC 774G', vehicleId: 'veh_1', ...over,
}) as Parameters<typeof publishNotification>[0]

const gateIn   = ev({ id: 'ya-veh_1-1', alertType: 'MOVEMENT_ENTRY', severity: 'success', text: `${WHO} arrived at the gate.`, at: new Date(T) })
const factory  = ev({ id: 'zn-veh_1-z-i-2', source: 'zone', alertType: 'ZONE_ENTRY', severity: 'success', text: `${WHO} arrived at Sukari Indurstries Factory.`, at: new Date(T + 60_000) })
const gateOut  = ev({ id: 'yd-dsp_1', alertType: 'MOVEMENT_EXIT', text: `${WHO} cleared the gate.`, at: new Date(T + 120_000) })

const emitted = () => vi.mocked(emitDashboardFeed).mock.calls.map(c => c[1] as Record<string, unknown>)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T)
  __resetPublishDedupe()
  __resetMovementWindows()
  vi.mocked(emitDashboardFeed).mockClear()
  vi.mocked(cacheNotification).mockClear()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.notification.upsert as any).mockResolvedValue({})
})
afterEach(() => vi.useRealTimers())

describe('live movement window', () => {
  it('holds the three KTCC 774G lines and emits one at the fifth minute', () => {
    publishNotification(gateIn)
    vi.advanceTimersByTime(60_000);  publishNotification(factory)
    vi.advanceTimersByTime(60_000);  publishNotification(gateOut)

    expect(emitDashboardFeed).not.toHaveBeenCalled()
    // Every event is still its own row, straight away — reports read them.
    expect(prismaMock.notification.upsert).toHaveBeenCalledTimes(3)

    vi.advanceTimersByTime(MOVEMENT_WINDOW_MS - 120_000)

    expect(emitted()).toHaveLength(1)
    const line = emitted()[0]!
    expect(line['text']).toBe(
      `${WHO} arrived at the gate (01:33), arrived at Sukari Indurstries Factory (01:34) and cleared the gate (01:35).`,
    )
    expect(line['id']).toBe(`mg-veh_1-${T}`)
    expect(line['ts']).toBe(new Date(T).toISOString())
    expect(line['type']).toBe('success')
    expect(line['alertType']).toBe('MOVEMENT_EXIT')
    expect(line['groupedIds']).toEqual(['ya-veh_1-1', 'zn-veh_1-z-i-2', 'yd-dsp_1'])
    expect(cacheNotification).toHaveBeenCalledTimes(1)
  })

  it('emits a lone crossing unchanged, only later', () => {
    publishNotification(gateIn)
    vi.advanceTimersByTime(MOVEMENT_WINDOW_MS - 1)
    expect(emitDashboardFeed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(emitted()).toHaveLength(1)
    expect(emitted()[0]!['id']).toBe('ya-veh_1-1')
    expect(emitted()[0]!['text']).toBe(`${WHO} arrived at the gate.`)
  })

  it('keeps vehicles apart', () => {
    publishNotification(gateIn)
    publishNotification(ev({ ...gateOut, id: 'yd-dsp_9', vehicleId: 'veh_2', plate: 'KDL 713E', text: 'KDL 713E cleared the gate.' }))
    vi.advanceTimersByTime(MOVEMENT_WINDOW_MS)
    expect(emitted()).toHaveLength(2)
  })

  it('starts a new window for a crossing after the first one closed', () => {
    publishNotification(gateIn)
    vi.advanceTimersByTime(MOVEMENT_WINDOW_MS)
    publishNotification({ ...gateOut, at: new Date(T + MOVEMENT_WINDOW_MS + 60_000) })
    vi.advanceTimersByTime(MOVEMENT_WINDOW_MS)
    expect(emitted().map(e => e['text'])).toEqual([`${WHO} arrived at the gate.`, `${WHO} cleared the gate.`])
  })

  it('never holds a breach or anything that is not a crossing', () => {
    publishNotification(ev({ id: 'zn-b', source: 'zone', alertType: 'GEOFENCE_BREACH', severity: 'critical', text: `RESTRICTED: ${WHO} entered X.`, at: new Date(T) }))
    publishNotification(ev({ id: 'fuel-1', alertType: 'fuelFilling', text: 'refuelled', at: new Date(T) }))
    expect(emitted()).toHaveLength(2)
  })

  it('releases what is held on shutdown', () => {
    publishNotification(gateIn)
    publishNotification(factory)
    flushAllMovementWindows()
    expect(emitted()).toHaveLength(1)
    expect(String(emitted()[0]!['text'])).toContain('and arrived at Sukari')
  })
})

describe('groupMovementItems (reads from Postgres)', () => {
  const item = (id: string, at: number, text: string, alertType = 'ZONE_ENTRY', vehicleId = 'veh_1') => ({
    id, ts: new Date(at).toISOString(),
    time: new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hour12: false }).format(at),
    type: 'info', text, source: 'zone', alertType, plate: 'KTCC 774G', vehicleId,
  })

  it('groups the same way the live window did, newest first', () => {
    const rows = [
      item('fuel', T + 200_000, 'something else', 'fuelFilling'),
      item('c', T + 120_000, `${WHO} cleared the gate.`, 'MOVEMENT_EXIT'),
      item('b', T + 60_000,  `${WHO} arrived at Sukari Indurstries Factory.`),
      item('a', T,           `${WHO} arrived at the gate.`, 'MOVEMENT_ENTRY'),
      item('z', T - 10 * 60_000, `${WHO} left Sukari industries.`, 'ZONE_EXIT'),
    ]
    const out = groupMovementItems(rows, T + MOVEMENT_WINDOW_MS)
    expect(out.map(i => i.id)).toEqual(['fuel', `mg-veh_1-${T}`, 'z'])
    expect(out[1]!.text).toBe(
      `${WHO} arrived at the gate (01:33), arrived at Sukari Indurstries Factory (01:34) and cleared the gate (01:35).`,
    )
  })

  it('keeps the second sentence of a bounded departure readable', () => {
    const out = groupMovementItems([
      item('a', T, `${WHO} arrived at the gate.`, 'MOVEMENT_ENTRY'),
      item('b', T + 60_000, `${WHO} is clear of the yard. The departure time was not observed, because there was no fix at the gate.`, 'MOVEMENT_EXIT'),
    ], T + MOVEMENT_WINDOW_MS)
    expect(out[0]!.text).toBe(
      `${WHO} arrived at the gate (01:33) and is clear of the yard (01:34). The departure time was not observed, because there was no fix at the gate.`,
    )
  })

  it('leaves out a group the live feed has not said yet', () => {
    // Read at 01:35, two minutes into the window: the line lands at 01:38.
    const out = groupMovementItems([
      item('a', T, `${WHO} arrived at the gate.`, 'MOVEMENT_ENTRY'),
      item('fuel', T, 'something else', 'fuelFilling'),
    ], T + 120_000)
    expect(out.map(i => i.id)).toEqual(['fuel'])
  })
})
