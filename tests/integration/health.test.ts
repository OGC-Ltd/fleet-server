import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'

const app = createApp()

describe('GET /health', () => {
  it('returns 200 with uptime and timestamp', async () => {
    const res = await request(app).get('/health')

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('success')
    expect(res.body.data).toHaveProperty('uptime')
    expect(res.body.data).toHaveProperty('timestamp')
  })
})

describe('unknown routes', () => {
  it('returns 404 for non-existent route', async () => {
    const res = await request(app).get('/api/v1/does-not-exist')

    expect(res.status).toBe(404)
    expect(res.body.status).toBe('error')
    expect(res.body.message).toBe('Route not found')
  })
})
