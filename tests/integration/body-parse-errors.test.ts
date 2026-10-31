import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/app.js'

const app = createApp()

describe('request bodies the parser rejects', () => {
  it('answers malformed JSON with 400, not 500', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .set('content-type', 'application/json').send('{"email":')
    expect(res.status).toBe(400)
    expect(res.body.message).toBe('Malformed request body')
  })

  it('answers a body over the size limit with 413, not 500', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(1_100_000) }))
    expect(res.status).toBe(413)
  })
})
