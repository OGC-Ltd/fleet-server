/**
 * The tracker's odometer at given moments (Weighbridges › Coverage, operator,
 * 18 Nov 2026: a true distance per trip). The page sends each trip's two ends,
 * the unit leaving the bridge empty and coming back laden: mostly one ticket's
 * tare and gross, since 95% of tickets weigh tare first; the difference
 * between the two readings is the run out to the field and back, wherever
 * midnight falls.
 *
 * A reading at a moment is interpolated between the unit's stored readings on
 * either side of it within READ_WINDOW_MS; with a reading on one side only, it
 * is that reading, when within NEAR_MS. A day whose rows mostly carry no
 * reading is filled from Wialon first, through unit-distance, so the same
 * pull-then-store applies; a day still being pulled answers `pending` for the
 * page to ask again. A settled moment's reading is kept for 7 days.
 */

import { reportDb } from '../../lib/report-db.js'
import { prisma } from '../../lib/prisma.js'
import { unitDistance, BUDGET_MS } from './unit-distance.service.js'
import { readOdoAt, keepOdoAt, SETTLE_MS } from './day-km.cache.js'

/** How far either side of a moment a reading is looked for. */
export const READ_WINDOW_MS = 2 * 3_600_000
/** A reading on one side only stands for the moment when this close to it. */
export const NEAR_MS = 20 * 60_000
export const MAX_POINTS = 2_000

export interface OdoPoint { vehicleId: string; at: string }
export interface OdoAt { vehicleId: string; at: string; odometerM: number | null; pending: boolean }

/** The fleet day (Nairobi, UTC+3) a moment falls on. */
export const fleetDayOf = (ms: number) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10)

/** The reading at `t` from the nearest readings before and after it (unix ms), or null. */
export function readingAt(t: number, before: { t: number; m: number } | null, after: { t: number; m: number } | null): number | null {
  if (before && after) {
    if (after.t <= before.t) return before.m
    return Math.round(before.m + ((after.m - before.m) * (t - before.t)) / (after.t - before.t))
  }
  if (before && t - before.t <= NEAR_MS) return before.m
  if (after && after.t - t <= NEAR_MS) return after.m
  return null
}

export async function odometerAt(orgId: string, scope: Set<string> | null, points: OdoPoint[], now = Date.now()) {
  const wanted = points.slice(0, MAX_POINTS)
  const ids = [...new Set(wanted.map((p) => p.vehicleId))].filter((id) => !scope || scope.has(id))
  const owned = new Set((await prisma.vehicle.findMany({
    where: { organisationId: orgId, id: { in: ids } }, select: { id: true },
  })).map((v) => v.id))
  const valid = wanted
    .map((p) => ({ ...p, t: Date.parse(p.at) }))
    .filter((p) => owned.has(p.vehicleId) && Number.isFinite(p.t) && p.t <= now)

  // Fill the days touched from Wialon where their rows mostly carry no reading
  const start = Date.now()
  const pendingDay = new Set<string>()
  const byDay = new Map<string, Set<string>>()
  for (const p of valid) {
    const d = fleetDayOf(p.t)
    if (!byDay.has(d)) byDay.set(d, new Set())
    byDay.get(d)!.add(p.vehicleId)
  }
  for (const [day, dayIds] of [...byDay].sort(([a], [b]) => (a < b ? 1 : -1))) {
    if (Date.now() - start >= BUDGET_MS) { for (const id of dayIds) pendingDay.add(`${id}|${day}`); continue }
    const r = await unitDistance(orgId, scope, day, [...dayIds], now)
    for (const row of r.rows) if (row.pending) pendingDay.add(`${row.vehicleId}|${day}`)
  }

  const isPending = (p: { vehicleId: string; t: number }) => pendingDay.has(`${p.vehicleId}|${fleetDayOf(p.t)}`)
  const settled = (t: number) => t + READ_WINDOW_MS < now - SETTLE_MS
  const ready = valid.filter((p) => !isPending(p))
  const cached = await readOdoAt(ready.filter((p) => settled(p.t)).map((p) => [p.vehicleId, p.t]), now)
  const ask = ready.filter((p) => !cached.has(`${p.vehicleId}|${p.t}`))

  const got = new Map<string, number | null>()
  if (ask.length) {
    const rows = await reportDb().$queryRaw<Array<{ i: number | bigint; bm: number | null; bt: number | null; am: number | null; at: number | null }>>`
      SELECT p.i, b.odometer_m AS bm, (EXTRACT(EPOCH FROM b.captured_at) * 1000)::float8 AS bt,
             a.odometer_m AS am, (EXTRACT(EPOCH FROM a.captured_at) * 1000)::float8 AS at
        FROM unnest(${ask.map((p) => p.vehicleId)}::text[], ${ask.map((p) => new Date(p.t).toISOString())}::text[])
             WITH ORDINALITY AS p(vid, ts, i)
        LEFT JOIN LATERAL (
          SELECT t.odometer_m, t.captured_at FROM vehicle_telemetries t
           WHERE t.vehicle_id = p.vid AND t.odometer_m IS NOT NULL
             AND t.captured_at <= (p.ts::timestamptz AT TIME ZONE 'UTC')
             AND t.captured_at > (p.ts::timestamptz AT TIME ZONE 'UTC') - make_interval(secs => ${READ_WINDOW_MS / 1000})
           ORDER BY t.captured_at DESC LIMIT 1) b ON true
        LEFT JOIN LATERAL (
          SELECT t.odometer_m, t.captured_at FROM vehicle_telemetries t
           WHERE t.vehicle_id = p.vid AND t.odometer_m IS NOT NULL
             AND t.captured_at >= (p.ts::timestamptz AT TIME ZONE 'UTC')
             AND t.captured_at < (p.ts::timestamptz AT TIME ZONE 'UTC') + make_interval(secs => ${READ_WINDOW_MS / 1000})
           ORDER BY t.captured_at ASC LIMIT 1) a ON true`
    const keep: [string, number, number | null][] = []
    for (const r of rows) {
      const p = ask[Number(r.i) - 1]!
      const m = readingAt(p.t,
        r.bm != null && r.bt != null ? { t: Number(r.bt), m: Number(r.bm) } : null,
        r.am != null && r.at != null ? { t: Number(r.at), m: Number(r.am) } : null)
      got.set(`${p.vehicleId}|${p.t}`, m)
      if (settled(p.t)) keep.push([p.vehicleId, p.t, m])
    }
    await keepOdoAt(keep, now)
  }

  const validKeys = new Set(valid.map((p) => `${p.vehicleId}|${p.t}`))
  const readings: OdoAt[] = wanted.map((p) => {
    const t = Date.parse(p.at)
    const key = `${p.vehicleId}|${t}`
    if (!validKeys.has(key)) return { vehicleId: p.vehicleId, at: p.at, odometerM: null, pending: false }
    if (isPending({ vehicleId: p.vehicleId, t })) return { vehicleId: p.vehicleId, at: p.at, odometerM: null, pending: true }
    return { vehicleId: p.vehicleId, at: p.at, odometerM: cached.has(key) ? cached.get(key)! : got.get(key) ?? null, pending: false }
  })
  return { readings, pending: readings.filter((r) => r.pending).length }
}
