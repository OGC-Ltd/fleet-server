/**
 * The logger blanks secrets an error object would otherwise carry into the log
 * (lib/log-redact). Built with the real pino, since tests/setup mocks the app's
 * logger.
 */

import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { Writable } from 'node:stream'
import { REDACT } from '../../src/lib/log-redact.js'

function capture() {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _enc, done) { lines.push(JSON.parse(String(chunk))); done() },
  })
  return { log: pino({ redact: REDACT }, stream), lines }
}

/** An error shaped like the one axios throws: the whole request rides along. */
function axiosError() {
  const err = new Error('Request failed with status code 401') as Error & Record<string, unknown>
  err.config = {
    url: 'https://hst-api.wialon.com/wialon/ajax.html',
    method: 'get',
    headers: { Authorization: 'Bearer live-token-123', 'x-api-key': 'k-456' },
    params: { svc: 'token/login', token: 'wialon-token-789' },
    data: '{"password":"hunter2"}',
  }
  err.response = { status: 401, headers: { 'set-cookie': ['sid=abc'] }, config: { headers: { Authorization: 'Bearer x' } } }
  return err
}

describe('log redaction', () => {
  it('blanks the request an axios error carries, and keeps what helps debugging', () => {
    const { log, lines } = capture()
    log.error({ err: axiosError() }, 'wialon call failed')
    const text = JSON.stringify(lines[0])
    for (const secret of ['live-token-123', 'k-456', 'wialon-token-789', 'hunter2', 'sid=abc']) {
      expect(text).not.toContain(secret)
    }
    const err = lines[0]!.err as Record<string, any>
    expect(err.message).toBe('Request failed with status code 401')
    expect(err.config.url).toBe('https://hst-api.wialon.com/wialon/ajax.html')
    expect(err.config.headers).toBe('[redacted]')
    expect(err.response.status).toBe(401)
  })

  it('blanks an axios error one level down', () => {
    const { log, lines } = capture()
    log.warn({ result: axiosError() }, 'nested')
    expect(JSON.stringify(lines[0])).not.toContain('live-token-123')
  })

  it('blanks secret-named fields at the top level and one level down', () => {
    const { log, lines } = capture()
    log.info({ password: 'p1', body: { token: 't1', refreshToken: 'r1', email: 'a@b.test' } }, 'x')
    const text = JSON.stringify(lines[0])
    expect(text).not.toMatch(/p1|t1|r1/)
    expect(text).toContain('a@b.test')
  })

  it('leaves ordinary lines alone', () => {
    const { log, lines } = capture()
    log.info({ orgId: 'o1', vehicleId: 'v1', queue: 'fuel' }, 'ok')
    expect(lines[0]).toMatchObject({ orgId: 'o1', vehicleId: 'v1', queue: 'fuel', msg: 'ok' })
  })
})
