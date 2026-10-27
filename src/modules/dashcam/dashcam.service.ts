/**
 * Dashcam alarms from Control Tech's VSS platform — the dashboard's Alarms tab.
 *
 *   GET /api/v1/vss/cameras?org=   → how many of the org's vehicles have a VSS camera
 *   GET /api/v1/vss/alarms?org=&since=  → alarms that came with evidence, newest first
 *   GET /api/v1/vss/file?org=&k=   → one clip or snapshot, streamed (Range supported)
 *
 * The contract is the dashboard's (new-ui src/api/vssAlarms.js, docs/
 * dashcam-alarms.md there); the same three routes are served by vss.php on
 * cPanel, which this module follows — including what the live VSS taught it:
 *
 *  · §3.24 findRecords takes every device of the org in one search, one row
 *    per FILE (grouped here by alarmGuid). It is rate-limited harder than
 *    other calls (10129 on a second page 2 s after the first): big pages, a
 *    10 s gap between searches, one search per org at a time, answers reused
 *    for 90 s, and the pages already received kept if a later one is refused.
 *  · §3.24 rows carry `alarmType: null`; the type, time, place and speed come
 *    from §3.25 getAlarmByIds (`alarmtype`, `createtime`, `AlarmGps` as
 *    "lng,lat", `Speed`). An alarm never changes, so those are kept.
 *  · Device ↔ vehicle by name (vss-match): "SUKARI - KDR 430Q" is "KDR 430Q".
 *  · Evidence links carry a VSS token, so the browser only ever gets
 *    /api/v1/vss/file?k=…; the real link stays in this process.
 *
 * State is in memory: one process. A restart forgets the caches and the file
 * keys; the dashboard re-reads the alarms (and gets new keys) within 2 min.
 */

import crypto from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'
import {
  listDevices, vssCall, vssAvailable, VssError, VSS_TOO_FREQUENT, VSS_LOGIN_LIMITED,
  type VssDevice, type VssChannel,
} from '../../providers/vss/index.js'
import { matchDevice, devicePrefix } from './vss-match.js'
import { vssEvent, vssCategory, type Category } from './vss-events.js'

// ── tuning ──────────────────────────────────────────────────────────────────

const VEHICLES_TTL_MS = 5 * 60_000
const ALARMS_TTL_MS   = 90_000
const MAX_DAYS        = 7
let SEARCH_GAP_MS     = 10_000      // between two §3.24 searches (tests shorten it)
const SEARCH_PAGE     = 2_000       // files per search page
const SEARCH_PAGES    = 5
const DETAIL_CHUNK    = 100         // alarm ids per §3.25 lookup
const DETAIL_CALLS    = 3           // §3.25 lookups per visit (newest alarms first)
const DETAILS_MAX     = 50_000
const FILES_TTL_MS    = 9 * 86_400_000
const FILES_MAX       = 100_000

// ── shapes ──────────────────────────────────────────────────────────────────

export interface OrgDevice {
  deviceId: string
  vehicleId: string
  plate: string
  name: string
  channels: VssChannel[]
}

export interface Media { key: string; label: string; url: string; download: string }

export interface DashcamIncident {
  id: string
  code: number
  label: string
  group: string
  severity: 'critical' | 'warning' | 'informational'
  category: Category
  occurredAt: string | null
  vehicleId: string
  plate: string
  deviceId: string
  lat: number | null
  lng: number | null
  speed: number | null
  videos: Media[]
  photos: Media[]
}

export interface AlarmsAnswer {
  incidents: DashcamIncident[]
  cameras: number
  from: string
  to: string
  partial?: boolean
  stale?: boolean
}

interface EvidenceFile { type: number; channel: number; url: string }
interface EvidenceAlarm { guid: string; deviceId: string; type: number; time: string; gps: string; files: EvidenceFile[] }
interface AlarmDetail { t: string; g: string; s: string; y: number; at: number }

// ── time and place ──────────────────────────────────────────────────────────

/** The clock VSS writes its times in (its server's own). */
const tz = () => env.VSS_TIMEZONE

const LOCAL = new Map<string, Intl.DateTimeFormat>()
/** Epoch ms → "YYYY-MM-DD HH:MM:SS" in `zone`. */
export function vssTime(ms: number, zone = tz()): string {
  let f = LOCAL.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    LOCAL.set(zone, f)
  }
  return f.format(new Date(ms)).replace('T', ' ')
}

/** "YYYY-MM-DD HH:MM:SS" in `zone` → epoch ms (null when it is not a time). */
export function fromVssTime(s: string, zone = tz()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s ?? '')
  if (!m) return null
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
  // The zone's offset at that moment: write the instant out in the zone, read it back as UTC.
  const shown = vssTime(asUtc, zone)
  const n = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(shown)
  if (!n) return asUtc
  const offset = Date.UTC(+n[1], +n[2] - 1, +n[3], +n[4], +n[5], +n[6]) - asUtc
  return asUtc - offset
}

