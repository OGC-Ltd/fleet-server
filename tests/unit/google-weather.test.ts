/**
 * The map's weather layer asks Google for a grid of points over the view,
 * snapped to fixed cells so nearby views share points (and the cache).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { gridFor, toPoint, weatherGrid } from '../../src/providers/google-weather/index.js'

describe('gridFor', () => {
  it('keeps a county-sized view to a handful of cells', () => {
    const { step, cells } = gridFor({ south: -1.2, west: 34.0, north: -0.5, east: 34.9 })
    expect(step).toBe(0.25)
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.length).toBeLessThanOrEqual(36)
    for (const c of cells) {
      expect(c.lat).toBeGreaterThanOrEqual(-1.25)
      expect(c.lat).toBeLessThanOrEqual(-0.5 + 0.25)
    }
  })

  it('gives two overlapping views the same cell for the same place', () => {
    const a = gridFor({ south: -1.2, west: 34.0, north: -0.5, east: 34.9 })
    const b = gridFor({ south: -1.1, west: 34.1, north: -0.4, east: 35.0 })
    const key = (c: { i: number; j: number }) => `${c.i}:${c.j}`
    const shared = a.cells.filter((c) => b.cells.some((d) => key(d) === key(c)))
    expect(a.step).toBe(b.step)
    expect(shared.length).toBeGreaterThan(0)
  })

  it('uses coarser cells for a country-sized view', () => {
    expect(gridFor({ south: -5, west: 33, north: 5, east: 42 }).step).toBe(2)
  })
})

describe('toPoint', () => {
  it('reads the fields the map shows from Google\'s reply', () => {
    const p = toPoint(-0.82, 34.38, {
      weatherCondition: { iconBaseUri: 'https://maps.gstatic.com/weather/v1/partly_cloudy', description: { text: 'Partly sunny' }, type: 'PARTLY_CLOUDY' },
      temperature: { degrees: 20.1 },
      precipitation: { probability: { percent: 5 }, qpf: { quantity: 0.4 } },
      wind: { direction: { cardinal: 'EAST', degrees: 91 }, speed: { value: 6 }, gust: { value: 11 } },
      isDaytime: true,
      currentTime: '2026-10-27T04:03:07Z',
    })
    expect(p).toMatchObject({ type: 'PARTLY_CLOUDY', text: 'Partly sunny', tempC: 20.1, rainPct: 5, windKmh: 6, windFrom: 'EAST', windDeg: 91, rainMm: 0.4, isDay: true })
    expect(p.visibilityKm).toBeNull()
  })
})

describe('weatherGrid', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('reports a key Google refuses instead of an empty sky, and does not cache it', async () => {
    const refuse = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Weather API has not been used in project' } }), { status: 403 }))
    vi.stubGlobal('fetch', refuse)
    const b = { south: 10.01, west: 10.01, north: 10.04, east: 10.04 }
    const a = await weatherGrid(b)
    expect(a.points).toEqual([])
    expect(a.refused).toMatch(/Weather API/)

    const ok = vi.fn(async () => new Response(JSON.stringify({ weatherCondition: { type: 'CLEAR' } }), { status: 200 }))
    vi.stubGlobal('fetch', ok)
    const c = await weatherGrid(b)
    expect(c.refused).toBeUndefined()
    expect(c.points.map((p) => p.type)).toContain('CLEAR')
  })
})

describe('weatherGrid deadline', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('answers on time with what is ready, counts the rest, and has them next time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 120))
      return new Response(JSON.stringify({ weatherCondition: { type: 'CLOUDY' } }), { status: 200 })
    }))
    const b = { south: 20.01, west: 20.01, north: 20.04, east: 20.04 }
    const t0 = Date.now()
    const first = await weatherGrid(b, { within: 30 })
    expect(Date.now() - t0).toBeLessThan(100)
    expect(first.pending).toBeGreaterThan(0)
    expect(first.points).toEqual([])

    await new Promise((r) => setTimeout(r, 200)) // the late lookups land in the cache
    const again = await weatherGrid(b, { within: 30 })
    expect(again.pending).toBe(0)
    expect(again.points.length).toBe(first.pending)
  })
})
