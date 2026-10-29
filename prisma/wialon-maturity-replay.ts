/**
 * READ-ONLY. When does Wialon first report a drain to the live sync?
 *
 * For each SIPHON announced more than an hour after it began (since a date),
 * re-runs the unit's per-unit fuel report the way a live cycle would — a 3 h
 * window ending at detectedAt + k minutes — and prints the first k at which the
 * drain is in the answer. Nothing is written to the database or the feed.
 *
 *   node wialon-maturity-replay.cjs [sinceISO]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import dotenv from 'dotenv'
import pg from 'pg'
import { WialonClient } from '../src/providers/wialon/wialon.client.js'
import { fetchUnitFuelEvents, listReportTemplates } from '../src/providers/wialon/wialon.reports.js'
import {
  KASULU_WIALON_ACCOUNT_ID, MENENGAI_WIALON_ACCOUNT_ID, WEST_SUGAR_REPORT_RESOURCE_ID, AQUAMIST_RESOURCE_ID,
} from '../src/providers/wialon/wialon.account.js'

// fuel-sync.service's ORG_RESOURCES, copied: importing that module opens Prisma.
const ORG_RESOURCES = [
  { code: 'KASULU',    resourceId: KASULU_WIALON_ACCOUNT_ID },
  { code: 'SUKARI',    resourceId: 28843152 },
  { code: 'MENENGAI',  resourceId: MENENGAI_WIALON_ACCOUNT_ID },
  { code: 'WESTSUGAR', resourceId: WEST_SUGAR_REPORT_RESOURCE_ID },
  { code: 'KABRAS',    resourceId: WEST_SUGAR_REPORT_RESOURCE_ID },
  { code: 'NZOIA',     resourceId: WEST_SUGAR_REPORT_RESOURCE_ID },
  { code: 'AQUAMIST',  resourceId: AQUAMIST_RESOURCE_ID },
]

const since = process.argv[2] ?? '2026-10-23T00:00:00Z'
const OFFSETS_MIN = [5, 15, 30, 45, 60, 90, 120, 150, 180, 240]
const WINDOW_MS = 3 * 60 * 60_000

pg.types.setTypeParser(1114, s => new Date(s.replace(' ', 'T') + 'Z'))
const HM = (d: Date) => d.toISOString().slice(11, 16)
const EAT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

async function main() {
  const env = dotenv.parse(fs.readFileSync(path.join(os.homedir(), 'prod/fleet-server/.env')))
  const c = new pg.Client({ connectionString: env.DIRECT_URL || env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await c.connect()
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
  if ((await c.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on') throw new Error('not read-only')

  const rows = (await c.query(`
    SELECT n.plate, v.device_id, o.code, t.began_at, t.detected_at, n.created_at
      FROM fuel_thefts t
      JOIN notifications n ON n.feed_id = 'fuel-drain-' || t.vehicle_id || '-' || t.id
      JOIN vehicles v ON v.id = t.vehicle_id JOIN organisations o ON o.id = v.organisation_id
     WHERE t.began_at >= $1 AND t.drain_cause = 'SIPHON' AND n.created_at - t.began_at > interval '1 hour'
     AND ($2::text IS NULL OR n.plate = ANY(string_to_array($2, '|')))
     ORDER BY t.began_at`, [since, process.argv[3] ?? null])).rows
  await c.end()

  const client = new WialonClient(env.WIALON_TOKEN || env.access_token || '', env.WIALON_API_URL || undefined)
  const templates = new Map<number, number>()
  const templateFor = async (resourceId: number) => {
    if (!templates.has(resourceId)) {
      const list = await listReportTemplates(client, resourceId)
      const hit = [/advanced\s+fuel\s+analysis/i, /fuel\s+theft/i, /journey\s+and\s+fuel/i]
        .map(p => list.find(t => p.test(t.n ?? '') && (t.ct ?? 'avl_unit') === 'avl_unit')).find(Boolean)
      templates.set(resourceId, hit?.id ?? -1)
    }
    return templates.get(resourceId)!
  }

  console.log('plate           began        posted_after_det  first_seen_after_det (min)  offsets checked')
  for (const r of rows) {
    const resourceId = ORG_RESOURCES.find(o => o.code === r.code)?.resourceId
    const unitId = Number(/^wialon:(\d+)$/.exec(r.device_id ?? '')?.[1])
    if (!resourceId || !unitId) { console.log(r.plate, 'no resource/unit'); continue }
    const templateId = await templateFor(resourceId)
    const det = r.detected_at.getTime(), began = r.began_at.getTime()
    let first: number | null = null
    const seen: string[] = []
    for (const k of OFFSETS_MIN) {
      const to = new Date(det + k * 60_000)
      const from = new Date(to.getTime() - WINDOW_MS)
      try {
        const ev = await fetchUnitFuelEvents(client, { resourceId, templateId, unitId, from, to })
        // Overlaps the stored drain: Wialon re-clamps start and end while it runs.
        // Its own span, not a neighbour's: began within 5 min of the stored start.
        const hit = ev.thefts.find(t => Math.abs(t.beganAt.getTime() - began) <= 5 * 60_000)
        const near = ev.thefts.filter(t => t.detectedAt.getTime() >= began - 2 * 3600_000 && t.beganAt.getTime() <= det + 2 * 3600_000)
          .map(t => `${HM(t.beganAt)}-${HM(t.detectedAt)}/${(t.stolenMl / 1000).toFixed(0)}`).join(',')
        seen.push(`${k}:${hit ? 'Y' : '-'}[${near}]`)
        if (hit) { first = k; break }
      } catch (e) {
        seen.push(`${k}:ERR(${(e as Error).message.slice(0, 40)})`)
      }
    }
    const posted = Math.round((r.created_at.getTime() - det) / 60_000)
    console.log(`${r.plate.padEnd(15)} ${EAT.format(r.began_at).padEnd(12)} ${String(posted).padStart(6)}            ${String(first ?? '>240').padStart(6)}                  ${seen.join(' ')}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
