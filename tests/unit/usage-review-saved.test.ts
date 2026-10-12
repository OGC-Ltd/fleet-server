/**
 * Finished Logbook reviews kept on disk (usage-review.saved), 2026-10-10: one
 * build serves everyone who asks for that unit and those dates, survives a
 * restart, and the store stays under its cap, least recently used out first.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-reviews-'))
process.env['REPORT_STORE_DIR'] = dir

const saved = await import('../../src/modules/usage-review/usage-review.saved.js')
type Ready = Parameters<typeof saved.saveReview>[1]

const DAY = 86_400_000
const t0 = Date.UTC(2026, 8, 1, 3)          // 06:00 EAT, 1 Sep
const point = (t: number) => ({ t, lat: 0.5, lng: 35, speed: 0, course: null, ign: false, odoKm: null, moving: false })
const review = (n = 3) => ({
  period: { from: '2026-09-01', to: '2026-09-03', days: 3, startMs: t0, endMs: t0 + 3 * DAY },
  builtAt: t0 + 4 * DAY,
  points: Array.from({ length: n }, (_, i) => point(t0 + i * DAY)),
  places: [{ id: 1 }],
}) as unknown as Ready

beforeAll(() => fs.mkdirSync(dir, { recursive: true }))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('saved reviews', () => {
  const key = saved.reviewKey('org1', 'veh1', '2026-09-01', '2026-09-03')

  it('keeps a review without its fixes, and each day of fixes on its own', async () => {
    await saved.saveReview(key, review())
    const rv = await saved.loadReview(key)
    expect(rv?.builtAt).toBe(t0 + 4 * DAY)
    expect(rv?.points).toEqual([])
    expect((await saved.loadPoints(key, '2026-09-02'))?.map(p => p.t)).toEqual([t0 + DAY])
    expect(await saved.loadPoints(key, '2026-09-09')).toBeNull()
    expect((await saved.loadAllPoints(key)).map(p => p.t)).toEqual([t0, t0 + DAY, t0 + 2 * DAY])
  })

  it('keeps a rendered file beside its review, and drops both on a rebuild', async () => {
    await saved.saveFile(key, 'pdf-abc.pdf', Buffer.from('%PDF-x'))
    expect((await saved.savedFile(key, 'pdf-abc.pdf'))?.toString()).toBe('%PDF-x')
    // Rebuilt under the same key: the old file went with the old review.
    await saved.saveReview(key, review(1))
    expect(await saved.savedFile(key, 'pdf-abc.pdf')).toBeNull()
    expect((await saved.loadAllPoints(key)).length).toBe(1)
    await saved.dropReview(key)
    expect(await saved.loadReview(key)).toBeNull()
  })

  it('does not keep a file for a review it does not hold', async () => {
    await saved.saveFile(saved.reviewKey('org1', 'gone', 'a', 'b'), 'x.pdf', Buffer.from('x'))
    expect(await saved.savedFile(saved.reviewKey('org1', 'gone', 'a', 'b'), 'x.pdf')).toBeNull()
  })

  it('sweeps the least recently used past the cap, and other formats', async () => {
    const old = saved.reviewKey('org1', 'veh2', '2026-08-01', '2026-08-31')
    const recent = saved.reviewKey('org1', 'veh3', '2026-08-01', '2026-08-31')
    await saved.saveReview(old, review(40))
    await saved.saveReview(recent, review(40))
    // `old` last read long ago.
    const used = path.join(dir, `v${saved.SAVED_FORMAT}`, 'org1', 'veh2', '2026-08-01_2026-08-31', 'used')
    fs.utimesSync(used, new Date(2020, 0, 1), new Date(2020, 0, 1))
    fs.mkdirSync(path.join(dir, 'v0', 'x'), { recursive: true })

    const before = await saved.sweepSaved(Number.MAX_SAFE_INTEGER)
    expect(before.removed).toBe(0)
    const r = await saved.sweepSaved(before.bytes - 1)
    expect(r.removed).toBe(1)
    expect(await saved.loadReview(old)).toBeNull()
    expect(await saved.loadReview(recent)).not.toBeNull()
    expect(fs.existsSync(path.join(dir, 'v0'))).toBe(false)
  })
})
