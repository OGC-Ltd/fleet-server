/**
 * Finished fleet days of a unit's readings, shared by every Fuel Report
 * (2026-10-10: "300+ users generating reports").
 *
 * The page used to read a report's period a day at a time, each day its own
 * request and its own query, and each browser kept only its own copy: 300
 * people on one unit's month ran the same 30 queries 300 times. A finished day
 * does not change, so it is read once and kept here, as the JSON the response
 * carries, for everyone:
 *
 *   · in memory, up to FUEL_DAY_CACHE_MB, least recently used out first;
 *   · on disk under <cwd>/.cache/fuel-days (git-ignored), up to
 *     FUEL_DAY_DISK_MB, so a restart does not empty it.
 *
 * "Finished" is SETTLE_MS after the day ended: a tracker that was out of
 * coverage uploads what it held when it is back, and those readings land
 * behind the day. Kept for TTL_MS, then read again — a late upload is never
 * missing for longer than that.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { env } from '../../config/env.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

export const SETTLE_MS = 2 * 3_600_000
export const TTL_MS = 24 * 3_600_000

const dir = () => process.env['FUEL_DAY_CACHE_DIR'] || path.resolve(process.cwd(), '.cache', 'fuel-days')
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
/** Bumped when the day's columns change, so a day kept before is read again.
 *  2: `alt`; 3: `vext`, `vint` (2026-10-13). */
const FORMAT = 3
const fileOf = (vehicleId: string, day: string) => path.join(dir(), safe(vehicleId), `${safe(day)}.v${FORMAT}.json.gz`)

/** Whether a day that ended at `endMs` is finished enough to keep. */
export const settled = (endMs: number, now = Date.now()) => now - endMs >= SETTLE_MS

const mem = new Map<string, { json: string; at: number }>()
let memBytes = 0
const keyOf = (vehicleId: string, day: string) => `${vehicleId}|${day}|v${FORMAT}`

function remember(key: string, json: string, at: number) {
  const old = mem.get(key)
  if (old) { memBytes -= old.json.length * 2; mem.delete(key) }
  mem.set(key, { json, at })
  memBytes += json.length * 2
  const cap = env.FUEL_DAY_CACHE_MB * 1024 * 1024
  while (memBytes > cap && mem.size > 1) {
    const [k, v] = mem.entries().next().value!
    mem.delete(k)
    memBytes -= v.json.length * 2
  }
}

/** The day's response JSON, when it is kept and still fresh; else null. */
export async function cachedDay(vehicleId: string, day: string, now = Date.now()): Promise<string | null> {
  const key = keyOf(vehicleId, day)
  const hit = mem.get(key)
  if (hit) {
    if (now - hit.at < TTL_MS) { mem.delete(key); mem.set(key, hit); return hit.json }
    mem.delete(key)
    memBytes -= hit.json.length * 2
  }
  const f = fileOf(vehicleId, day)
  const st = await fs.stat(f).catch(() => null)
  if (!st || now - st.mtimeMs >= TTL_MS) return null
  try {
    const json = (await gunzip(await fs.readFile(f))).toString('utf8')
    remember(key, json, st.mtimeMs)
    return json
  } catch { return null }
}

let lastSweep = 0

/** Keeps a finished day's JSON, in memory and on disk. Never throws. */
export async function keepDay(vehicleId: string, day: string, json: string, now = Date.now()): Promise<void> {
  remember(keyOf(vehicleId, day), json, now)
  try {
    const f = fileOf(vehicleId, day)
    await fs.mkdir(path.dirname(f), { recursive: true })
    const tmp = `${f}.${process.pid}-${now}`
    await fs.writeFile(tmp, await gzip(json))
    await fs.rename(tmp, f)
  } catch { /* the memory copy still serves */ }
  if (now - lastSweep > 3_600_000) {
    lastSweep = now
    void sweepDays(now).catch(() => {})
  }
}

/** Drops expired days from disk, then the oldest until under FUEL_DAY_DISK_MB. */
export async function sweepDays(now = Date.now()): Promise<{ removed: number; bytes: number }> {
  const files: { f: string; at: number; size: number }[] = []
  for (const v of await fs.readdir(dir(), { withFileTypes: true }).catch(() => [])) {
    if (!v.isDirectory()) continue
    for (const d of await fs.readdir(path.join(dir(), v.name)).catch(() => [] as string[])) {
      const f = path.join(dir(), v.name, d)
      const st = await fs.stat(f).catch(() => null)
      if (st) files.push({ f, at: st.mtimeMs, size: st.size })
    }
  }
  let removed = 0
  let bytes = files.reduce((a, x) => a + x.size, 0)
  const cap = env.FUEL_DAY_DISK_MB * 1024 * 1024
  for (const x of files.sort((a, b) => a.at - b.at)) {
    if (now - x.at < TTL_MS && bytes <= cap) break
    await fs.rm(x.f, { force: true })
    bytes -= x.size
    removed++
  }
  return { removed, bytes }
}

/** Tests only. */
export function _clearDayMemory() { mem.clear(); memBytes = 0; lastSweep = 0 }
