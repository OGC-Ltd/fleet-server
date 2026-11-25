import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express, { type Request } from 'express'
import request from 'supertest'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import { CpuPool } from '../../src/lib/offload/cpu-pool.js'
import { runTask } from '../../src/lib/offload/cpu-tasks.js'
import {
  sendReport, getReportJob, getReportJobFile, setReportPool, clearReportJobs, preferAsync, createReportGate,
} from '../../src/lib/offload/report-jobs.js'

const ORG = '/api/v1/organisations/org-1'

/** A tiny app: one report route drawn through the pool, and the job routes. */
function appFor(userId = 'user-1') {
  const app = express()
  app.use((req, _res, next) => { (req as Request & { user: unknown }).user = { id: userId }; next() })
  const r = express.Router({ mergeParams: true })
  r.get('/reports/slow.pdf', (req, res, next) => sendReport(req, res, next, async (run) => {
    const ms = Number(req.query['ms'] ?? 10)
    const bytes = await (globalThis as { __pool: CpuPool }).__pool.run('test.spin', { ms, fail: req.query['fail'] as string | undefined }, run)
    return { bytes: Buffer.from(bytes), name: 'Slow report.pdf', type: 'application/pdf' }
  }))
  r.get('/reports/jobs/:jobId', getReportJob)
  r.get('/reports/jobs/:jobId/file', getReportJobFile)
  app.use('/api/v1/organisations/:orgId', r)
  app.use(errorHandler)
  return app
}

// One pool (one thread) for the file: starting threads is the expensive part.
let pool: CpuPool
beforeAll(() => {
  pool = new CpuPool({ size: 1, maxQueue: 2, timeoutMs: 20_000 })
  ;(globalThis as { __pool?: CpuPool }).__pool = pool
  setReportPool(pool)
})
beforeEach(() => clearReportJobs())
afterAll(async () => { await pool.close(); setReportPool(null) })

describe('Prefer: respond-async', () => {
  it('is read with its wait', () => {
    const r = (prefer?: string) => ({ headers: prefer ? { prefer } : {} }) as unknown as Request
    expect(preferAsync(r())).toBeNull()
    expect(preferAsync(r('return=minimal'))).toBeNull()
    expect(preferAsync(r('respond-async'))).toBe(0)
    expect(preferAsync(r('respond-async, wait=10'))).toBe(10)
    expect(preferAsync(r('wait=600, respond-async'))).toBe(60)
  })
})

describe('sendReport', () => {
  it('answers the file inline by default', async () => {
    const res = await request(appFor()).get(`${ORG}/reports/slow.pdf?ms=20`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toContain('Slow report.pdf')
    expect([...res.body]).toEqual([1, 2, 3])
  }, 30_000)

  it('answers 202 and a job to poll on Prefer: respond-async', async () => {
    const app = appFor()
    const res = await request(app).get(`${ORG}/reports/slow.pdf?ms=300`).set('Prefer', 'respond-async')
    expect(res.status).toBe(202)
    const job = res.body.data
    expect(res.headers['location']).toBe(job.statusUrl)
    expect(job.statusUrl).toBe(`${ORG}/reports/jobs/${job.jobId}`)
    expect(['queued', 'running']).toContain(job.status)

    // Not ready: the file route says so with 202
    const early = await request(app).get(`${job.statusUrl}/file`)
    expect(early.status).toBe(202)

    let status = job
    for (let i = 0; i < 100 && status.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 100))
      status = (await request(app).get(job.statusUrl)).body.data
    }
    expect(status).toMatchObject({ status: 'done', name: 'Slow report.pdf', bytes: 3, fileUrl: `${job.statusUrl}/file` })
    const file = await request(app).get(status.fileUrl)
    expect(file.status).toBe(200)
    expect([...file.body]).toEqual([1, 2, 3])
  }, 30_000)

  it('answers the file itself when it is ready within wait=N', async () => {
    const res = await request(appFor()).get(`${ORG}/reports/slow.pdf?ms=20`).set('Prefer', 'respond-async, wait=10')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
  }, 30_000)

  it("keeps a job from other users", async () => {
    const res = await request(appFor('user-1')).get(`${ORG}/reports/slow.pdf?ms=10`).set('Prefer', 'respond-async')
    const other = await request(appFor('user-2')).get(res.body.data.statusUrl)
    expect(other.status).toBe(404)
    const otherOrg = await request(appFor('user-1')).get(`/api/v1/organisations/org-2/reports/jobs/${res.body.data.jobId}`)
    expect(otherOrg.status).toBe(404)
  }, 30_000)

  it('records a failed job with its status', async () => {
    const app = appFor()
    const res = await request(app).get(`${ORG}/reports/slow.pdf?fail=bad`).set('Prefer', 'respond-async')
    let status = res.body.data
    for (let i = 0; i < 100 && status.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 50))
      status = (await request(app).get(res.body.data.statusUrl)).body.data
    }
    expect(status).toMatchObject({ status: 'failed', error: 'bad' })
    expect((await request(app).get(`${res.body.data.statusUrl}/file`)).status).toBe(422)
  }, 30_000)

  it('answers 503 with Retry-After when the threads and the queue are full', async () => {
    const app = appFor()
    const slow = [1, 2, 3].map(() => request(app).get(`${ORG}/reports/slow.pdf?ms=800`).then((r) => r.status))
    await new Promise((r) => setTimeout(r, 150))
    const busy = await request(app).get(`${ORG}/reports/slow.pdf?ms=10`)
    expect(busy.status).toBe(503)
    expect(busy.headers['retry-after']).toBe('5')
    expect(await Promise.all(slow)).toEqual([200, 200, 200])
  }, 30_000)
})

