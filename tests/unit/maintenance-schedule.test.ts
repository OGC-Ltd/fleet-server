/**
 * Which maintenance jobs get scheduled, and under which flag.
 *
 * This exists because of a specific failure. Six schedulers share one queue:
 * one PRUNES (deletes old notifications) and five COMPUTE — vehicle_daily_stats,
 * fuel_daily_trends, burn rates, and the probe and sensor reports. All six were
 * gated by RETENTION_SWEEP_ENABLED, so an instance that turned the sweep off —
 * a reasonable thing to do on a box you do not want deleting shared data —
 * silently stopped every rollup as well.
 *
 * Nothing errored. The rollups simply never ran, the tables they write stopped
 * gaining days, and three analytics charts went empty with nothing in any log
 * to say why. That is the worst shape a bug can have, so the separation is
 * pinned here rather than left to a comment.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const added: string[] = []
const removeRepeatableByKey = vi.fn(async () => {})

const envMock = vi.hoisted(() => ({
  env: {
    RETENTION_SWEEP_ENABLED: true,
    NIGHTLY_ROLLUPS_ENABLED: true,
    NOTIFICATION_RETENTION_DAYS: 30,
  } as Record<string, unknown>,
}))
vi.mock('../../src/config/env.js', () => envMock)

vi.mock('bullmq', () => ({
  Queue: class {
    async add(name: string) { added.push(name) }
    async getRepeatableJobs() { return [] }
    removeRepeatableByKey = removeRepeatableByKey
    async close() {}
  },
  Worker: class {
    on() { return this }
    async close() {}
  },
}))

vi.mock('../../src/lib/redis.js', () => ({
  getQueueRedis: () => ({}),
  getCacheRedis: () => null,
}))
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// The job bodies never run here — only the scheduling decision is under test.
vi.mock('../../src/modules/analytics/vehicle-daily-stats.service.js', () => ({
  recordVehicleDailyStats: vi.fn(),
}))

import { startRetentionSweep } from '../../src/lib/queues/retention.js'

const PRUNE = 'notifications:prune'
const ROLLUPS = ['vehicle:daily-stats', 'fuel:daily-trend']

beforeEach(() => {
  added.length = 0
  envMock.env['RETENTION_SWEEP_ENABLED'] = true
  envMock.env['NIGHTLY_ROLLUPS_ENABLED'] = true
})

describe('the maintenance queue schedules by what a job DOES', () => {
  it('schedules everything when both flags are on', async () => {
    const h = await startRetentionSweep()
    expect(added).toContain(PRUNE)
    for (const job of ROLLUPS) expect(added).toContain(job)
    await h.stop()
  })

  it('keeps the rollups running when the deletion sweep is off', async () => {
    // THE REGRESSION. Turning off a flag named for deletion must not stop the
    // jobs that compute the analytics tables.
    envMock.env['RETENTION_SWEEP_ENABLED'] = false

    const h = await startRetentionSweep()

    expect(added).not.toContain(PRUNE)
    for (const job of ROLLUPS) expect(added).toContain(job)
    await h.stop()
  })

  it('keeps the sweep running when the rollups are off', async () => {
    envMock.env['NIGHTLY_ROLLUPS_ENABLED'] = false

    const h = await startRetentionSweep()

    expect(added).toContain(PRUNE)
    for (const job of ROLLUPS) expect(added).not.toContain(job)
    await h.stop()
  })

  it('starts nothing at all only when both are off', async () => {
    envMock.env['RETENTION_SWEEP_ENABLED'] = false
    envMock.env['NIGHTLY_ROLLUPS_ENABLED'] = false

    await startRetentionSweep()

    expect(added).toHaveLength(0)
  })
})
