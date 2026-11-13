/**
 * Idle alerts kept (operator, 2026-11-13: "persist that data and have a way
 * to retrieve them from the alerts page"). The watch itself stays in memory;
 * after every check this writes what it found to `idle_episodes`:
 *
 *   - every alert now: its row is created the first time, then brought up to
 *     date (last seen, time stood, where); critical once reached stays so;
 *   - every row still open whose unit is no longer idle: ended now.
 *
 * Keyed by the watch's own alert key (vehicle + stop time), so a restart picks
 * the same stops back up instead of opening new rows.
 */

import { prisma } from '../../lib/prisma.js'
import type { Nearest } from '../stop-watch/stop-watch.rules.js'
import type { IdleAlert } from './idle-watch.rules.js'

type Alert = IdleAlert & { nearest: Nearest | null }

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000))

/** Write one check's alerts; end the rows of units no longer idle. */
export async function saveEpisodes(orgId: string, alerts: readonly Alert[], now: number): Promise<void> {
  const at = new Date(now)
  for (const a of alerts) {
    const seen = {
      lastSeenAt:      at,
      endedAt:         null,
      idleMinutes:     minutes(a.idleMs),
      standingMinutes: minutes(a.standingMs),
      lat:             a.lat,
      lng:             a.lng,
      place:           a.nearest?.name ?? null,
      placeMetres:     a.nearest ? Math.round(a.nearest.metres) : null,
      engineOn:        a.engineOn,
    }
    await prisma.idleEpisode.upsert({
      where:  { key: a.key },
      create: {
        key: a.key, organisationId: orgId, vehicleId: a.vehicleId,
        plate: a.plate, size: a.size, designation: a.designation,
        since: new Date(a.since), sinceExact: a.sinceExact,
        alertedAt: at, severity: a.severity, ...seen,
      },
      // Critical once reached stays critical: the row says how bad it got.
      update: a.severity === 'critical' ? { ...seen, severity: 'critical' } : seen,
    })
  }
  await prisma.idleEpisode.updateMany({
    where: { organisationId: orgId, endedAt: null, key: { notIn: alerts.map((a) => a.key) } },
    data:  { endedAt: at },
  })
}

export interface EpisodeQuery {
  from: Date
  to: Date
  /** Plate, part of one. */
  q?: string
  /** The caller's units, or null for the whole fleet. */
  vehicleIds: Set<string> | null
}

/** At most this many rows a request: a month of a 25-unit list is far below it. */
export const HISTORY_LIMIT = 2000

/** Episodes that overlap [from, to], newest stop first. */
export async function listEpisodes(orgId: string, query: EpisodeQuery) {
  const rows = await prisma.idleEpisode.findMany({
    where: {
      organisationId: orgId,
      since: { lte: query.to },
      OR: [{ endedAt: null }, { endedAt: { gte: query.from } }],
      ...(query.q ? { plate: { contains: query.q.trim(), mode: 'insensitive' as const } } : {}),
      ...(query.vehicleIds ? { vehicleId: { in: [...query.vehicleIds] } } : {}),
    },
    orderBy: { since: 'desc' },
    take:    HISTORY_LIMIT + 1,
  })
  return { rows: rows.slice(0, HISTORY_LIMIT), more: rows.length > HISTORY_LIMIT }
}
