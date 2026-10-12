/**
 * Finished Logbook reviews, kept on disk (2026-10-10: "300+ users generating
 * reports"). A past period never changes, so a review built once is the
 * answer for everyone who asks for that unit and those dates, until the build
 * itself changes (SAVED_FORMAT). It used to live in the API process's memory,
 * 60 at most: a busy hour pushed out reviews before their PDFs were fetched,
 * so they were built again, and every restart lost the lot.
 *
 * One directory per review, under REPORT_STORE_DIR (default
 * <cwd>/.cache/reports, git-ignored):
 *
 *   review.json.gz       the review without its GPS fixes: what the page,
 *                        the PDF and the Site Visits need;
 *   points/<date>.json.gz each day's fixes, for the workbook and for one day's
 *                        track on the page, read a day at a time;
 *   files/<name>         a PDF or workbook already rendered from it;
 *   used                 touched when it is read: the least recently used go
 *                        first when the store is over REPORT_STORE_MAX_MB.
 *
 * Written by the report worker, read by the API process; both on this box.
 * A review is written into a temporary directory and renamed into place, so a
 * reader never sees half of one. Compression runs on libuv's pool, off the
 * event loop.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { eatDay, type ReviewPoint } from './usage-review.compute.js'
import type { ReadyReview } from './usage-review.service.js'

const gzip = promisify(zlib.gzip)
const gunzip = promisify(zlib.gunzip)

/** Raised whenever a build's logic or its saved shape changes, so a deploy
 *  never serves a review the old code built. Old formats are swept away. */
export const SAVED_FORMAT = 1

const base = () => process.env['REPORT_STORE_DIR'] || env.REPORT_STORE_DIR || path.resolve(process.cwd(), '.cache', 'reports')
const root = () => path.join(base(), `v${SAVED_FORMAT}`)
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')

/** "org/vehicle/2026-08-01_2026-09-30": one review, whoever asks for it. */
export const reviewKey = (orgId: string, vehicleId: string, from: string, to: string) => `${orgId}/${vehicleId}/${from}_${to}`
const dirOf = (key: string) => path.join(root(), ...key.split('/').map(safe))

/** Parsed reviews this process has read, checked against the file's time. */
const memo = new Map<string, { mtimeMs: number; rv: ReadyReview }>()
const MEMO_MAX = 32
const lastTouch = new Map<string, number>()

async function markUsed(key: string) {
  const now = Date.now()
  if (now - (lastTouch.get(key) ?? 0) < 60_000) return
  lastTouch.set(key, now)
  if (lastTouch.size > 5_000) lastTouch.clear()
  const f = path.join(dirOf(key), 'used')
  await fs.utimes(f, new Date(), new Date()).catch(() => fs.writeFile(f, '').catch(() => {}))
}

/** Keeps a finished review, replacing any held under the same key. */
export async function saveReview(key: string, rv: ReadyReview): Promise<void> {
  const dir = dirOf(key)
  const stamp = `${process.pid}-${Date.now()}`
  const tmp = `${dir}.tmp-${stamp}`
  await fs.mkdir(path.join(tmp, 'points'), { recursive: true })
  try {
    const { points, ...rest } = rv
    await fs.writeFile(path.join(tmp, 'review.json.gz'), await gzip(JSON.stringify({ ...rest, points: [] })))
    const byDay = new Map<string, ReviewPoint[]>()
    for (const p of points) {
      const d = eatDay(p.t)
      const list = byDay.get(d)
      if (list) list.push(p); else byDay.set(d, [p])
    }
    for (const [d, list] of byDay) await fs.writeFile(path.join(tmp, 'points', `${d}.json.gz`), await gzip(JSON.stringify(list)))
    await fs.writeFile(path.join(tmp, 'used'), '')
    // Swapped in: the old one aside, the new one in its place, the old gone.
    const old = `${dir}.old-${stamp}`
    await fs.rename(dir, old).catch(() => {})
    await fs.rename(tmp, dir)
    await fs.rm(old, { recursive: true, force: true })
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  memo.delete(key)
}

/** The review held under `key`, without its fixes (`points` is empty); null
 *  when none is held or it cannot be read. */
export async function loadReview(key: string): Promise<ReadyReview | null> {
  const file = path.join(dirOf(key), 'review.json.gz')
  const st = await fs.stat(file).catch(() => null)
  if (!st) { memo.delete(key); return null }
  const hit = memo.get(key)
  if (hit && hit.mtimeMs === st.mtimeMs) {
    memo.delete(key); memo.set(key, hit)
    void markUsed(key)
    return hit.rv
  }
  try {
    const rv = JSON.parse((await gunzip(await fs.readFile(file))).toString('utf8')) as ReadyReview
    memo.set(key, { mtimeMs: st.mtimeMs, rv })
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!)
    void markUsed(key)
    return rv
  } catch (err) {
    logger.warn({ key, err: (err as Error).message }, 'Logbook: a saved review could not be read')
    return null
  }
}

