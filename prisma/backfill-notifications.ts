/**
 * Backfill `notifications` from alert history that predates that table.
 *
 * Why this is needed
 * ------------------
 * The Live Feed reads the `notifications` table. Rows land there via
 * `publishNotification`, which the intake path calls only when it CREATES a
 * provider alert. Every alert that already existed when the table was
 * introduced therefore has no feed row — and never will, because
 * `ingestAlerts` reports `created: 0` for them on every subsequent reconcile.
 *
 * The visible symptom: SUKARI held 301 real provider alerts and its Live Feed
 * was permanently empty, while KASULU's feed worked because its zone crossings
 * are generated continuously and go through publishNotification as they happen.
 *
 * Safe to re-run: rows are upserted on `feedId`, the same key the live path
 * uses (`pa-<providerAlert.id>`), so a second pass updates rather than
 * duplicates. It writes ONLY to `notifications` — no SSE, no banners, no Web
 * Push — so backfilling history can never notify anybody.
 *
 * Run: npm run backfill:notifications  [-- --limit=5000]
 */

import 'dotenv/config'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'

const pool    = new pg.Pool({ connectionString: process.env['DIRECT_URL'] })
const adapter = new PrismaPg(pool)
const prisma  = new PrismaClient({ adapter })

const args  = process.argv.slice(2)
const LIMIT = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? 5000)

async function main() {
  console.log(`\n🔄  Backfilling notifications from provider_alerts (limit ${LIMIT})\n`)

  const alerts = await prisma.providerAlert.findMany({
    orderBy: { createdAt: 'desc' },
    take:    LIMIT,
    select: {
      id: true, organisationId: true, type: true, severity: true,
      message: true, plate: true, vehicleId: true, createdAt: true, source: true,
    },
  })

  let created = 0
  let updated = 0

  for (const a of alerts) {
    const feedId = `pa-${a.id}`      // must match publishToFeed's id exactly
    const existing = await prisma.notification.findUnique({
      where: { feedId }, select: { id: true },
    })

    await prisma.notification.upsert({
      where: { feedId },
      create: {
        feedId,
        organisationId: a.organisationId,
        vehicleId:      a.vehicleId,
        // `source` on provider_alerts is the STORED provider tag
        // ('controltech' / 'wialon') — carried through verbatim so the feed
        // reads identically to a live item.
        source:         a.source === 'backfill' || a.source === 'webhook' ? 'controltech' : a.source,
        alertType:      a.type,
        severity:       a.severity,
        text:           a.message,
        plate:          a.plate,
        occurredAt:     a.createdAt,
      },
      update: {
        severity:   a.severity,
        text:       a.message,
        plate:      a.plate,
        vehicleId:  a.vehicleId,
        occurredAt: a.createdAt,
      },
    })

    if (existing) updated++
    else created++
  }

  console.log(`  ✓ ${created} created, ${updated} already present`)

  const byOrg = await prisma.notification.groupBy({
    by: ['organisationId'], _count: { _all: true },
  })
  for (const row of byOrg) {
    const org = await prisma.organisation.findUnique({
      where: { id: row.organisationId }, select: { code: true },
    })
    console.log(`  ✓ ${org?.code ?? row.organisationId}: ${row._count._all} notifications`)
  }
  console.log('\n✅  Done.\n')
}

main()
  .catch((err) => { console.error('❌ ', err); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
