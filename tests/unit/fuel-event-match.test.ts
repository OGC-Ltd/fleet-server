import { describe, it, expect } from 'vitest'
import { sameDrain, sameFilling, matchRow } from '../../src/modules/fuel/fuel-event-match.js'

const d = (iso: string) => new Date(iso)
const drain = (began: string, detected: string) => ({ beganAt: d(began), detectedAt: d(detected) })
const fill = (at: string, initial: number | null, final: number | null) => ({
  filledAt: d(at), initialFuelLevelMl: initial, finalFuelLevelMl: final,
})

describe('sameDrain', () => {
  // Every case below is a pair of rows the live sync actually wrote. The whole
  // point of the rule is that these collapse; if any of them stops matching,
  // the fuel-loss figure starts inflating again.
  it('matches the re-clamped starts of one in-progress drain (MUFINDI: 008)', () => {
    // The nine evening rows the old sync wrote for 2026-08-03, verbatim. Their
    // starts march forward 15 minutes at a time — the sync cadence stamped into
    // the data — while the provider's settled answer for the evening is one
    // drain, 20:08:03 → 20:41:18, of 275.7 L. The ledger claimed 1,458 L.
    const stored = [
      drain('2026-08-03T20:08:03Z', '2026-08-03T20:41:18Z'),
      drain('2026-08-03T20:15:27Z', '2026-08-03T20:41:18Z'),
      drain('2026-08-03T20:30:29Z', '2026-08-03T20:41:18Z'),
      drain('2026-08-03T20:45:04Z', '2026-08-03T20:57:29Z'),
      drain('2026-08-03T21:00:07Z', '2026-08-03T23:30:01Z'),
      drain('2026-08-03T21:15:08Z', '2026-08-03T23:30:01Z'),
      drain('2026-08-03T21:30:10Z', '2026-08-03T23:30:01Z'),
      drain('2026-08-03T21:45:12Z', '2026-08-03T23:30:01Z'),
      drain('2026-08-03T22:00:44Z', '2026-08-03T23:30:01Z'),
    ]
    const settled = stored[0]!

    // The three that describe the drain the provider still reports collapse
    // onto it, so the sync updates one row instead of inserting three.
    expect(stored.filter(s => sameDrain(settled, s))).toHaveLength(3)

    // Grouping the whole set by overlap leaves 3 clusters, not 9 rows.
    const clusters: (typeof stored) = []
    for (const s of stored) if (!clusters.some(c => sameDrain(c, s))) clusters.push(s)
    expect(clusters).toHaveLength(3)

    // The other two clusters are the SECOND failure mode, and matching cannot
    // touch them: 20:45→20:57 and 21:00→23:30 are events Wialon has since
    // retracted, disjoint from anything it still reports. Only the reconcile
    // pass removes those — see fuel-sync.service's SyncOptions.reconcile.
    expect(sameDrain(settled, stored[3]!)).toBe(false)
    expect(sameDrain(settled, stored[4]!)).toBe(false)
  })

  it('matches when the END drifts too (MUFINDI: EX 17)', () => {
    // Both edges move as the drain continues: 23:02 → 23:41 → 00:22.
    const a = drain('2026-08-03T20:21:02Z', '2026-08-03T23:02:06Z')
    const b = drain('2026-08-03T21:46:27Z', '2026-08-04T00:22:21Z')
    expect(sameDrain(a, b)).toBe(true)
  })

  it('keeps two genuinely separate drains apart (MUFINDI: DZ 04)', () => {
    // 07:31→07:48 and 07:55→08:04 do not overlap. Merging them would hide a
    // real second event, which is the opposite failure and just as bad.
    const first  = drain('2026-08-03T07:31:02Z', '2026-08-03T07:48:19Z')
    const second = drain('2026-08-03T07:55:49Z', '2026-08-03T08:04:19Z')
    expect(sameDrain(first, second)).toBe(false)
  })

  it('matches an instantaneous drain against itself (MUFINDI: CTR 23)', () => {
    // Wialon emits these with began == detected. A strict overlap test can
    // never match a zero-length interval, so every cycle would insert one more.
    const instant = drain('2026-08-03T09:16:45Z', '2026-08-03T09:16:45Z')
    expect(sameDrain(instant, instant)).toBe(true)
  })

  it('treats a shared boundary as one drain split across two executions', () => {
    const a = drain('2026-08-03T10:00:00Z', '2026-08-03T10:30:00Z')
    const b = drain('2026-08-03T10:30:00Z', '2026-08-03T11:00:00Z')
    expect(sameDrain(a, b)).toBe(true)
  })

  describe('re-clamped instants', () => {
    const lv = (began: string, detected: string, initialL: number, finalL: number) =>
      ({ ...drain(began, detected), initialFuelLevelMl: initialL * 1000, finalFuelLevelMl: finalL * 1000 })

    it('matches one fall Wialon placed at two minutes (KCX 795S, 24 Oct)', () => {
      // Our tank fell 10 L in all; these were stored as two rows and announced
      // as two possible thefts, the second 8 h late.
      const a = lv('2026-10-24T16:30:36Z', '2026-10-24T16:31:52Z', 54, 43)
      const b = lv('2026-10-24T16:38:01Z', '2026-10-24T16:38:01Z', 54, 43)
      expect(sameDrain(a, b)).toBe(true)
      expect(sameDrain(b, a)).toBe(true)
    })

    it('matches a version 15 min on that ends at the same level (KTCC 189M, 27 Oct)', () => {
      const a = lv('2026-10-27T16:42:32Z', '2026-10-27T16:43:32Z', 35, 24)
      const b = lv('2026-10-27T16:58:32Z', '2026-10-27T16:58:32Z', 37, 24)
      expect(sameDrain(a, b)).toBe(true)
    })

    it('keeps a second drain that ends lower apart', () => {
      // KTCC 192M, 28 Oct: 85→70 then 69→53 — the tank went on falling.
      const a = lv('2026-10-28T10:09:13Z', '2026-10-28T10:09:25Z', 85, 70)
      const b = lv('2026-10-28T10:28:19Z', '2026-10-28T10:29:19Z', 69, 53)
      expect(sameDrain(a, b)).toBe(false)
    })

    it('keeps them apart when fuel arrived in between', () => {
      // Same end level, but the second starts well above the first: a refill
      // came between two real drains.
      const a = lv('2026-10-28T10:00:00Z', '2026-10-28T10:02:00Z', 60, 40)
      const b = lv('2026-10-28T10:15:00Z', '2026-10-28T10:16:00Z', 80, 40)
      expect(sameDrain(a, b)).toBe(false)
    })

    it('keeps them apart past the gap, or without levels', () => {
      const a = lv('2026-10-28T10:00:00Z', '2026-10-28T10:02:00Z', 54, 43)
      expect(sameDrain(a, lv('2026-10-28T10:23:00Z', '2026-10-28T10:23:00Z', 54, 43))).toBe(false)
      expect(sameDrain(a, drain('2026-10-28T10:08:00Z', '2026-10-28T10:08:00Z'))).toBe(false)
    })
  })
})

