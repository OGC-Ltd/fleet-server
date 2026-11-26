/**
 * GET …/vehicles/:vehicleId/telemetry/day serves a settled day from the shared
 * day cache (day-series-cache). The report screens read every unit's day, so
 * on 26 Nov 2026 the same finished days were read from the database thousands
 * of times in half an hour.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'day-route-'))
process.env['FUEL_DAY_CACHE_DIR'] = dir

vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))
const daySeries = vi.fn(async (_v: string, _o: string, q: { day?: string }) => ({
  vehicleId: 'veh1', day: q.day, from: Date.parse(`${q.day}T00:00:00+03:00`), since: null,
  complete: true, truncated: q.day === '2026-09-02', count: 2, t: [0, 60], fuelMl: [100_000, 99_000],
  vext: q.day === '2026-09-03' ? [null, null] : [27.1, 27.2], vint: [null, null],
}))
vi.mock('../../src/modules/telemetry/telemetry.service.js', () => ({ getVehicleDaySeries: daySeries }))
const exists = vi.fn(async (v: string, o: string) => v === 'veh1' && o === 'org1')
vi.mock('../../src/modules/telemetry/telemetry.repository.js', () => ({ vehicleExistsInOrg: exists }))

const cache = await import('../../src/modules/telemetry/day-series-cache.js')
const { getVehicleDaySeriesHandler } = await import('../../src/modules/telemetry/telemetry.controller.js')

async function call(query: Record<string, unknown>, orgId = 'org1') {
  let body: unknown = null
  let error: unknown
  const headers: Record<string, string> = {}
  const res = {
    set: vi.fn((k: string, v: string) => { headers[k] = v; return res }),
    type: vi.fn(() => res),
    status: vi.fn(() => res),
    send: vi.fn((b: string) => { body = JSON.parse(b) }),
    json: vi.fn((b: unknown) => { body = JSON.parse(JSON.stringify(b)) }),
  }
  await getVehicleDaySeriesHandler(
    { params: { orgId, vehicleId: 'veh1' }, query } as never, res as never, ((e: unknown) => { error = e }) as never,
  )
  // keepDay runs behind the response; let its disk write finish.
  await new Promise((r) => setTimeout(r, 50))
  return { body: body as { statusCode: number; status: string; data: Record<string, unknown> } | null, headers, error }
}

beforeEach(() => { cache._clearDayMemory(); daySeries.mockClear(); exists.mockClear() })
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('the day route and the shared day cache', () => {
  it('reads a settled day from the database once, then sends it as kept', async () => {
    const first = await call({ day: '2026-09-01' })
    const second = await call({ day: '2026-09-01' })
    expect(daySeries).toHaveBeenCalledTimes(1)
    expect(second.body).toEqual(first.body)
    expect(second.body).toMatchObject({ statusCode: 200, status: 'success', data: { day: '2026-09-01', t: [0, 60] } })
    expect(second.headers['Cache-Control']).toBe('private, max-age=86400')
  })

  it('survives a restart: the disk copy serves when memory is empty', async () => {
    await call({ day: '2026-09-04' })
    cache._clearDayMemory()
    await call({ day: '2026-09-04' })
    expect(daySeries).toHaveBeenCalledTimes(1)
  })

  it('still checks the path organisation on a cached day', async () => {
    await call({ day: '2026-09-05' })
    const other = await call({ day: '2026-09-05' }, 'org2')
    expect(other.body).toBeNull()
    expect(other.error).toMatchObject({ message: 'Vehicle not found' })
  })

  it('does not keep a truncated day, or one with no voltages for the Fuel Report to fill', async () => {
    await call({ day: '2026-09-02' })
    await call({ day: '2026-09-02' })
    await call({ day: '2026-09-03' })
    await call({ day: '2026-09-03' })
    expect(daySeries).toHaveBeenCalledTimes(4)
  })

  it('reads today, and any request with `since`, from the database every time', async () => {
    const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10)
    await call({ day: today })
    await call({ day: today })
    await call({ day: '2026-09-06', since: Date.parse('2026-09-06T05:00:00+03:00') })
    await call({ day: '2026-09-06', since: Date.parse('2026-09-06T05:00:00+03:00') })
    await call({})
    expect(daySeries).toHaveBeenCalledTimes(5)
  })

  it('serves a day the Fuel Report kept, with the voltages it filled', async () => {
    await cache.keepDay('veh1', '2026-09-07', JSON.stringify({ vehicleId: 'veh1', day: '2026-09-07', t: [0], vext: [26.9] }))
    const { body } = await call({ day: '2026-09-07' })
    expect(daySeries).not.toHaveBeenCalled()
    expect(body?.data).toMatchObject({ vext: [26.9] })
  })
})