/** VSS writes positions as "longitude,latitude". */
export function vssGps(s: string | null | undefined): [number | null, number | null] {
  const p = (s ?? '').split(',').map((x) => x.trim())
  if (p.length < 2) return [null, null]
  let lng = Number(p[0]), lat = Number(p[1])
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || (lng === 0 && lat === 0)) return [null, null]
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) [lat, lng] = [lng, lat]   // written the other way round
  return [lat, lng]
}

/** "ROAD" → "Road camera", "IN CABIN" → "In cabin", nothing → "Camera 2". */
export function cameraLabel(name: string | null | undefined, ch: number): string {
  const s = (name ?? '').trim()
  if (!s || /^ch(annel)?\s*\d+$/i.test(s)) return `Camera ${Math.max(1, ch)}`
  const t = s[0].toUpperCase() + s.slice(1).toLowerCase()
  return t === 'Road' ? 'Road camera' : t === 'Driver' ? 'Driver camera' : t
}

/** The alarm's type, wherever this VSS version puts it. */
export function alarmCode(r: Record<string, unknown>): number {
  for (const k of ['alarmType', 'alarmtype', 'AlarmType', 'alarm_type', 'eventType', 'ec', 'type']) {
    const n = Number(r[k])
    if (r[k] != null && Number.isFinite(n) && n > 0) return n
  }
  return 0
}

/** A VSS data payload: a bare list, or a page object around one. */
export function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((r) => r && typeof r === 'object') as Record<string, unknown>[]
  if (data && typeof data === 'object') {
    for (const k of ['dataList', 'list', 'records', 'rows', 'data']) {
      const v = (data as Record<string, unknown>)[k]
      if (Array.isArray(v)) return rowsOf(v)
    }
  }
  return []
}

// ── the organisation's vehicles and their devices ───────────────────────────

const vehiclesByOrg = new Map<string, { at: number; list: { id: string; plate: string; name: string }[] }>()

async function orgVehicles(orgId: string) {
  const hit = vehiclesByOrg.get(orgId)
  if (hit && Date.now() - hit.at < VEHICLES_TTL_MS) return hit.list
  const rows = await prisma.vehicle.findMany({
    where: { organisationId: orgId },
    select: { id: true, registrationPlate: true, name: true },
  })
  const list = rows.map((v) => ({ id: v.id, plate: v.registrationPlate ?? '', name: v.name ?? '' }))
  vehiclesByOrg.set(orgId, { at: Date.now(), list })
  return list
}

/** deviceId → the vehicle it is fitted to, for the vehicles this caller may see. */
export async function orgDevices(orgId: string, scope: Set<string> | null): Promise<Map<string, OrgDevice>> {
  const vehicles = (await orgVehicles(orgId)).filter((v) => scope === null || scope.has(v.id))
  const devices: VssDevice[] = await listDevices()
  const out = new Map<string, OrgDevice>()
  for (const v of vehicles) {
    const d = matchDevice(devices, [v.plate, v.name])
    if (d && !out.has(d.deviceId)) {
      out.set(d.deviceId, { deviceId: d.deviceId, vehicleId: v.id, plate: v.plate || v.name, name: d.name, channels: d.channels })
    }
  }
  return out
}

/** How many of these vehicles have a VSS camera (0 when VSS is not set up). */
export async function cameraCount(orgId: string, scope: Set<string> | null): Promise<number> {
  if (!vssAvailable()) return 0
  return (await orgDevices(orgId, scope)).size
}

// ── searching VSS ───────────────────────────────────────────────────────────

let lastSearchAt = 0
let searchQueue: Promise<unknown> = Promise.resolve()

/** One §3.24 search at a time, SEARCH_GAP_MS apart. */
function searchPaced<T>(fn: () => Promise<T>): Promise<T> {
  const run = searchQueue.then(async () => {
    const wait = lastSearchAt + SEARCH_GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastSearchAt = Date.now()
    return fn()
  })
  searchQueue = run.catch(() => undefined)
  return run
}

/**
 * Alarms with their evidence files, for these devices, over [from, to].
 * §3.24 (all devices in one search); an older VSS without it falls back to
 * §3.12 searched by the devices' organisation prefix ("SUKARI").
 */