describe('sameFilling', () => {
  it('matches one fill re-reported seconds apart (MUFINDI: CTR 23)', () => {
    // 20:46:31 `1191.5 → 1212.6` and 20:47:01 `1200.7 → 1212.6` — the same
    // fill, stored twice, 32.9 L claimed where the provider reports 11.8 L.
    const a = fill('2026-08-03T20:46:31Z', 1_191_500, 1_212_600)
    const b = fill('2026-08-03T20:47:01Z', 1_200_700, 1_212_600)
    expect(sameFilling(a, b)).toBe(true)
  })

  it('matches when the volume was revised but the tank state was not (KCR 714F)', () => {
    const a = fill('2026-08-03T18:40:04Z', 45_900, 60_200)
    const b = fill('2026-08-03T18:40:34Z', 45_900, 95_200)
    expect(sameFilling(a, b)).toBe(true)
  })

  it('matches reports minutes apart that describe overlapping levels (MUFINDI: DZ 04)', () => {
    const a = fill('2026-08-03T07:26:55Z', 77_700, 541_600)
    const b = fill('2026-08-03T07:28:32Z', 506_800, 530_500)
    expect(sameFilling(a, b)).toBe(true)
  })

  it('keeps two real fills apart when the tank was drawn down between them', () => {
    // Same vehicle, ten minutes apart, but the levels do not overlap — the
    // tank cannot be at 500 L and at 100 L for the same event.
    const a = fill('2026-08-03T08:00:00Z', 400_000, 500_000)
    const b = fill('2026-08-03T08:10:00Z', 60_000, 100_000)
    expect(sameFilling(a, b)).toBe(false)
  })

  it('keeps overlapping levels apart when they are hours apart', () => {
    // Fill to 500, burn down, fill to 500 again: the ranges overlap, so time
    // is what separates them.
    const a = fill('2026-08-03T08:00:00Z', 100_000, 500_000)
    const b = fill('2026-08-03T18:00:00Z', 120_000, 500_000)
    expect(sameFilling(a, b)).toBe(false)
  })

  it('falls back to a tight time bound when no levels were reported', () => {
    const a = fill('2026-08-03T08:00:00Z', null, null)
    expect(sameFilling(a, fill('2026-08-03T08:01:00Z', null, null))).toBe(true)
    expect(sameFilling(a, fill('2026-08-03T08:09:00Z', null, null))).toBe(false)
  })

  it('matches on one shared end when the other is missing', () => {
    // The standalone theft template reports a final level and no initial one;
    // fillings can arrive half-populated the same way.
    const a = fill('2026-08-03T08:00:00Z', null, 200_000)
    const b = fill('2026-08-03T08:02:00Z', 150_000, 200_000)
    expect(sameFilling(a, b)).toBe(true)
  })
})

describe('matchRow', () => {
  const rows = [
    { id: 'a', at: d('2026-08-03T10:00:00Z') },
    { id: 'b', at: d('2026-08-03T10:05:00Z') },
  ]
  const near = (target: string) => (r: { at: Date }) => Math.abs(r.at.getTime() - d(target).getTime())

  it('picks the closest of several candidates', () => {
    const hit = matchRow(rows, new Set(), () => true, near('2026-08-03T10:04:00Z'))
    expect(hit?.id).toBe('b')
  })

  it('will not bind two reported events to one row', () => {
    // A report can return two distinct drains that both overlap one stale row.
    // Without the claim set they would both rewrite it and the second would
    // silently erase the first.
    const hit = matchRow(rows, new Set(['b']), () => true, near('2026-08-03T10:04:00Z'))
    expect(hit?.id).toBe('a')
  })

  it('returns null when nothing matches', () => {
    expect(matchRow(rows, new Set(), () => false, near('2026-08-03T10:00:00Z'))).toBeNull()
  })
})
