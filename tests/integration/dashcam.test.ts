/**
 * /api/v1/vss/* — the Alarms tab's routes: the organisation comes as ?org=
 * and is checked like every /organisations/:orgId route.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { TEST_ORG_ID } from '../helpers/factories.js'
import { authMock, authorizeMock, resetTestSubject, setTestSubject } from '../helpers/auth-mock.js'

vi.mock('../../src/lib/prisma.js')
vi.mock('../../src/middleware/auth.ts', () => authMock())
vi.mock('../../src/middleware/authorize.ts', () => authorizeMock())
const up = vi.hoisted(() => ({ calls: [] as (string | undefined)[], answers: [] as { status: number; body: Buffer; headers?: Record<string, string> }[] }))
vi.mock('../../src/providers/vss/index.js', async (orig) => {
  const real = await orig<typeof import('../../src/providers/vss/index.js')>()
  const { Readable } = await import('node:stream')
  return {
    ...real,
    fetchVssFile: vi.fn(async (_url: string, range?: string) => {
      up.calls.push(range)
      const a = up.answers.shift()!
      const r = Readable.from([a.body]) as unknown as import('node:http').IncomingMessage
      Object.assign(r, { statusCode: a.status, headers: { 'content-type': 'application/octet-stream', 'content-length': String(a.body.length), ...(a.headers ?? {}) } })
      return r
    }),
  }
})
vi.mock('../../src/modules/dashcam/dashcam.service.js', () => ({
  cameraCount: vi.fn(async () => 3),
  getAlarms: vi.fn(async () => ({ incidents: [], cameras: 3, from: 'a', to: 'b' })),
  fileFor: vi.fn(() => null),
}))

import { buildApp } from '../helpers/app.js'
const svc = await import('../../src/modules/dashcam/dashcam.service.js')
const { VssError, VSS_TOO_FREQUENT } = await import('../../src/providers/vss/index.js')

let app: Express
beforeAll(async () => { app = await buildApp() })
beforeEach(() => resetTestSubject())

describe('GET /api/v1/vss/cameras', () => {
  it('answers the count for an organisation the caller may reach', async () => {
    const res = await request(app).get(`/api/v1/vss/cameras?org=${TEST_ORG_ID}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ cameras: 3 })
    expect(vi.mocked(svc.cameraCount).mock.calls[0][0]).toBe(TEST_ORG_ID)
  })
  it('refuses another organisation', async () => {
    const res = await request(app).get('/api/v1/vss/cameras?org=org_someone_else')
    expect(res.status).toBe(403)
  })
  it('needs ?org=', async () => {
    expect((await request(app).get('/api/v1/vss/cameras')).status).toBe(400)
  })
  it('needs vehicle:read', async () => {
    setTestSubject({ permissions: ['map:read'] })
    expect((await request(app).get(`/api/v1/vss/cameras?org=${TEST_ORG_ID}`)).status).toBe(403)
  })
  it('passes the caller’s vehicle scope on', async () => {
    setTestSubject({ vehicleScope: ['veh_1'] })
    await request(app).get(`/api/v1/vss/cameras?org=${TEST_ORG_ID}`)
    expect([...(vi.mocked(svc.cameraCount).mock.calls.at(-1)![1] ?? [])]).toEqual(['veh_1'])
  })
})

describe('GET /api/v1/vss/alarms', () => {
  it('answers the alarms', async () => {
    const res = await request(app).get(`/api/v1/vss/alarms?org=${TEST_ORG_ID}&since=2026-10-23T00:00:00Z`)
    expect(res.status).toBe(200)
    expect(res.body.data.cameras).toBe(3)
    expect(vi.mocked(svc.getAlarms).mock.calls.at(-1)![2]).toBe('2026-10-23T00:00:00Z')
  })
  it('VSS busy → 502 with the words the dashboard shows', async () => {
    vi.mocked(svc.getAlarms).mockRejectedValueOnce(new VssError('Requests too frequent', VSS_TOO_FREQUENT))
    const res = await request(app).get(`/api/v1/vss/alarms?org=${TEST_ORG_ID}`)
    expect(res.status).toBe(502)
    expect(res.body.message).toMatch(/slow down/)
  })
})

describe('GET /api/v1/vss/file', () => {
  it('an unknown or expired key is 404, never a fetch', async () => {
    const res = await request(app).get(`/api/v1/vss/file?org=${TEST_ORG_ID}&k=${'a'.repeat(40)}`)
    expect(res.status).toBe(404)
  })
})

describe('GET /api/v1/vss/file — streaming', () => {
  const K = 'b'.repeat(40)
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(20)])
  beforeEach(() => {
    up.calls = []; up.answers = []
    vi.mocked(svc.fileFor).mockImplementation((org: string, k: string) => (org === TEST_ORG_ID && k === K ? 'https://vss.example/f' : null))
  })

  it('a snapshot comes back as an image, whatever VSS labels it', async () => {
    up.answers.push({ status: 200, body: JPEG })
    const res = await request(app).get(`/api/v1/vss/file?org=${TEST_ORG_ID}&k=${K}`).buffer(true)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(Buffer.from(res.body).equals(JPEG)).toBe(true)
  })

  it('a clip honours Range (206) so the player can seek', async () => {
    up.answers.push({ status: 206, body: MP4, headers: { 'content-range': `bytes 0-${MP4.length - 1}/648107` } })
    const res = await request(app).get(`/api/v1/vss/file?org=${TEST_ORG_ID}&k=${K}`).set('Range', 'bytes=0-').buffer(true)
    expect(res.status).toBe(206)
    expect(res.headers['content-type']).toBe('video/mp4')
    expect(res.headers['content-range']).toBe(`bytes 0-${MP4.length - 1}/648107`)
    expect(up.calls).toEqual(['bytes=0-'])
  })

  it('VSS’s 416 on a range is asked again without it', async () => {
    up.answers.push({ status: 416, body: Buffer.from('<html>') }, { status: 200, body: JPEG })
    const res = await request(app).get(`/api/v1/vss/file?org=${TEST_ORG_ID}&k=${K}`).set('Range', 'bytes=0-999999').buffer(true)
    expect(res.status).toBe(200)
    expect(up.calls).toEqual(['bytes=0-999999', undefined])
  })

  it('a file VSS does not have is 404; download names the file', async () => {
    up.answers.push({ status: 404, body: Buffer.from('nope') })
    expect((await request(app).get(`/api/v1/vss/file?org=${TEST_ORG_ID}&k=${K}`)).status).toBe(404)
    up.answers.push({ status: 200, body: JPEG })
    const res = await request(app).get(`/api/v1/vss/file?org=${TEST_ORG_ID}&k=${K}&download=1`).buffer(true)
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="dashcam-bbbbbbbbbb\.jpg"/)
  })
})