/** One EAT day's fixes of a held review, or null when the day holds none. */
export async function loadPoints(key: string, date: string): Promise<ReviewPoint[] | null> {
  try {
    return JSON.parse((await gunzip(await fs.readFile(path.join(dirOf(key), 'points', `${safe(date)}.json.gz`)))).toString('utf8')) as ReviewPoint[]
  } catch { return null }
}

/** Every fix of a held review, in order: the workbook's. */
export async function loadAllPoints(key: string): Promise<ReviewPoint[]> {
  const dir = path.join(dirOf(key), 'points')
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.json.gz')).sort()
  const out: ReviewPoint[] = []
  for (const f of files) out.push(...(await loadPoints(key, f.slice(0, -'.json.gz'.length)) ?? []))
  return out
}

/** A PDF or workbook rendered from the review, when it is held. */
export async function savedFile(key: string, name: string): Promise<Buffer | null> {
  return fs.readFile(path.join(dirOf(key), 'files', safe(name))).catch(() => null)
}

export async function saveFile(key: string, name: string, buf: Buffer): Promise<void> {
  const dir = path.join(dirOf(key), 'files')
  // Only beside a review that is held: a file for one swept away is not kept.
  if (!(await fs.stat(path.join(dirOf(key), 'review.json.gz')).catch(() => null))) return
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${safe(name)}.${process.pid}-${Date.now()}`)
  await fs.writeFile(tmp, buf)
  await fs.rename(tmp, path.join(dir, safe(name)))
}

/** Forgets a review (a rebuild asked for). */
export async function dropReview(key: string): Promise<void> {
  memo.delete(key)
  await fs.rm(dirOf(key), { recursive: true, force: true })
}

async function sizeOf(dir: string): Promise<number> {
  let total = 0
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    total += e.isDirectory() ? await sizeOf(p) : (await fs.stat(p).catch(() => null))?.size ?? 0
  }
  return total
}

/**
 * Keeps the store under REPORT_STORE_MAX_MB, least recently used first, and
 * clears what a crash or an older build left: half-written directories and
 * other formats. The worker runs it on start and hourly.
 */
export async function sweepSaved(maxBytes = env.REPORT_STORE_MAX_MB * 1024 * 1024): Promise<{ kept: number; removed: number; bytes: number }> {
  for (const e of await fs.readdir(base(), { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && /^v\d+$/.test(e.name) && e.name !== `v${SAVED_FORMAT}`) await fs.rm(path.join(base(), e.name), { recursive: true, force: true })
  }
  const reviews: { dir: string; used: number; bytes: number }[] = []
  const hourAgo = Date.now() - 3_600_000
  for (const org of await fs.readdir(root(), { withFileTypes: true }).catch(() => [])) {
    if (!org.isDirectory()) continue
    for (const veh of await fs.readdir(path.join(root(), org.name), { withFileTypes: true }).catch(() => [])) {
      if (!veh.isDirectory()) continue
      for (const per of await fs.readdir(path.join(root(), org.name, veh.name), { withFileTypes: true }).catch(() => [])) {
        if (!per.isDirectory()) continue
        const dir = path.join(root(), org.name, veh.name, per.name)
        if (/\.(tmp|old)-/.test(per.name)) {
          const st = await fs.stat(dir).catch(() => null)
          if (st && st.mtimeMs < hourAgo) await fs.rm(dir, { recursive: true, force: true })
          continue
        }
        const used = (await fs.stat(path.join(dir, 'used')).catch(() => null))?.mtimeMs ?? 0
        reviews.push({ dir, used, bytes: await sizeOf(dir) })
      }
    }
  }
  let bytes = reviews.reduce((a, r) => a + r.bytes, 0)
  let removed = 0
  for (const r of reviews.sort((a, b) => a.used - b.used)) {
    if (bytes <= maxBytes) break
    await fs.rm(r.dir, { recursive: true, force: true })
    bytes -= r.bytes
    removed++
  }
  memo.clear()
  return { kept: reviews.length - removed, removed, bytes }
}
