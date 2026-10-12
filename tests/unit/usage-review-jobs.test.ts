/**
 * Where a Logbook build runs (2026-10-10, "300+ users generating reports"):
 * a held review is served as it is; otherwise one build is queued for the
 * report worker, whoever asks; and when the worker is not answering the API
 * builds it itself, as it always did, and keeps it.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-jobs-'))
process.env['REPORT_STORE_DIR'] = dir

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    vehicle: {
      findFirst: vi.fn(async () => ({
        id: 'veh1', name: 'KCP 136P', registrationPlate: 'KCP 136P', vehicleType: 'TRUCK', deviceId: 'wialon:7', fuelEfficiencyKmpl: null,
        organisation: { name: 'Menengai' },
      })),
    },
    geofence: { findMany: vi.fn(async () => []) },
  },
}))
vi.mock('../../src/modules/usage-review/usage-review.wialon.js', () => ({
  loadUnitHistory: vi.fn(async (_id: number, ranges: [number, number][]) => {
    const [from] = ranges[0]!
    // An hour parked, an hour driving east, an hour parked.
    const messages = Array.from({ length: 180 }, (_, i) => ({
      t: from + 6 * 3600 + i * 60, lat: 0.5, lng: 35 + (i >= 60 && i < 120 ? (i - 60) * 0.005 : i >= 120 ? 0.3 : 0),
      speed: i >= 60 && i < 120 ? 40 : 0, course: 90, odoM: null, ign: i >= 60 && i < 120, src: 'wialon' as const,
    }))
    return { unitName: 'KCP 136P', messages }
  }),
}))
vi.mock('../../src/modules/usage-review/usage-review.geocode.js', () => ({ namePlaces: vi.fn(async () => {}) }))
vi.mock('../../src/modules/usage-review/usage-review.poi.js', () => ({ namePois: vi.fn(async () => {}) }))

class FakeJob {
  state = 'waiting'
  progress: unknown = {}
  timestamp = Date.now()
  finishedOn?: number
  failedReason?: string
  constructor(public id: string, public data: unknown) {}
  getState = async () => this.state
  remove = async () => { queue.jobs.delete(this.id) }
}
const queue = {
  jobs: new Map<string, FakeJob>(),
  getJob: vi.fn(async (id: string) => queue.jobs.get(id)),
  add: vi.fn(async (_name: string, data: unknown, opts: { jobId: string }) => {
    if (!queue.jobs.has(opts.jobId)) queue.jobs.set(opts.jobId, new FakeJob(opts.jobId, data))
    return queue.jobs.get(opts.jobId)!
  }),
}
let workerUp = true
vi.mock('../../src/lib/queues/usage-review.js', () => ({
  useReportWorker: vi.fn(async () => workerUp),
  reviewQueue: () => queue,
  renderQueue: () => null,
}))

const svc = await import('../../src/modules/usage-review/usage-review.service.js')
const saved = await import('../../src/modules/usage-review/usage-review.saved.js')

const DAY = 86_400_000
const key = saved.reviewKey('org1', 'veh1', '2026-09-01', '2026-09-02')
const closed = (builtAt: number) => ({
  period: { from: '2026-09-01', to: '2026-09-02', days: 2, startMs: Date.UTC(2026, 7, 31, 21), endMs: Date.UTC(2026, 8, 2, 21) },
  builtAt, points: [], places: [],
}) as unknown as Parameters<typeof saved.saveReview>[1]

beforeEach(async () => {
  queue.jobs.clear()
  queue.add.mockClear()
  workerUp = true
  await saved.dropReview(key)
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('a Logbook build', () => {
  it('serves a held review of a closed period as it is, with no build', async () => {
    await saved.saveReview(key, closed(Date.UTC(2026, 8, 10)))
    const st = await svc.getUsageReview('org1', 'veh1', '2026-09-01', '2026-09-02')
    expect(st.status).toBe('ready')
    expect(st.review?.builtAt).toBe(Date.UTC(2026, 8, 10))
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('queues one build for the worker, however many ask', async () => {
    const a = await svc.getUsageReview('org1', 'veh1', '2026-09-01', '2026-09-02')
    const b = await svc.getUsageReview('org1', 'veh1', '2026-09-01', '2026-09-02')
    expect([a.status, a.stage, b.status]).toEqual(['running', 'queued', 'running'])
    expect(queue.jobs.size).toBe(1)

    const job = [...queue.jobs.values()][0]!
    job.state = 'active'
    job.progress = { stage: 'loading', done: 20_000, total: 63_000 }
    const c = await svc.getUsageReview('org1', 'veh1', '2026-09-01', '2026-09-02')
    expect(c).toMatchObject({ status: 'running', stage: 'loading', progress: { done: 20_000, total: 63_000 } })

    // Done: the worker saved it, and that is what is served.
    await saved.saveReview(key, closed(Date.now()))
    job.state = 'completed'
    expect((await svc.getUsageReview('org1', 'veh1', '2026-09-01', '2026-09-02')).status).toBe('ready')
  })

  it('says a build failed for a minute, then tries again', async () => {
    await svc.getUsageReview('org1', 'veh1', '2026-09-01', '2026-09-02')
    const job = [...queue.jobs.values()][0]!
    Object.assign(job, { state: 'failed', finishedOn: Date.now(), failedReason: 'Wialon said no' })
    expect(await svc.getUsageReview('org1', 'veh1', '2026-09-01', '2026-09-02')).toMatchObject({ status: 'failed', error: 'Wialon said no' })
    job.finishedOn = Date.now() - 61_000
    const again = await svc.getUsageReview('org1', 'veh1', '2026-09-01', '2026-09-02')
    expect(again.status).toBe('running')
    expect(queue.add).toHaveBeenCalledTimes(2)
  })

  it('throws a held review away and queues a build of its own when asked afresh', async () => {
    await saved.saveReview(key, closed(Date.UTC(2026, 8, 10)))
    const st = await svc.getUsageReview('org1', 'veh1', '2026-09-01', '2026-09-02', true)
    expect(st.status).toBe('running')
    expect(await saved.loadReview(key)).toBeNull()
    expect([...queue.jobs.keys()][0]).toMatch(/_f\d+$/)
  })

  it('does not serve a review of an open period built more than ten minutes ago', async () => {
    const open = { ...closed(Date.now() - 11 * 60_000), period: { from: '2026-09-01', to: '2026-09-02', days: 2, startMs: 0, endMs: Date.now() + DAY } }
    await saved.saveReview(key, open as Parameters<typeof saved.saveReview>[1])
    expect((await svc.getUsageReview('org1', 'veh1', '2026-09-01', '2026-09-02')).status).toBe('running')
  })

  it('builds in the API process, and keeps it, when the worker is not answering', async () => {
    workerUp = false
    const k2 = saved.reviewKey('org1', 'veh1', '2026-09-03', '2026-09-03')
    let st = await svc.getUsageReview('org1', 'veh1', '2026-09-03', '2026-09-03')
    expect(queue.add).not.toHaveBeenCalled()
    for (let i = 0; i < 50 && st.status === 'running'; i++) {
      await new Promise(r => setTimeout(r, 20))
      st = await svc.getUsageReview('org1', 'veh1', '2026-09-03', '2026-09-03')
    }
    expect(st.status).toBe('ready')
    expect(st.review?.summary.trips).toBe(1)
    // Kept for everyone, its fixes a day at a time.
    expect((await saved.loadReview(k2))?.summary.trips).toBe(1)
    expect((await svc.pointsOf('org1', 'veh1', '2026-09-03', '2026-09-03', '2026-09-03')).length).toBe(180)
  })
})