describe('report gate', () => {
  function gated(active: number, queued: number, waitMs = 5_000) {
    const gate = createReportGate({ active, queued, waitMs })
    let running = 0
    let peak = 0
    const app = express()
    app.get('/r', gate, async (_req, res) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 150))
      running--
      res.json({ ok: true })
    })
    app.use(errorHandler)
    return { app, gate, peak: () => peak }
  }

  it('lets at most `active` through at once, queues the rest, refuses past the queue', async () => {
    const { app, peak } = gated(2, 2)
    const statuses = await Promise.all(Array.from({ length: 5 }, () => request(app).get('/r').then((r) => r.status)))
    expect(statuses.filter((s) => s === 200)).toHaveLength(4)
    expect(statuses.filter((s) => s === 503)).toHaveLength(1)
    expect(peak()).toBe(2)
  })

  it('answers 503 to one that waits too long for a turn', async () => {
    const { app } = gated(1, 5, 100)
    const statuses = await Promise.all([request(app).get('/r'), request(app).get('/r')].map((p) => p.then((r) => r.status)))
    expect(statuses.sort()).toEqual([200, 503])
  })
})

describe('posted report task', () => {
  const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v))
  const doc = {
    title: 'Utilisation', reportNo: 'UT-1', date: '26/11/2026', meta: [{ label: 'Fleet', value: 'Test' }], footer: 'f', filename: 'utilisation',
    blocks: [{ kind: 'table', cols: [{ w: 40 }, { w: 20, align: 'right' }], head: ['Unit', 'Km'], rows: [[{ text: 'KDA 100A' }, { text: '12.5' }]] }],
  }

  it('parses, checks and draws the posted body', async () => {
    const out = await runTask('pdf.posted', { report: 'document', body: enc(doc), orgCode: '', landscape: false })
    expect(out.name).toBe('utilisation.pdf')
    expect(new TextDecoder().decode(out.pdf.subarray(0, 5))).toBe('%PDF-')
  })

  it('refuses a body that fails the schema with its issues', async () => {
    const err = await runTask('pdf.posted', { report: 'document', body: enc({ ...doc, title: 5 }), orgCode: '', landscape: false }).catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 400 })
    expect((err as { issues: Array<{ path: unknown[] }> }).issues[0]!.path).toEqual(['title'])
  })

  it('refuses a body that is not JSON', async () => {
    await expect(runTask('pdf.posted', { report: 'geofences', body: enc('{nope'), orgCode: 'X', landscape: false }))
      .rejects.toMatchObject({ status: 400, message: 'The request body is not valid JSON' })
  })
})
