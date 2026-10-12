/**
 * A database client for report reads, on its own small pool.
 *
 * The live pool (lib/prisma, 14 connections) carries telemetry ingest, the
 * fuel cycle and every interactive request. A Fuel Report reads a unit's whole
 * period, and 300 people running one at once put ~27,000 day queries through
 * that same pool (2026-10-10 review), queueing new GPS fixes behind them: the
 * map would go stale while reports ran. Reads that serve a report come through
 * here instead, at most REPORT_DB_POOL_MAX at a time, so a wave of reports
 * queues behind itself and nothing else.
 *
 * Created on first use: a process that never runs a report never opens it.
 */

import { PrismaClient } from '../../generated/prisma/client.js'
import { PrismaPg } from '@prisma/adapter-pg'
import { env } from '../config/env.js'

let client: PrismaClient | null = null

export function reportDb(): PrismaClient {
  if (!client) {
    const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: env.REPORT_DB_POOL_MAX, query_timeout: 60_000 })
    client = new PrismaClient({ adapter })
  }
  return client
}

export async function disconnectReportDb(): Promise<void> {
  if (!client) return
  const c = client
  client = null
  await c.$disconnect()
}
