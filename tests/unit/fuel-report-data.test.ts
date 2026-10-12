/**
 * A Fuel Report's period in one request (2026-10-10, "300+ users generating
 * reports"): finished days read from the database once and kept for everyone,
 * on the report pool; the drains and fillings one query each.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuel-days-'))
process.env['FUEL_DAY_CACHE_DIR'] = dir

const reportPool = { name: 'report pool' }
vi.mock('../../src/lib/report-db.js', () => ({ reportDb: () => reportPool }))
vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))
const daySeries = vi.fn(async (_v: string, _o: string, q: { day: string }, db: unknown) => {
  if (db !== reportPool) throw new Error('read on the live pool')
  if (q.day === '2026-09-03') throw new Error('timeout')
  return { vehicleId: 'veh1', day: q.day, from: Date.parse(`${q.day}T00:00:00+03:00`), complete: true, truncated: false, t: [0, 60], fuelMl: [100_000, 99_000] }
})
vi.mock('../../src/modules/telemetry/telemetry.service.js', () => ({ getVehicleDaySeries: daySeries }))
vi.mock('../../src/modules/telemetry/telemetry.repository.js', () => ({ vehicleExistsInOrg: vi.fn(async (v: string) => v === 'veh1') }))
const thefts = vi.fn(async () => ({ data: [{ id: 'd1', beganAt: '2026-09-02T10:00:00Z' }] }))
const fills = vi.fn(async () => ({ data: [{ id: 'f1', filledAt: '2026-09-01T08:00:00Z' }] }))
vi.mock('../../src/modules/fuel/fuel.repository.js', () => ({ findAllThefts: thefts, findAllFillings: fills }))

const cache = await import('../../src/modules/telemetry/day-series-cache.js')
const { getFuelReportData, reportDays, reportBody } = await import('../../src/modules/fuel/fuel-report-data.js')

const eat = (iso: string) => Date.parse(`${iso}+03:00`)

async function call(vehicleId: string, from: number, to: number) {
  let body = ''
  let error: unknown
  const res = { setHeader: vi.fn(), type: vi.fn(() => res), send: vi.fn((b: string) => { body = b }) }
  await getFuelReportData(
    { params: { orgId: 'org1', vehicleId }, query: { from, to } } as never, res as never, ((e: unknown) => { error = e }) as never,
  )
  return { body: body ? JSON.parse(body) : null, error }
}

beforeEach(() => { cache._clearDayMemory(); daySeries.mockClear() })
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('the fleet days of a period', () => {
  it('runs from the first day to the last, not past now', () => {
    expect(reportDays(eat('2026-09-01T00:00:00'), eat('2026-09-04T00:00:00'))).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(reportDays(eat('2026-09-01T06:00:00'), eat('2026-09-01T07:00:00'))).toEqual(['2026-09-01'])
    expect(reportDays(eat('2026-09-01T00:00:00'), eat('2026-09-30T00:00:00'), eat('2026-09-02T09:00:00'))).toEqual(['2026-09-01', '2026-09-02'])
  })
})

describe('the day cache', () => {
  it('keeps a finished day in memory and on disk, and lets it go after a day', async () => {
    const now = eat('2026-09-10T12:00:00')
    expect(cache.settled(eat('2026-09-10T11:00:00'), now)).toBe(false)
    expect(cache.settled(eat('2026-09-10T00:00:00'), now)).toBe(true)
    await cache.keepDay('veh9', '2026-09-01', '{"a":1}', now)
    expect(await cache.cachedDay('veh9', '2026-09-01', now)).toBe('{"a":1}')
    cache._clearDayMemory()
    const f = path.join(dir, 'veh9', '2026-09-01.json.gz')
    fs.utimesSync(f, new Date(now), new Date(now))
    expect(await cache.cachedDay('veh9', '2026-09-01', now)).toBe('{"a":1}')        // from disk
    expect(await cache.cachedDay('veh9', '2026-09-01', now + cache.TTL_MS)).toBeNull()
    expect((await cache.sweepDays(now + cache.TTL_MS)).removed).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(f)).toBe(false)
  })
})

describe('GET report-data', () => {
  const from = eat('2026-09-01T00:00:00'), to = eat('2026-09-04T00:00:00')
  beforeEach(() => { for (const e of fs.readdirSync(dir)) fs.rmSync(path.join(dir, e), { recursive: true, force: true }) })

  it('sends every day, the drains and the fillings in one body, a failed day counted', async () => {
    const { body } = await call('veh1', from, to)
    expect(body.status).toBe('success')
    expect(body.data.days.map((d: { day: string }) => d.day)).toEqual(['2026-09-01', '2026-09-02'])
    expect(body.data.failedDays).toBe(1)
    expect(body.data.drains[0].id).toBe('d1')
    expect(body.data.fillings[0].id).toBe('f1')
    expect(thefts).toHaveBeenCalledWith('org1', expect.objectContaining({ vehicleId: 'veh1', limit: 5000 }), reportPool)
  })

  it('reads a finished day from the database once, for everyone after', async () => {
    await call('veh1', from, to)
    await call('veh1', from, to)
    const reads = daySeries.mock.calls.map(c => c[2].day)
    // 1 and 2 Sep once each; 3 Sep failed, so it is asked again.
    expect(reads.filter(d => d === '2026-09-01')).toHaveLength(1)
    expect(reads.filter(d => d === '2026-09-03')).toHaveLength(2)
  })

  it('answers 404 for a vehicle outside the organisation', async () => {
    const { error } = await call('veh2', from, to)
    expect((error as { statusCode?: number }).statusCode ?? (error as { status?: number }).status).toBe(404)
  })

  it('puts the body together without parsing the kept days', () => {
    const b = reportBody({ vehicleId: 'v', from: 1, to: 2, days: ['{"day":"x"}'], failedDays: 0, drains: [], fillings: [] })
    expect(JSON.parse(b)).toEqual({ statusCode: 200, status: 'success', data: { vehicleId: 'v', from: 1, to: 2, failedDays: 0, days: [{ day: 'x' }], drains: [], fillings: [] } })
  })
})