async function findEvidence(deviceIds: string[], devices: Map<string, OrgDevice>, from: string, to: string):
  Promise<{ alarms: EvidenceAlarm[]; partial: boolean }> {
  const want = new Set(deviceIds)
  const byGuid = new Map<string, EvidenceAlarm>()
  const add = (r: Record<string, unknown>, file?: Record<string, unknown>) => {
    const guid = String(r['alarmGuid'] ?? r['guid'] ?? '')
    const dev = String(r['deviceID'] ?? r['deviceId'] ?? '')
    if (!guid || !want.has(dev)) return
    let a = byGuid.get(guid)
    if (!a) {
      a = { guid, deviceId: dev, type: alarmCode(r), time: String(r['alarmTime'] ?? r['fileStartTime'] ?? ''), gps: String(r['alarmGps'] ?? ''), files: [] }
      byGuid.set(guid, a)
    }
    if (file) a.files.push({ type: Number(file['fileType'] ?? 0), channel: Number(file['channel'] ?? 0), url: String(file['downUrl'] ?? '') })
  }

  let pages = 0
  try {
    let seen = 0
    for (let page = 1; page <= SEARCH_PAGES; page++) {
      const data = await searchPaced(() => vssCall<unknown>('/vss/record/findRecords.action', {
        pageNum: page, pageSize: SEARCH_PAGE, beginTime: from, endTime: to, deviceIdList: deviceIds,
      }))
      const rows = rowsOf(data)
      pages++
      seen += rows.length
      for (const r of rows) add(r, r)
      // More to come? VSS may say how many there are; if not, a round page
      // smaller than asked for means it capped the size — try the next one.
      const total = data && typeof data === 'object' && !Array.isArray(data)
        ? Number((data as Record<string, unknown>)['totalCount'] ?? (data as Record<string, unknown>)['total']) : NaN
      if (Number.isFinite(total)) { if (seen >= total) break; continue }
      const capped = rows.length > 0 && rows.length < SEARCH_PAGE && rows.length % 100 === 0
      if (rows.length < SEARCH_PAGE && !capped) break
    }
    return { alarms: [...byGuid.values()], partial: false }
  } catch (err) {
    if (err instanceof VssError && err.status === VSS_TOO_FREQUENT && pages > 0) {
      return { alarms: [...byGuid.values()], partial: true }   // keep the pages that did arrive
    }
    if (err instanceof VssError && (err.status === VSS_TOO_FREQUENT || err.status === VSS_LOGIN_LIMITED)) throw err
    logger.warn({ err }, 'dashcam: §3.24 findRecords unavailable, using §3.12')
  }

  // §3.12 by keyword: "SUKARI" finds every "SUKARI - …" device in one search.
  const prefixes = [...new Set([...devices.values()].map((d) => devicePrefix(d.name)).filter((p): p is string => !!p))]
  const keywords = prefixes.length ? prefixes.slice(0, 4) : deviceIds.slice(0, 10)
  for (const kw of keywords) {
    for (let page = 1; page <= SEARCH_PAGES; page++) {
      const data = await searchPaced(() => vssCall<unknown>('/vss/record/findEvidences.action', {
        conditionName: kw, startTime: from, endTime: to, pageNum: page, pageSize: 200, scheme: 'https', queryType: 0,
      }))
      const rows = rowsOf(data)
      for (const r of rows) {
        const files = Array.isArray(r['alarmFile']) ? (r['alarmFile'] as Record<string, unknown>[]) : []
        if (!files.length) add(r)
        for (const f of files) add(r, f)
      }
      if (rows.length < 200) break
    }
  }
  return { alarms: [...byGuid.values()], partial: false }
}

// §3.25 alarm details — kept: an alarm does not change once raised.
const details = new Map<string, AlarmDetail>()

async function alarmDetails(guids: string[]): Promise<void> {
  const missing = [...new Set(guids)].filter((g) => !details.has(g))
  for (let i = 0; i < Math.min(missing.length, DETAIL_CHUNK * DETAIL_CALLS); i += DETAIL_CHUNK) {
    let data: unknown
    try {
      data = await vssCall<unknown>('/vss/alarm/getAlarmByIds.action', { guidList: missing.slice(i, i + DETAIL_CHUNK) })
    } catch {
      break     // busy, or an older VSS without §3.25: the file times stand in
    }
    for (const r of rowsOf(data)) {
      const guid = String(r['guid'] ?? '')
      if (!guid) continue
      details.set(guid, {
        t: String(r['createtime'] ?? ''),
        g: String(r['AlarmGps'] ?? r['alarmGps'] ?? ''),
        s: String(r['Speed'] ?? r['speed'] ?? ''),
        y: alarmCode(r),
        at: Date.now(),
      })
    }
  }
  if (details.size > DETAILS_MAX) {
    const drop = [...details.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, details.size - DETAILS_MAX)
    for (const [k] of drop) details.delete(k)
  }
}

// ── private file links ──────────────────────────────────────────────────────

const files = new Map<string, { url: string; orgId: string; at: number }>()

