import { describe, it, expect } from 'vitest'
import { buildUsageReview, dayStartMs, type ReviewMessage } from '../../src/modules/usage-review/usage-review.compute.js'
import { heldDays } from '../../src/modules/usage-review/usage-review.db.js'
import { nameFromAddress } from '../../src/modules/usage-review/usage-review.geocode.js'

const DAY = '2026-08-01'
const t0 = dayStartMs(DAY) / 1000
// ~1 km east per 0.009 deg of longitude at the equator
const msg = (t: number, lng: number, speed: number, odoM: number | null, extra: Partial<ReviewMessage> = {}): ReviewMessage =>
  ({ t: t0 + t, lat: 0.5, lng, speed, course: 90, odoM, ign: speed > 0, src: 'wialon', ...extra })

/** Parked 1 h at A, drive 10 km in 15 min, parked 1 h at B. One message a minute. */
function scenario(src: 'wialon' | 'db' = 'wialon'): ReviewMessage[] {
  const out: ReviewMessage[] = []
  let t = 3600 * 6
  for (let i = 0; i < 60; i++, t += 60) out.push(msg(t, 34.0, 0, 100_000, { src }))
  for (let i = 1; i <= 15; i++, t += 60) out.push(msg(t, 34.0 + (0.09 * i) / 15, 40, 100_000 + (10_000 * i) / 15, { src }))
  for (let i = 0; i < 60; i++, t += 60) out.push(msg(t, 34.09, 0, 110_000, { src }))
  return src === 'db' ? out.map(m => ({ ...m, odoM: null })) : out
}

describe('buildUsageReview', () => {
  it('measures distance on the odometer, drive time at >= 5 km/h, and finds the stops, places and trip', () => {
    const rv = buildUsageReview(scenario(), DAY, DAY)
    expect(rv.summary.km).toBeCloseTo(10, 1)
    expect(rv.summary.driveH).toBeCloseTo(0.3, 1)          // 15 one-minute steps at speed (the last ends parked)
    expect(rv.stops).toHaveLength(2)
    expect(rv.places).toHaveLength(2)
    expect(rv.trips).toHaveLength(1)
    expect(rv.trips[0]!.km).toBeCloseTo(10, 0)
    expect(rv.quality.distanceSource).toBe('odometer')
    expect(rv.days[0]!.source).toBe('wialon')
  })

  it('measures database days on the GPS track, which agrees with the odometer', () => {
    const rv = buildUsageReview(scenario('db'), DAY, DAY)
    expect(rv.summary.km).toBeGreaterThan(9.9)
    expect(rv.summary.km).toBeLessThan(10.1)
    expect(rv.days[0]!.source).toBe('db')
  })

  it('caps a silence at 5 minutes, so a quiet tracker is not hours of driving', () => {
    const rv = buildUsageReview([msg(0, 34, 50, 1000), msg(3 * 3600, 34.001, 50, 1100)], DAY, DAY)
    // One step, capped at 300 s; the last message has no step after it.
    expect(rv.days[0]!.driveH).toBeCloseTo(300 / 3600, 2)
  })

  it('ignores an impossible odometer jump and backwards odometer steps', () => {
    const rv = buildUsageReview([
      msg(0, 34.0, 30, 1000), msg(60, 34.0045, 30, 900_000), msg(120, 34.009, 30, 900_500), msg(180, 34.0135, 30, 900_400),
    ], DAY, DAY)
    expect(rv.quality.glitchSteps).toBe(1)
    expect(rv.summary.km).toBeLessThan(2)
  })

  it('never carries an odometer across a database message', () => {
    const w1 = msg(0, 34.0, 30, 50_000)
    const d = msg(60, 34.009, 30, null, { src: 'db' })
    const w2 = msg(120, 34.018, 30, 53_000)
    const rv = buildUsageReview([w1, d, w2], DAY, DAY)
    // Both steps touch the database row, so both are GPS (~1 km each): 2 km,
    // not the 3 km a carried-over odometer would claim.
    expect(rv.summary.km).toBeCloseTo(2, 0)
  })

  it('lists every calendar day, moved or not', () => {
    const rv = buildUsageReview(scenario(), '2026-07-31', '2026-08-02')
    expect(rv.days.map(d => d.date)).toEqual(['2026-07-31', '2026-08-01', '2026-08-02'])
    expect(rv.summary.activeDays).toBe(1)
    expect(rv.days[0]!.source).toBeNull()
  })
})

describe('database coverage', () => {
  const every = (fromS: number, toS: number, step: number) => {
    const out: ReviewMessage[] = []
    for (let t = fromS; t < toS; t += step) out.push(msg(t, 34, 0, null, { src: 'db' }))
    return out
  }
  const NOW = dayStartMs('2026-08-10')

  it('holds a day reported every 15 minutes, and not one with a 4-hour hole', () => {
    const ok = every(0, 86_400, 900)
    const holed = every(86_400, 86_400 + 8 * 3600, 900).concat(every(86_400 + 12 * 3600, 2 * 86_400, 900))
    const held = heldDays([...ok, ...holed], '2026-08-01', '2026-08-03', NOW)
    expect([...held]).toEqual(['2026-08-01'])
  })

  it('judges today up to half an hour ago', () => {
    const at5h = dayStartMs(DAY) + 5 * 3600 * 1000
    expect(heldDays(every(0, 3600 * 5, 900), DAY, DAY, at5h).size).toBe(1)
    // Silent since 01:00 and it is 05:00: a hole, so Wialon is asked.
    expect(heldDays(every(0, 3600, 900), DAY, DAY, at5h).size).toBe(0)
  })
})

describe('place names', () => {
  it('reads Kenyan OSM addresses: ward under city, constituency under county', () => {
    expect(nameFromAddress({ city: 'Bukembe East ward', county: 'Kanduyi', state: 'Bungoma County', country: 'Kenya' }).name).toBe('Bukembe East, Kanduyi')
    expect(nameFromAddress({ town: 'Webuye', county: 'Webuye East', state: 'Bungoma County' }).name).toBe('Webuye town')
    expect(nameFromAddress({ road: 'C103', village: 'Mtangani', city: 'Malindi Town ward', county: 'Malindi' }).name).toBe('Mtangani, Malindi Town')
  })
})

describe('rezip', () => {
  it('re-deflates a stored workbook that still reads back the same', async () => {
    const XLSX = await import('xlsx')
    const { rezip } = await import('../../src/modules/usage-review/rezip.js')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], ...Array.from({ length: 2000 }, (_, i) => [i, `row ${i % 7}`])]), 'S')
    const stored = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: false }) as Buffer
    const z = rezip(stored)
    expect(z.length).toBeLessThan(stored.length / 3)
    const back = XLSX.read(z, { type: 'buffer' })
    expect(XLSX.utils.sheet_to_json(back.Sheets['S']!, { header: 1 })).toEqual(XLSX.utils.sheet_to_json(wb.Sheets['S']!, { header: 1 }))
  })
})
