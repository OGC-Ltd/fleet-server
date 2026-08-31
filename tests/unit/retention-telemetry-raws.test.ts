/**
 * The raw-telemetry retention target.
 *
 * This one deletes from the largest table in the database — 9,968 MB, two
 * thirds of it — and two of its readers reach a vehicle's CURRENT position
 * through an INNER JOIN onto it. Get the predicate wrong and vehicles do not
 * go stale on the map, they vanish from it. So the properties below are pinned
 * rather than left to a reviewer's eye:
 *
 *   · it deletes raws only, never the parsed telemetry rows
 *   · it never deletes the raw behind a vehicle's newest ping, at any age
 *   · it can actually keep up with the fleet's write rate
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { RETENTION_TARGETS } from '../../src/lib/queues/retention.js'
import { env } from '../../src/config/env.js'

const target = () => RETENTION_TARGETS.find(t => t.name === 'vehicle_telemetry_raws')!

/** Rebuild the SQL text from the tagged-template call the mock recorded. */
function capturedSql(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (prismaMock.$executeRaw as any).mock.calls[0]
  const [strings, ...values] = call as [string[], ...unknown[]]
  return strings.map((s, i) => s + (i < values.length ? `$${i + 1}` : '')).join('')
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.$executeRaw as any).mockResolvedValue(7)
})

describe('the target itself', () => {
  it('is registered and takes its window from the environment', () => {
    expect(target()).toBeDefined()
    expect(target().days).toBe(env.TELEMETRY_RAW_RETENTION_DAYS)
  })

  it('can delete faster than the fleet writes', () => {
    // The shared defaults cap a sweep at 500 x 200 = 100,000 rows. The fleet
    // wrote ~887,000 fixes a day once Menengai and West Sugar were onboarded,
    // so a target left on the defaults would lose ground every single night.
    const perSweep = target().batchSize! * target().maxBatches!
    expect(perSweep).toBeGreaterThan(887_000)
  })
})

describe('what it deletes', () => {
  it('reports the number of rows the statement removed', async () => {
    await expect(target().prune(new Date('2026-08-01T00:00:00Z'), 2000)).resolves.toBe(7)
  })

  it('deletes from the raw table and never from the parsed one', async () => {
    await target().prune(new Date('2026-08-01T00:00:00Z'), 2000)
    const sql = capturedSql()

    expect(sql).toMatch(/DELETE\s+FROM\s+vehicle_telemetry_raws/i)
    expect(sql).not.toMatch(/DELETE\s+FROM\s+vehicle_telemetries/i)
  })

  it('spares the raw behind a vehicle’s newest ping, however old it is', async () => {
    await target().prune(new Date('2026-08-01T00:00:00Z'), 2000)
    const sql = capturedSql().replace(/\s+/g, ' ')

    // Age alone is not a safe predicate: a unit that last reported in January
    // 2025 still has a newest ping, and that is the row the map renders. The
    // condition has to be "old AND superseded".
    expect(sql).toMatch(/EXISTS/i)
    expect(sql).toMatch(/newer\.vehicle_id\s*=\s*t\.vehicle_id/i)
    expect(sql).toMatch(/newer\.captured_at\s*>\s*t\.captured_at/i)
  })

  it('parameterises the cutoff and the batch limit', async () => {
    const cutoff = new Date('2026-08-01T00:00:00Z')
    await target().prune(cutoff, 2000)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [, ...values] = (prismaMock.$executeRaw as any).mock.calls[0] as [string[], ...unknown[]]
    expect(values).toEqual([cutoff, 2000])
    expect(capturedSql()).toMatch(/LIMIT \$2/)
  })
})
