import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const info = vi.fn()
vi.mock('../../src/lib/logger.js', () => ({ logger: { info: (...a: unknown[]) => info(...a), warn: vi.fn(), error: vi.fn() } }))

const { requestLog } = await import('../../src/middleware/request-log.js')
const { scrubQuery } = await import('../../src/lib/scrub-query.js')

function app() {
  const a = express()
  a.set('trust proxy', 'loopback')
  a.use(requestLog)
  a.get('/health', (_q, r) => { r.json({ ok: true }) })
  a.get('/api/v1/organisations/:orgId/vehicles', (q, r) => {
    q.user = { id: 'user-1', organisationId: 'o', email: null, fullName: 'x', status: 'ACTIVE' as never }
    r.json({ ok: true })
  })
  a.get('/api/v1/organisations/:orgId/live', (_q, r) => {
    r.setHeader('Content-Type', 'text/event-stream')
    r.flushHeaders()
    r.write('data: hi\n\n')
    r.end()
  })
  return a
}

const lines = () => info.mock.calls.filter((c) => c[1] === 'request').map((c) => c[0] as Record<string, unknown>)

beforeEach(() => info.mockReset())

describe('request log', () => {
  it('logs the client address resolved through the trusted proxy, the route and the user', async () => {
    await request(app()).get('/api/v1/organisations/org-9/vehicles?from=1').set('X-Forwarded-For', '203.0.113.7').expect(200)
    const [l] = lines()
    expect(l).toMatchObject({
      ip: '203.0.113.7',
      xff: '203.0.113.7',
      method: 'GET',
      path: '/api/v1/organisations/org-9/vehicles',
      query: 'from=1',
      route: '/api/v1/organisations/:orgId/vehicles',
      status: 200,
      userId: 'user-1',
      orgId: 'org-9',
      aborted: false,
    })
    expect(typeof l.ms).toBe('number')
  })

  it('blanks credential-looking query values', async () => {
    await request(app()).get('/api/v1/organisations/o/vehicles?token=abc&sid=s1&page=2').expect(200)
    expect(lines()[0].query).toBe('token=[redacted]&sid=[redacted]&page=2')
  })

  it('logs refused and unknown requests too', async () => {
    await request(app()).get('/nope').expect(404)
    expect(lines()[0]).toMatchObject({ path: '/nope', status: 404 })
  })

  it('skips the health check', async () => {
    await request(app()).get('/health').expect(200)
    expect(lines()).toHaveLength(0)
  })

  it('logs a live stream when it opens and again when it closes', async () => {
    await request(app()).get('/api/v1/organisations/o/live').expect(200)
    const ls = lines()
    expect(ls.map((l) => l.stream)).toEqual(['opened', 'closed'])
  })
})

describe('scrubQuery', () => {
  it.each([
    ['https://hst-api.wialon.com/wialon/ajax.html?svc=core/login&params={}&sid=abc', 'https://hst-api.wialon.com/wialon/ajax.html?svc=core/login&params={}&sid=[redacted]'],
    ['/x?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA&x=1', '/x?X-Amz-Signature=[redacted]&X-Amz-Credential=[redacted]&x=1'],
    ['token=t&a=b', 'token=[redacted]&a=b'],
    ['/plain/path', '/plain/path'],
    ['/p?api_key=1#frag', '/p?api_key=[redacted]#frag'],
    ['/p?keyword=fuel', '/p?keyword=fuel'],
  ])('%s', (input, out) => {
    expect(scrubQuery(input)).toBe(out)
  })
})
