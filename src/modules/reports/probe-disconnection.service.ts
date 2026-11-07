/**
 * The Probe Disconnection Report (operator, 5 Nov 2026; West Kenya's Wialon
 * violations sheet): each time a unit's fuel probe was disconnected.
 *
 * Trucks only (operator, 5 Nov 2026), as the sheet is: no tractors, machines or
 * light vehicles.
 *
 * Wialon's "Fuel Probe Disconnection Alert (Omnicom)" rules decide what a
 * disconnection is, against sensors we do not hold, and leave an event on the
 * unit. They do not post to us, so the events are read from Wialon here. What
 * the sheet showed of them (27-30 Oct 2026):
 *
 *   - Two rules watch most units, so an alert usually comes twice with one time:
 *     1,460 probe rows were 663 alerts. The fuel level differs between the two,
 *     so it is not reported.
 *   - The sheet's other rows are other rules (overspeeding at blackspots): only
 *     the probe's own words count here.
 *   - A disconnected probe alerts about once a minute, so alerts less than
 *     RUN_GAP_MS apart are one disconnection: 663 alerts were 35 disconnections.
 */

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { prisma } from '../../lib/prisma.js'
import { fleetDayBounds } from '../../lib/provider-time.js'
import { WialonClient } from '../../providers/wialon/wialon.client.js'
import { wialonIdOf } from './speed-report.service.js'
import { isTruck } from './vehicle-kind.js'
export { isTruck }

/** Alerts closer than this are one disconnection. */
export const RUN_GAP_MS = 30 * 60_000
const SESSIONS = 5
const PAGE = 5_000
const CACHE_MS = 60 * 60_000

/** Wialon's message type in bits 8 to 15: this bit is the events, and leaves out data, SMS and commands. */
const EVENT_BIT = 0x0400

export interface ProbeAlert { at: number; speedKmh: number | null; place: string | null; lat: number | null; lng: number | null }
export interface ProbeDisconnection extends ProbeAlert {
  vehicleId: string
  name: string
  plate: string
  /** The last alert of the run; `at` is the first. */
  to: number
  alerts: number
}
export interface ProbeReport {
  from: string
  to: string
  rows: ProbeDisconnection[]
  /** Units read, units that could not be, and every event Wialon gave, of any rule. */
  read: number
  failed: number
  eventsSeen: number
}

/**
 * One event's text as an alert, or null when it is another rule's. Its own "At"
 * is the time, as the sheet has it, in Nairobi; else the message's. Pure.
 */
export function parseProbeAlert(text: string, messageMs: number | null = null): ProbeAlert | null {
  if (!/probe\b[\s\S]*disconnect/i.test(text)) return null
  const stamp = /\bAt (\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})/.exec(text)
  const at = stamp ? Date.parse(`${stamp[3]}-${stamp[2]}-${stamp[1]}T${stamp[4]}+03:00`) : messageMs
  if (at == null || Number.isNaN(at)) return null
  const speed = /speed of\s*(\d+(?:\.\d+)?)\s*km\/h/i.exec(text)
  const place = /\bLocation\s*([\s\S]*?)\s*Google Map/i.exec(text)?.[1]?.trim()
  const fix = /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text)
  return {
    at,
    speedKmh: speed ? Number(speed[1]) : null,
    place: place && !/^-+$/.test(place) ? place : null,
    lat: fix ? Number(fix[1]) : null,
    lng: fix ? Number(fix[2]) : null,
  }
}

/** A unit's alerts as disconnections, in time order; a second's copies count once. Pure. */
export function disconnectionsOf(alerts: ProbeAlert[]): Array<ProbeAlert & { to: number; alerts: number }> {
  const sorted = [...alerts].sort((a, b) => a.at - b.at)
  const out: Array<ProbeAlert & { to: number; alerts: number }> = []
  let seen: number | null = null
  for (const a of sorted) {
    if (a.at === seen) continue
    seen = a.at
    const run = out[out.length - 1]
    if (run && a.at - run.to < RUN_GAP_MS) {
      run.to = a.at
      run.alerts += 1
      // The first alert that knows where or how fast
      run.place ??= a.place
      run.speedKmh ??= a.speedKmh
      if (run.lat == null) { run.lat = a.lat; run.lng = a.lng }
    } else out.push({ ...a, to: a.at, alerts: 1 })
  }
  return out
}