/** A clip or photo's private link: the real VSS address stays here. */
function fileLink(orgId: string, url: string, download = false): string {
  const k = crypto.createHash('sha1').update(url).digest('hex')
  if (!files.has(k)) {
    files.set(k, { url, orgId, at: Date.now() })
    if (files.size > FILES_MAX) {
      const cut = Date.now() - FILES_TTL_MS
      for (const [key, f] of files) if (f.at < cut || files.size > FILES_MAX) files.delete(key)
    }
  }
  return `/api/v1/vss/file?org=${encodeURIComponent(orgId)}&k=${k}${download ? '&download=1' : ''}`
}

/** The VSS address behind a private link — only for the organisation it was listed for. */
export function fileFor(orgId: string, k: string): string | null {
  const f = files.get(k)
  if (!f || f.orgId !== orgId || Date.now() - f.at > FILES_TTL_MS) return null
  return f.url
}

// ── the alarms answer ───────────────────────────────────────────────────────

const answers = new Map<string, { at: number; value: AlarmsAnswer }>()
const inflight = new Map<string, Promise<AlarmsAnswer>>()

/** The organisation's dashcam alarms with evidence since `since`, newest first. */
export async function getAlarms(orgId: string, scope: Set<string> | null, since: string | undefined): Promise<AlarmsAnswer> {
  const now = Date.now()
  let sinceMs = since ? Date.parse(since) : NaN
  if (!Number.isFinite(sinceMs)) sinceMs = now - 86_400_000
  sinceMs = Math.max(sinceMs, now - MAX_DAYS * 86_400_000 - 3_600_000)
  sinceMs = Math.floor(sinceMs / 600_000) * 600_000           // 10-minute steps: fewer distinct searches

  const devices = await orgDevices(orgId, scope)
  const from = vssTime(sinceMs), to = vssTime(now)
  if (devices.size === 0) return { incidents: [], cameras: 0, from, to }

  const ids = [...devices.keys()].sort()
  const key = crypto.createHash('sha1').update(`${orgId}|${ids.join(',')}|${sinceMs}`).digest('hex')
  const hit = answers.get(key)
  if (hit && now - hit.at < ALARMS_TTL_MS) return hit.value
  // One search per organisation at a time: the tab, its badge and anyone else
  // with the page open share it.
  const running = inflight.get(key)
  if (running) return running

  const job = (async (): Promise<AlarmsAnswer> => {
    let found: { alarms: EvidenceAlarm[]; partial: boolean }
    try {
      found = await findEvidence(ids, devices, from, to)
    } catch (err) {
      if (hit) return { ...hit.value, stale: true }      // an older answer beats an empty inbox
      throw err
    }
    const need = found.alarms.filter((a) => a.gps === '' || a.type === 0).sort((x, y) => y.time.localeCompare(x.time))
    await alarmDetails(need.map((a) => a.guid))

    const incidents: DashcamIncident[] = []
    for (const a of found.alarms) {
      const dev = devices.get(a.deviceId)
      if (!dev) continue
      const d = details.get(a.guid)
      const code = a.type || d?.y || 0
      const ev = vssEvent(code)
      const occurred = fromVssTime(d?.t || a.time)
      const [lat, lng] = vssGps(a.gps || d?.g)
      const chName = new Map(dev.channels.map((c) => [c.no, c.name]))
      const videos: Media[] = [], photos: Media[] = []
      a.files.forEach((f, i) => {
        if (!f.url) return
        const m: Media = { key: `f${i}`, label: cameraLabel(chName.get(f.channel), f.channel),
                           url: fileLink(orgId, f.url), download: fileLink(orgId, f.url, true) }
        if (f.type === 1 || f.type === 2) videos.push(m)
        else if (f.type === 3 || f.type === 4) photos.push(m)
      })
      const speed = d?.s !== undefined && d.s !== '' && Number.isFinite(Number(d.s)) ? Math.round(Number(d.s)) : null
      incidents.push({
        id: a.guid, code, label: ev.name, group: ev.group,
        severity: ev.severity === 'info' ? 'informational' : ev.severity,
        category: vssCategory(code),
        occurredAt: occurred !== null ? new Date(occurred).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
        vehicleId: dev.vehicleId, plate: dev.plate, deviceId: a.deviceId,
        lat, lng, speed, videos, photos,
      })
    }
    incidents.sort((x, y) => String(y.occurredAt).localeCompare(String(x.occurredAt)))
    const value: AlarmsAnswer = { incidents, cameras: devices.size, from, to, ...(found.partial ? { partial: true } : {}) }
    answers.set(key, { at: Date.now(), value })
    return value
  })()
  inflight.set(key, job)
  try { return await job } finally { inflight.delete(key) }
}

/** For tests: forget everything held in memory, and optionally shorten the search gap. */
export function resetDashcamState(searchGapMs = 10_000): void {
  vehiclesByOrg.clear(); details.clear(); files.clear(); answers.clear(); inflight.clear()
  lastSearchAt = 0
  SEARCH_GAP_MS = searchGapMs
}
