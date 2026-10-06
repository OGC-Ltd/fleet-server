/**
 * req.ip behind nginx, and behind LiteSpeed → nginx.
 *
 * 2026-10-06: with `trust proxy 1`, every user of fleettracking.ogc-monitoring.com
 * (a LiteSpeed proxy at 198.38.90.19 in front of nginx) resolved to the proxy's
 * address and shared one rate-limit bucket. These pin the fix, and that it does
 * not let a direct caller choose their own address.
 */
import { describe, it, expect, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { trustProxy, parseProxyList } from '../../src/lib/trust-proxy.js'

const app = express()
app.set('trust proxy', trustProxy(parseProxyList('198.38.90.19')))
app.get('/', (req, res) => { res.json({ ip: req.ip }) })
const server = app.listen(0)
afterAll(() => { server.close() })

const ipFor = async (xff?: string) => {
  const { port } = server.address() as AddressInfo
  const r = await fetch(`http://127.0.0.1:${port}/`, { headers: xff ? { 'x-forwarded-for': xff } : {} })
  return ((await r.json()) as { ip: string }).ip
}

describe('client address', () => {
  // nginx appends the address it saw, so node receives "<what came in>, <peer>".
  it('direct to nginx: the user', async () => {
    expect(await ipFor('41.139.129.153')).toBe('41.139.129.153')
  })

  it('through LiteSpeed: the user, not the proxy', async () => {
    expect(await ipFor('41.139.129.153, 198.38.90.19')).toBe('41.139.129.153')
  })

  it('a direct caller cannot claim an address by writing X-Forwarded-For', async () => {
    // They sent "1.2.3.4"; nginx appended their real address.
    expect(await ipFor('1.2.3.4, 5.6.7.8')).toBe('5.6.7.8')
  })

  it('…not even by naming the trusted proxy', async () => {
    expect(await ipFor('1.2.3.4, 198.38.90.19, 5.6.7.8')).toBe('5.6.7.8')
  })

  it('no header: the socket peer', async () => {
    expect(await ipFor()).toMatch(/127\.0\.0\.1$/)
  })
})

describe('parseProxyList', () => {
  it('splits and trims, and empty means none', () => {
    expect(parseProxyList(' 1.1.1.1 ,2.2.2.2,')).toEqual(['1.1.1.1', '2.2.2.2'])
    expect(parseProxyList('')).toEqual([])
    expect(parseProxyList(undefined)).toEqual([])
  })
})
