/**
 * The map's weather layer asks Google for a grid of points over the view,
 * snapped to fixed cells so nearby views share points (and the cache).
 */

import { describe, it, expect } from 'vitest'
import { gridFor, toPoint } from '../../src/providers/google-weather/index.js'

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
