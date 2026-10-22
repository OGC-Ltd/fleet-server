/**
 * VSS rate-limits logins (10082 "Login too frequently"), and asking again
 * while it does keeps the account locked out. After one refusal the provider
 * must stop asking, and say why.
 */

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

vi.mock('../../src/config/env.js', async (orig) => {
  const real = await orig<typeof import('../../src/config/env.js')>()
  return { ...real, env: { ...real.env, VSS_BASE_URL: 'https://vss.test.invalid', VSS_USERNAME: 'u', VSS_PASSWORD: 'p', VSS_STREAM_PORT: 36301 } }
})

const requests: string[] = []
vi.mock('node:https', () => ({
  default: {
    request: (url: URL, _opts: unknown, onRes: (res: EventEmitter) => void) => {
      requests.push(url.pathname)
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
      req.destroy = () => {}
      req.end = () => {
        const res = new EventEmitter()
        onRes(res)
        res.emit('data', Buffer.from(JSON.stringify({ status: 10082, msg: 'Login too frequently', data: null })))
        res.emit('end')
      }
      return req
    },
  },
}))

fs.rmSync(path.join(os.tmpdir(), 'fleet-server-vss-session.json'), { force: true })
const { listDevices, VssError, VSS_LOGIN_LIMITED } = await import('../../src/providers/vss/index.js')

describe('VSS login backoff', () => {
  it('asks VSS once, then refuses locally while the limit lasts', async () => {
    await expect(listDevices()).rejects.toMatchObject({ status: VSS_LOGIN_LIMITED })
    await expect(listDevices()).rejects.toBeInstanceOf(VssError)
    await expect(listDevices()).rejects.toMatchObject({ status: VSS_LOGIN_LIMITED })
    expect(requests).toEqual(['/vss/user/apiLogin.action'])
  })
})
