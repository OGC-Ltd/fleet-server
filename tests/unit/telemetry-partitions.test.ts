/**
 * Nightly upkeep of vehicle_telemetries' monthly partitions.
 *
 * The SQL that creates partitions lives in the database function and was
 * rehearsed against Postgres 18 (docs/telemetry-partitioning.md). What is
 * pinned here is the app's side: it does nothing before the migration, it
 * runs the function under a lock timeout, and fixes outside every month are
 * reported as an error instead of passing silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { prismaMock } from '../helpers/prisma.mock.js'
import { logger } from '../../src/lib/logger.js'
import { maintainTelemetryPartitions, MONTHS_AHEAD } from '../../src/lib/telemetry-partitions.js'

/** The SQL text of the n-th $queryRaw call, placeholders as $1… */
function sqlOf(n: number): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [strings] = (prismaMock.$queryRaw as any).mock.calls[n] as [string[]]
  return strings.join('$?').replace(/\s+/g, ' ')
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryRaw = () => prismaMock.$queryRaw as any

beforeEach(() => vi.mocked(logger.error).mockClear())

describe('maintainTelemetryPartitions', () => {
  it('does nothing while the table is still a plain one', async () => {
    queryRaw().mockResolvedValueOnce([{ kind: 'r' }])
    expect(await maintainTelemetryPartitions()).toEqual({ partitioned: false, created: [], strays: 0 })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('does nothing when the table is missing altogether', async () => {
    queryRaw().mockResolvedValueOnce([])
    expect((await maintainTelemetryPartitions()).partitioned).toBe(false)
  })

  it('runs the database function months ahead, under a lock timeout', async () => {
    queryRaw()
      .mockResolvedValueOnce([{ kind: 'p' }])
      .mockResolvedValueOnce([{ created: ['vehicle_telemetries_p202703'] }])
      .mockResolvedValueOnce([{ n: 0, first: null, last: null }])

    const out = await maintainTelemetryPartitions()

    expect(out).toEqual({ partitioned: true, created: ['vehicle_telemetries_p202703'], strays: 0 })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [setStrings] = (prismaMock.$executeRaw as any).mock.calls[0] as [string[]]
    expect(setStrings.join('')).toContain("SET LOCAL lock_timeout")
    expect(sqlOf(1)).toContain('vehicle_telemetries_ensure_partitions(')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((prismaMock.$queryRaw as any).mock.calls[1][1]).toBe(MONTHS_AHEAD)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('reports fixes stranded in the DEFAULT partition as an error', async () => {
    queryRaw()
      .mockResolvedValueOnce([{ kind: 'p' }])
      .mockResolvedValueOnce([{ created: null }])
      .mockResolvedValueOnce([{ n: 4, first: new Date('2031-01-01'), last: new Date('2031-01-02') }])

    const out = await maintainTelemetryPartitions()

    expect(out).toEqual({ partitioned: true, created: [], strays: 4 })
    expect(sqlOf(2)).toContain('FROM vehicle_telemetries_default')
    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
