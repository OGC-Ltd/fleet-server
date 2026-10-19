/**
 * One feed line per movement, not one per boundary.
 *
 * A unit coming in through the Sukari gate crosses the barrier, the factory
 * fence and the compound fence a minute or two apart, and each of those has its
 * own emitter (yard-departure, zone-presence, FactorySuite's gate events). The
 * feed said, operator screenshot 2026-10-16:
 *
 *   01:33  KTCC 774G · Ramadhan Kanduyi Murefu arrived at the gate.
 *   01:34  KTCC 774G · Ramadhan Kanduyi Murefu arrived at Sukari Indurstries Factory.
 *   01:35  KTCC 774G · Ramadhan Kanduyi Murefu cleared the gate.
 *
 * So the first movement line for a vehicle opens a five-minute window, every
 * related line for that vehicle inside it joins, and at the end of the window
 * ONE line goes to the live feed:
 *
 *   KTCC 774G · Ramadhan Kanduyi Murefu arrived at the gate (01:33), arrived at
 *   Sukari Indurstries Factory (01:34) and cleared the gate (01:35).
 *
 * ## Only the feed is grouped, never the record
 *
 * Postgres still gets one row per event, at once. Reports read those rows by
 * type — machine-operations counts ZONE_ENTRY, operations-report and the
 * vehicle brief read MOVEMENT_EXIT, playback draws every one — and a combined
 * row would break all of them. What is held back is the SSE frame and the
 * Redis feed cache. Reads that fall through to Postgres group the rows with the
 * same rule (`groupMovementItems`), so a reload shows what the live feed did.
 *
 * Breaches and anything warning/critical are never held: an operator must see
 * a restricted-zone entry the moment it happens.
 */

import type { NotificationItem } from './notification-cache.js'

/** How long the first movement line waits for related ones. */
export const MOVEMENT_WINDOW_MS = 5 * 60_000

const GROUPABLE_TYPES = new Set(['ZONE_ENTRY', 'ZONE_EXIT', 'MOVEMENT_ENTRY', 'MOVEMENT_EXIT'])

const SEVERITY_RANK: Record<string, number> = { info: 0, success: 1, warning: 2, critical: 3 }

/**
 * Which vehicle a line is about. By PLATE first: FactorySuite's gate lines
 * ("left the yard", "returned to the yard") carry the plate but no vehicleId,
 * and setting one on their rows would make the operations report count them as
 * extra departures. Spacing and case are ignored, since the provider's plate
 * and ours are written differently.
 */
function movementKey(i: { vehicleId?: string | null; plate?: string | null }): string | null {
  if (i.plate) return `p:${i.plate.replace(/\s+/g, '').toUpperCase()}`
  return i.vehicleId ? `v:${i.vehicleId}` : null
}

/** A routine crossing that belongs to a vehicle — the only kind worth holding. */
export function isGroupableMovement(i: {
  alertType?: string | null; vehicleId?: string | null; plate?: string | null; severity?: string; type?: string
}): boolean {
  const sev = i.severity ?? i.type ?? ''
  return movementKey(i) != null
    && GROUPABLE_TYPES.has(i.alertType ?? '')
    && (sev === 'info' || sev === 'success')
}

/**
 * The shared subject of every line — "KTCC 774G · Ramadhan Kanduyi Murefu " —
 * the plate, then the driver's name as the capitalised words before the verb.
 * Not a plain common prefix: two "arrived at …" lines share the verb too, and
 * "arrived at the gate and Sukari Factory" reads as one place. Null when the
 * lines do not all open with it, and they are then quoted whole.
 */
function sharedSubject(texts: string[], plate: string | null): string | null {
  if (!plate || !texts[0]!.startsWith(plate + ' ')) return null
  let subject = plate + ' '
  const rest = texts[0]!.slice(subject.length)
  const named = /^· ((?:[A-Z][^\s]*\s)+)/.exec(rest)
  if (named) subject += '· ' + named[1]
  // Every line must open with it and keep something to say after it.
  if (texts.some(t => !t.startsWith(subject) || t.length <= subject.length)) return null
  return subject
}

