/**
 * Monthly partitions of vehicle_telemetries: keep the months ahead created,
 * and say so when a fix lands outside them.
 *
 * The table is range-partitioned by captured_at, one partition per UTC month
 * (migration 20261125120000_partition_vehicle_telemetries, runbook in
 * docs/telemetry-partitioning.md). The creating is done by the database
 * function `vehicle_telemetries_ensure_partitions`, the same one the migration
 * calls, so the rule lives in one place. This only runs it nightly and reads
 * the result.
 *
 * Three months are kept ahead, so a run that fails for weeks still costs
 * nothing. A fix stamped past the last partition is not refused: it goes to the
 * DEFAULT partition, and the function moves such rows into their month when it
 * creates it. Rows sitting there mean a tracker with a broken clock, or that
 * this job has stopped. Either is worth a person's attention, hence the error
 * log.
 *
 * Before the migration is applied the table is a plain one, and this does
 * nothing.
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'

export const MONTHS_AHEAD = 3

export interface PartitionUpkeep {
  partitioned: boolean
  created:     string[]
  /** Rows in the DEFAULT partition after the run: fixes outside every month. */
  strays:      number
}

export async function maintainTelemetryPartitions(): Promise<PartitionUpkeep> {
  const [table] = await prisma.$queryRaw<{ kind: string }[]>`
    SELECT relkind::text AS kind FROM pg_class WHERE oid = to_regclass('public.vehicle_telemetries')`
  if (table?.kind !== 'p') {
    logger.info('vehicle_telemetries is not partitioned yet; partition upkeep skipped')
    return { partitioned: false, created: [], strays: 0 }
  }

  // One statement in its own transaction, so the lock timeout covers it and
  // nothing else. Attaching takes a light lock on the parent but a brief
  // exclusive one on the DEFAULT partition; waiting behind a long query for it
  // would queue ingest behind this job, so give up instead and retry tomorrow.
  const created = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '10s'`
    const [row] = await tx.$queryRaw<{ created: string[] | null }[]>`
      SELECT vehicle_telemetries_ensure_partitions(${MONTHS_AHEAD}::int) AS created`
    return row?.created ?? []
  })

  const [strayRow] = await prisma.$queryRaw<{ n: number; first: Date | null; last: Date | null }[]>`
    SELECT count(*)::int AS n, min(captured_at) AS first, max(captured_at) AS last
      FROM vehicle_telemetries_default`
  const strays = strayRow?.n ?? 0

  if (created.length) logger.info({ created }, 'Created vehicle_telemetries partitions')
  if (strays > 0) {
    logger.error(
      { strays, first: strayRow?.first, last: strayRow?.last },
      'vehicle_telemetries_default holds fixes outside every monthly partition: a tracker clock is wrong, or partition upkeep has stopped',
    )
  }

  return { partitioned: true, created, strays }
}
