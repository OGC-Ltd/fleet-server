/**
 * A unit's message history out of Wialon, for the usage review.
 *
 * Not from our own telemetry table: that keeps 30 days (TELEMETRY_RETENTION_DAYS)
 * and stores no odometer column, and a review is usually a month or two back.
 * Wialon keeps the full history, with the odometer the tracker itself counted.
 *
 * Each review opens its OWN session: `messages/load_interval` loads into the
 * session, and Wialon serialises requests per session, so sharing the live
 * poller's client would stall the poller for the length of the download.
 */

import { env } from '../../config/env.js'
import { WialonClient } from '../../providers/wialon/wialon.client.js'
import { readIgnition, type WialonSensor } from '../../providers/wialon/wialon.sensors.js'
import type { ReviewMessage } from './usage-review.compute.js'

const PAGE = 20_000
/** ~90 days at one message a minute, with room to spare. */
const MAX_MESSAGES = 400_000

interface RawMsg {
  t?: number
  pos?: { y?: number; x?: number; s?: number; c?: number } | null
  p?: Record<string, unknown>
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Teltonika's total odometer, metres. Other trackers may name it differently. */
const ODOMETER_PARAMS = ['io_16', 'odometer']

export function toReviewMessage(m: RawMsg, sensors: Record<string, WialonSensor> | undefined): ReviewMessage | null {
  const t = num(m.t)
  if (t == null) return null
  const p = m.p ?? {}
  let odoM: number | null = null
  for (const k of ODOMETER_PARAMS) { const v = num(p[k]); if (v != null && v > 0) { odoM = v; break } }
  return {
    t,
    lat: num(m.pos?.y), lng: num(m.pos?.x),
    src: 'wialon',
    speed: num(m.pos?.s) ?? 0,
    course: num(m.pos?.c),
    odoM,
    ign: readIgnition(sensors, p),
  }
}

export interface UnitHistory {
  unitName: string | null
  messages: ReviewMessage[]
}

/**
 * Messages for each [fromSec, toSec] range, read in one session. With no
 * ranges it still returns the unit's name (it carries the km/L on some units).
 */
export async function loadUnitHistory(
  wialonUnitId: number, ranges: [number, number][],
  onProgress: (loaded: number, total: number) => void,
): Promise<UnitHistory> {
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  const client = new WialonClient(token, env.WIALON_API_URL)
  try {
    const unit = await client.call<{ item?: { nm?: string; sens?: Record<string, WialonSensor> } }>(
      'core/search_item', { id: wialonUnitId, flags: 1 | 0x1000 },
    )
    const sensors = unit.item?.sens
    const out: ReviewMessage[] = []
    let doneBefore = 0
    for (const [fromSec, toSec] of ranges) {
      // flags 1 / mask 0xFF01: data messages (with position) only — no SMS,
      // commands or events.
      const loaded = await client.call<{ count?: number }>('messages/load_interval', {
        itemId: wialonUnitId, timeFrom: fromSec, timeTo: toSec, flags: 1, flagsMask: 0xFF01, loadCount: 0,
      })
      const total = Math.min(loaded.count ?? 0, MAX_MESSAGES - out.length)
      for (let i = 0; i < total; i += PAGE) {
        const page = await client.call<Record<string, RawMsg> | RawMsg[]>('messages/get_messages', {
          indexFrom: i, indexTo: Math.min(i + PAGE, total) - 1,
        })
        for (const m of Array.isArray(page) ? page : Object.values(page)) {
          const r = toReviewMessage(m, sensors)
          if (r) out.push(r)
        }
        onProgress(doneBefore + Math.min(i + PAGE, total), doneBefore + total)
      }
      doneBefore += total
      await client.call('messages/unload', {}).catch(() => { /* best effort */ })
    }
    return { unitName: unit.item?.nm ?? null, messages: out }
  } finally {
    await client.logout().catch(() => { /* best effort */ })
  }
}