/** "a", "a and b", "a, b and c". */
function list(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * Fold several feed items for one vehicle into one. Pure; `members` in any
 * order. One member comes back unchanged — a lone crossing reads exactly as it
 * always did, only later.
 */
export function combineMovementItems(members: NotificationItem[]): NotificationItem {
  const sorted = [...members].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  if (sorted.length === 1) return sorted[0]!

  const first = sorted[0]!
  const last  = sorted[sorted.length - 1]!
  const texts = sorted.map(m => m.text)
  const subject = sharedSubject(texts, last.plate ?? first.plate ?? null)

  let text: string
  if (subject) {
    // The bounded departure carries a second sentence ("The departure time was
    // not observed…"); the time goes after the first, the rest trails the line.
    const trailing: string[] = []
    const clauses = sorted.map(m => {
      const body = m.text.slice(subject.length).replace(/\.\s*$/, '')
      const stop = body.indexOf('. ')
      if (stop >= 0) trailing.push(body.slice(stop + 2) + '.')
      return `${stop >= 0 ? body.slice(0, stop) : body} (${m.time})`
    })
    text = `${subject}${list(clauses)}.${trailing.length ? ' ' + trailing.join(' ') : ''}`
  } else {
    text = sorted.map(m => `${m.time} ${m.text}`).join(' ')
  }

  const type = sorted.reduce(
    (best, m) => ((SEVERITY_RANK[m.type] ?? 0) > (SEVERITY_RANK[best] ?? 0) ? m.type : best), first.type)

  return {
    ...last,
    // Stable for the same group whichever path builds it — live or a read.
    id:   `mg-${sorted.find(m => m.vehicleId)?.vehicleId ?? movementKey(first)}-${Date.parse(first.ts)}`,
    vehicleId: sorted.find(m => m.vehicleId)?.vehicleId ?? null,
    type,
    text,
    // Placed at its FIRST event. Paging back uses `before = oldest ts on the
    // page`; stamped with its newest event instead, a group's earlier members
    // would be older than the cursor and come back on the next page.
    time: first.time,
    ts:   first.ts,
    groupedIds: sorted.map(m => m.id),
  }
}

/**
 * The read-side twin of the live window: group a page of feed items (any
 * order) the way the live feed would have, and return it newest first.
 *
 * Grouped by the events' own times — a window opens on a vehicle's first
 * movement and takes everything within MOVEMENT_WINDOW_MS of it.
 *
 * A group whose window is still open at `nowMs` is left out: the live feed has
 * not said it yet, and will, as one line. Returned here it would show half a
 * group that then changes id when the full line lands.
 */
export function groupMovementItems(items: NotificationItem[], nowMs = Date.now()): NotificationItem[] {
  const asc = [...items].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  const open = new Map<string, { startMs: number; members: NotificationItem[] }>()
  const out: NotificationItem[] = []

  const close = (key: string) => {
    const g = open.get(key)
    if (!g) return
    open.delete(key)
    if (nowMs - g.startMs < MOVEMENT_WINDOW_MS) return
    out.push(combineMovementItems(g.members))
  }

  for (const it of asc) {
    if (!isGroupableMovement(it)) { out.push(it); continue }
    const key = movementKey(it)!
    const ms  = Date.parse(it.ts)
    const g   = open.get(key)
    if (g && ms - g.startMs <= MOVEMENT_WINDOW_MS) { g.members.push(it); continue }
    close(key)
    open.set(key, { startMs: ms, members: [it] })
  }
  for (const key of [...open.keys()]) close(key)

  return out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
}

// ── the live window ────────────────────────────────────────────────────────

interface Pending {
  orgId:   string
  startMs: number
  members: Map<string, NotificationItem>
  timer:   ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()

type Emit = (orgId: string, item: NotificationItem) => void

/**
 * Hold a movement item for its vehicle's window. The first one opens the
 * window and arms the timer; later ones join it. A republish of the same id
 * replaces its earlier version. An item whose own time is already past the
 * window (a backlog arriving late) closes the open group and starts the next.
 */
export function holdMovement(orgId: string, item: NotificationItem, emit: Emit): void {
  const key = `${orgId}:${movementKey(item)}`
  const ms  = Date.parse(item.ts)
  const g   = pending.get(key)

  if (g && ms - g.startMs <= MOVEMENT_WINDOW_MS) {
    g.members.set(item.id, item)
    return
  }
  if (g) flush(key, emit)

  const timer = setTimeout(() => flush(key, emit), MOVEMENT_WINDOW_MS)
  timer.unref?.()
  pending.set(key, { orgId, startMs: ms, members: new Map([[item.id, item]]), timer })
}

function flush(key: string, emit: Emit): void {
  const g = pending.get(key)
  if (!g) return
  pending.delete(key)
  clearTimeout(g.timer)
  emit(g.orgId, combineMovementItems([...g.members.values()]))
}

let shutdownEmit: Emit | null = null

/** Registered by the store so shutdown can release what is still held. */
export function setMovementEmitter(emit: Emit): void {
  shutdownEmit = emit
}

/**
 * Emit every open window now. Called on shutdown: a restart must not swallow
 * up to five minutes of the feed (the rows are in Postgres either way).
 */
export function flushAllMovementWindows(): void {
  if (!shutdownEmit) return
  for (const key of [...pending.keys()]) flush(key, shutdownEmit)
}

/** Tests only. */
export function __resetMovementWindows(): void {
  for (const g of pending.values()) clearTimeout(g.timer)
  pending.clear()
}