interface RawEvent { t?: number; et?: string; txt?: string; text?: string }

async function readEvents(client: WialonClient, itemId: number, from: number, to: number): Promise<RawEvent[]> {
  const loaded = await client.call<{ count?: number }>('messages/load_interval', {
    itemId, timeFrom: from, timeTo: to, flags: EVENT_BIT, flagsMask: EVENT_BIT, loadCount: 0,
  })
  const total = loaded.count ?? 0
  const out: RawEvent[] = []
  for (let i = 0; i < total; i += PAGE) {
    const page = await client.call<Record<string, RawEvent> | RawEvent[]>('messages/get_messages', {
      indexFrom: i, indexTo: Math.min(i + PAGE, total) - 1,
    })
    out.push(...(Array.isArray(page) ? page : Object.values(page)))
  }
  await client.call('messages/unload', {}).catch(() => { /* best effort */ })
  return out
}

async function buildReport(orgId: string, fromDay: string, toDay: string, allowed: Set<string> | null): Promise<ProbeReport> {
  const start = fleetDayBounds(fromDay)
  const end = fleetDayBounds(toDay)
  if (!start || !end) return { from: fromDay, to: toDay, rows: [], read: 0, failed: 0, eventsSeen: 0 }
  const vehicles = await prisma.vehicle.findMany({
    where: { organisationId: orgId, isActive: true },
    select: { id: true, name: true, registrationPlate: true, deviceId: true, vehicleType: true },
  })
  const planned = vehicles.flatMap((v) => {
    const wialonId = wialonIdOf(v.deviceId)
    const truck = isTruck({ type: v.vehicleType, plate: v.registrationPlate, name: v.name })
    return truck && wialonId != null && (!allowed || allowed.has(v.id)) ? [{ unit: v, wialonId }] : []
  })
  const fromMs = start.from.getTime()
  const toMs = end.to.getTime()
  const token = env.WIALON_TOKEN || process.env['access_token'] || ''
  const sessions = Array.from({ length: SESSIONS }, () => new WialonClient(token, env.WIALON_API_URL))

  const rows: ProbeDisconnection[] = []
  let failed = 0
  let eventsSeen = 0
  let next = 0
  const work = async (client: WialonClient) => {
    while (next < planned.length) {
      const { unit, wialonId } = planned[next++]!
      try {
        const events = await readEvents(client, wialonId, Math.floor(fromMs / 1000), Math.floor(toMs / 1000) - 1)
        eventsSeen += events.length
        const alerts = events.flatMap((e) => {
          const text = e.et ?? e.txt ?? e.text
          const alert = text ? parseProbeAlert(text, typeof e.t === 'number' ? e.t * 1000 : null) : null
          return alert && alert.at >= fromMs && alert.at < toMs ? [alert] : []
        })
        const name = unit.name.replace(/\s+/g, ' ').trim()
        for (const run of disconnectionsOf(alerts)) rows.push({ ...run, vehicleId: unit.id, name, plate: unit.registrationPlate })
      } catch (err) {
        logger.warn({ err, vehicleId: unit.id }, 'Probe report: unit could not be read')
        failed += 1
      }
    }
  }
  try {
    await Promise.all(sessions.map(work))
  } finally {
    await Promise.all(sessions.map(c => c.logout().catch(() => { /* best effort */ })))
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.at - b.at)
  return { from: fromDay, to: toDay, rows, read: planned.length, failed, eventsSeen }
}

const made = new Map<string, { at: number; report: Promise<ProbeReport> }>()

/** Closed days barely change and take a while to read, so they are kept for a while. */
export async function getProbeReport(orgId: string, from: string, to: string, allowed: Set<string> | null = null, now = Date.now()): Promise<ProbeReport> {
  const closed = (fleetDayBounds(to)?.to.getTime() ?? now) <= now
  if (!closed || allowed) return buildReport(orgId, from, to, allowed)
  const key = `${orgId}|${from}|${to}`
  const held = made.get(key)
  if (held && now - held.at < CACHE_MS) return held.report
  for (const [k, v] of made) if (now - v.at >= CACHE_MS) made.delete(k)
  const report = buildReport(orgId, from, to, null)
  made.set(key, { at: now, report })
  report.catch(() => made.delete(key))
  return report
}
