/**
 * A lookup cache that outlives the process — the Logbook's place names and
 * businesses from OpenStreetMap, and the model's reading of a name.
 *
 * Measured 2026-10-09: a two-month Logbook spent 29 s of its 34 s naming
 * places (Nominatim asks for one request a second), and every deploy emptied
 * the in-memory caches, so the next Logbook named everything again — the
 * operator saw three minutes from Build to PDF. Fleet units stop at the same
 * factories, yards and towns, so answers kept on disk make a second Logbook of
 * any unit there almost free.
 *
 * Kept as one JSON file per cache under <cwd>/.cache/usage-review (git-ignored),
 * read on first use and written a few seconds after the last change, through a
 * temporary file so a crash never leaves half a file. Never throws: a missing
 * or unreadable file is an empty cache.
 */

import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../../lib/logger.js'

const DIR = process.env['USAGE_REVIEW_CACHE_DIR'] || path.resolve(process.cwd(), '.cache', 'usage-review')
/** Under the tests, kept in memory only unless a directory is named: one run's
 *  answers must not answer the next. */
const PERSIST = !process.env['VITEST'] || !!process.env['USAGE_REVIEW_CACHE_DIR']
const SAVE_AFTER_MS = 3_000

type Entry<V> = { v: V; t: number }

export interface Store<V> {
  /** The kept answer, or undefined when none is kept (or it has expired). */
  get(k: string): V | undefined
  has(k: string): boolean
  set(k: string, v: V): void
  readonly size: number
}

/** Write every store's pending changes now — for the tests, and a clean exit. */
export function flushStores() { for (const f of flushers) f() }
const flushers = new Set<() => void>()

/**
 * @param name the file's name, without extension
 * @param o.hitTtlMs how long an answer is kept; `o.missTtlMs` for a null one
 */
export function persistentStore<V>(name: string, o: { hitTtlMs: number; missTtlMs: number; max: number }): Store<V> {
  const file = path.join(DIR, `${name}.json`)
  let map: Map<string, Entry<V>> | null = null
  let timer: NodeJS.Timeout | null = null

  const load = () => {
    if (map) return map
    map = new Map()
    if (!PERSIST) return map
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Entry<V>>
      for (const [k, e] of Object.entries(raw)) if (e && typeof e.t === 'number') map.set(k, e)
    } catch { /* no file yet, or unreadable: start empty */ }
    return map
  }
  const fresh = (e: Entry<V>) => Date.now() - e.t < (e.v == null ? o.missTtlMs : o.hitTtlMs)
  const save = () => {
    timer = null
    try {
      fs.mkdirSync(DIR, { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(load())))
      fs.renameSync(tmp, file)
    } catch (err) {
      logger.warn({ err: (err as Error).message, file }, 'Usage review: lookup cache not saved')
    }
  }

  flushers.add(() => { if (timer) { clearTimeout(timer); save() } })
  return {
    get(k) {
      const e = load().get(k)
      if (!e) return undefined
      if (!fresh(e)) { load().delete(k); return undefined }
      return e.v
    },
    has(k) { return this.get(k) !== undefined },
    set(k, v) {
      const m = load()
      m.delete(k)
      if (m.size >= o.max) m.delete(m.keys().next().value!)
      m.set(k, { v, t: Date.now() })
      if (PERSIST && !timer) { timer = setTimeout(save, SAVE_AFTER_MS); timer.unref?.() }
    },
    get size() { return load().size },
  }
}
