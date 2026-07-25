/**
 * Alert backfill / reconciliation — Controltech EA (factorysuite).
 *
 * Alerts normally arrive by WEBHOOK (POST /api/v1/webhooks/controltech/alerts)
 * so we don't poll. This script exists for the two cases a push model can't
 * cover by itself:
 *
 *   • BACKFILL — load the alerts that already existed before the webhook was
 *     wired up, so the feed and history aren't empty on day one.
 *   • RECONCILE — a safety net if the provider's callback fails or we were
 *     down during a delivery. Safe to run on a slow schedule (e.g. hourly);
 *     it is NOT a substitute for the webhook and must not run every 30 s.
 *
 * Idempotent: rows upsert on the provider's alert id, so overlapping with live
 * webhook traffic never duplicates.
 *
 * By default nothing is pushed to the live feed — a catch-up of hundreds of
 * historical alerts would flood it. Pass --emit to publish genuinely new rows
 * (useful when reconciling a short outage).
 *
 * Run: npm run sync:alerts  [-- --emit] [-- --limit=500]
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env.DIRECT_URL })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const API_URL = process.env.CONTROLTECH_API_URL ?? 'https://factorysuite.org/api/external/v1'
const API_KEY = process.env.CONTROLTECH_API_KEY ?? ''

const args  = process.argv.slice(2)
const EMIT  = args.includes('--emit')
const LIMIT = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? 500)

async function main() {
  if (!API_KEY) throw new Error('CONTROLTECH_API_KEY is not set')
  console.log(`\n🔄  Alert ${EMIT ? 'reconcile' : 'backfill'} — ${API_URL}\n`)

  const res = await fetch(`${API_URL}/alerts?limit=${LIMIT}`, {
    headers: { accept: 'application/json', 'X-API-Key': API_KEY },
  })
  if (!res.ok) throw new Error(`Controltech /alerts responded ${res.status}`)
  const body = await res.json() as unknown
  const alerts = (Array.isArray(body) ? body : (body as { data?: unknown[] }).data ?? []) as never[]
  if (alerts.length === 0) {
    console.log('  ← no alerts returned — nothing to do.\n')
    return
  }
  console.log(`  ← ${alerts.length} alerts from provider`)

  // The intake service is shared with the webhook receiver, so classification,
  // plate resolution and dedupe behave identically on both paths. It imports
  // the app's prisma singleton, hence the dynamic import after dotenv.
  const { ingestAlerts } = await import('../src/modules/webhooks/controltech-alerts.service.js')
  const result = await ingestAlerts(alerts, 'backfill', EMIT)

  console.log(`  ✓ created ${result.created}, already present ${result.updated}, skipped ${result.skipped} (unmapped factory)`)

  const total   = await prisma.providerAlert.count()
  const byType  = await prisma.providerAlert.groupBy({ by: ['type'], _count: { _all: true } })
  const unmatched = await prisma.providerAlert.count({ where: { vehicleId: null } })
  console.log(`  ✓ stored: ${byType.map(t => `${t.type} ${t._count._all}`).join(', ')}`)
  console.log(`  ✓ ${total - unmatched}/${total} linked to a vehicle (${unmatched} concern a person or an unknown plate)`)
  console.log(`\n✅  Done.${EMIT ? '' : '  (live feed not touched — pass --emit to publish new ones)'}\n`)
}

main()
  .catch(err => {
    console.error('\n❌  sync-alerts failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
