/**
 * Supply voltages for a day of readings that has none, read from Wialon.
 *
 * The voltage columns are stored from 2026-10-13 on (VehicleTelemetry
 * extVoltageV / intVoltageV). A Fuel Report over a day before that, or over a
 * unit whose voltages were not stored, would draw two empty lines; the operator
 * asked that "if we don't have [it], we can query Wialon for that record". So a
 * day whose readings carry no voltage at all is matched here, reading by
 * reading, against the unit's own Wialon messages for the day: the readings
 * are stamped with the tracker's own time, which is the message's `t`, so the
 * match is exact to the second.
 *
 * Cost: one Wialon session per day asked, in its own session so the live
 * poller is never stalled (see usage-review.wialon). A finished day is then
 * kept in the shared day cache with its voltages, so Wialon is asked once per
 * unit-day for everybody. A day Wialon has nothing for is not asked again for
 * MISS_TTL_MS, and no more than FILLS_AT_ONCE days are read at a time across
 * the server.
 */

import { env } from '../../config/env.js'
import { WialonClient } from '../../providers/wialon/wialon.client.js'
import { readVoltages } from '../../providers/wialon/wialon.sensors.js'

const PAGE = 20_000
/** A day at one message a second, with room to spare. */
const MAX_MESSAGES = 100_000
export const MISS_TTL_MS = 30 * 60_000
const FILLS_AT_ONCE = 2

/** The day series fields this reads and fills (telemetry.service getVehicleDaySeries). */
export interface VoltDay {
  from: number
  to: number
  t: number[]
  vext?: (number | null)[]
  vint?: (number | null)[]
}

interface RawMsg { t?: number; p?: Record<string, unknown> }

/** Whether any reading of the day already has a voltage. */
export const hasVoltages = (d: VoltDay): boolean =>
  (d.vext ?? []).some(v => v != null) || (d.vint ?? []).some(v => v != null)

/**
 * Writes the messages' voltages onto the readings they match by time. Returns
 * how many readings got one. Pure: the Wialon read is `loadDayVolts`.
 */
export function applyVolts(d: VoltDay, bySec: Map<number, { ext: number | null; int: number | null }>): number {
  const base = Math.round(d.from / 1000)
  const vext = d.t.map(() => null as number | null)
  const vint = d.t.map(() => null as number | null)
  let n = 0
  d.t.forEach((off, i) => {
    const v = bySec.get(base + off)
    if (!v) return
    vext[i] = v.ext
    vint[i] = v.int
    n += 1
  })
  if (n) { d.vext = vext; d.vint = vint }
  return n
}

/** The unit's Wialon messages over [fromSec, toSec), as voltages by second. */
async function loadDayVolts(wialonUnitId: number, fromSec: number, toSec: number) {
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  const client = new WialonClient(token, env.WIALON_API_URL)
  const out = new Map<number, { ext: number | null; int: number | null }>()
  try {
    // flags 1 / mask 0xFF01: data messages only, as the usage review reads them.
    const loaded = await client.call<{ count?: number }>('messages/load_interval', {
      itemId: wialonUnitId, timeFrom: fromSec, timeTo: toSec - 1, flags: 1, flagsMask: 0xFF01, loadCount: 0,
    })
    const total = Math.min(loaded.count ?? 0, MAX_MESSAGES)
    for (let i = 0; i < total; i += PAGE) {
      const page = await client.call<Record<string, RawMsg> | RawMsg[]>('messages/get_messages', {
        indexFrom: i, indexTo: Math.min(i + PAGE, total) - 1,
      })
      for (const m of Array.isArray(page) ? page : Object.values(page)) {
        if (typeof m.t !== 'number') continue
        const v = readVoltages(m.p)
        if (v) out.set(m.t, v)
      }
    }
    await client.call('messages/unload', {}).catch(() => { /* best effort */ })
    return out
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }
}

const misses = new Map<string, number>()
let running = 0
const waiting: (() => void)[] = []

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= FILLS_AT_ONCE) await new Promise<void>(r => waiting.push(r))
  running += 1
  try { return await fn() } finally {
    running -= 1
    waiting.shift()?.()
  }
}

/**
 * Fills the day's voltages from Wialon where it has none. Never throws: a
 * Wialon failure leaves the lines empty, it does not fail the report.
 * Returns whether anything was filled.
 */
export async function fillDayVoltages(d: VoltDay, key: string, wialonUnitId: number | null, now = Date.now()): Promise<boolean> {
  if (wialonUnitId == null || !d.t.length || hasVoltages(d)) return false
  const missedAt = misses.get(key)
  if (missedAt != null && now - missedAt < MISS_TTL_MS) return false
  try {
    const bySec = await slot(() => loadDayVolts(wialonUnitId, Math.floor(d.from / 1000), Math.ceil(Math.min(d.to, now) / 1000)))
    const n = applyVolts(d, bySec)
    if (!n) misses.set(key, now)
    return n > 0
  } catch {
    misses.set(key, now)
    return false
  }
}

/** Tests only. */
export function _clearVoltMisses() { misses.clear() }
