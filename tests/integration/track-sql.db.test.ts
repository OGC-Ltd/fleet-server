/**
 * The track SQL, executed against a real PostGIS database.
 *
 * The rest of the suite mocks Prisma, so no statement is ever run and three
 * defects reached prod verification on 2026-08-09 unnoticed (see
 * tests/unit/track-sql-shape.test.ts for what they were). Those guards assert
 * query TEXT. This file asserts what the queries actually RETURN, which is the
 * only thing that proves the semantics.
 *
 * ## Running it
 *
 * Skipped unless TEST_DATABASE_URL points at a PostGIS database. It must not
 * point at anything real — every test truncates both tables.
 *
 *   TEST_DATABASE_URL=postgresql://user:pw@host:port/db npx vitest run tests/integration/track-sql.db.test.ts
 *
 * The schema is tests/helpers/track-test-schema.sql followed by the real
 * migration in prisma/migrations/20260808120000_postgis_geofence_geometry, so
 * `geofences.geom` is derived by the same trigger production uses.
 *
 * ## What these were shown to catch
 *
 * Verified by reintroducing each defect and confirming the failure, rather than
 * by assuming a passing assertion means anything:
 *
 *   null-filter moved inside the CTE  -> 1 failure  (the gap test)
 *   is_active filter reinstated       -> 3 failures (inactive fence, outside
 *                                        visit, and the visit sequence)
 *   sort order reversed               -> 2 failures (smallest-fence, sequence)
 *
 * And one thing they provably do NOT catch: swapping the spheroid sort key for
 * planar `ST_Area(geom::geometry)` passes all 11. The fixture uses concentric
 * circles at one latitude, which rank identically under both. That substitution
 * is guarded in tests/unit/track-sql-shape.test.ts instead — the two files are
 * complementary, and deleting either leaves a hole.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'

// vi.mock is hoisted above every import and every top-level binding, so the
// factory has to read the environment itself rather than close over a const.
vi.mock('../../src/lib/prisma.js', async () => {
  const url = process.env['TEST_DATABASE_URL']
  const noop = { connectDB: async () => {}, disconnectDB: async () => {} }
  // Without a database the suite below is skipped, but this factory still runs
  // when the repository imports it — so it must not try to build a client.
  if (!url) return { prisma: {}, ...noop }
  const { PrismaClient } = await import('../../generated/prisma/client.js')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  return { prisma: new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }), ...noop }
})

const TEST_URL = process.env['TEST_DATABASE_URL']

import { prisma } from '../../src/lib/prisma.js'
import { findSampledFixes, findZoneTimeline } from '../../src/modules/telemetry/telemetry.repository.js'

const ORG = 'org_test'
const VEH = 'veh_test'

// One centre, two concentric fences around it. The nesting is the point: a
// point at the centre sits inside BOTH, so something has to choose, and the
// larger of the two is the one that is switched OFF.
const LAT = -0.36
const LNG = 35.28

/** ~500 m north of centre: inside the 1000 m fence, outside the 100 m one. */
const LAT_500M = LAT + 500 / 111_320
/** ~6 km away: inside the far fence only. */
const FAR_LAT = -0.40
const FAR_LNG = 35.32
/** Inside nothing at all. */
const NOWHERE_LAT = -0.50
const NOWHERE_LNG = 35.50

const T0 = new Date('2026-08-01T00:00:00.000Z')
const at = (sec: number) => new Date(T0.getTime() + sec * 1000)

/** `captured_at` is timestamp WITHOUT time zone; feed it a matching literal. */
const stamp = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '')

async function seedFences() {
  await prisma.$executeRawUnsafe(`
    INSERT INTO "geofences"
      ("id","organisation_id","name","type","mode","center_lat","center_lng","radius_m","is_active")
    VALUES
      -- Large, and NOT active. 99 of the 107 real fences look like this; the
      -- live path reports them as context, so the timeline must too.
      ('f_big',   '${ORG}', 'BIG CIRCLE',   'CIRCLE', 'BLOCKLIST', ${LAT}, ${LNG}, 1000, false),
      -- Small, active, concentric with the big one.
      ('f_small', '${ORG}', 'SMALL CIRCLE', 'CIRCLE', 'BLOCKLIST', ${LAT}, ${LNG}, 100,  true),
      ('f_far',   '${ORG}', 'FAR CIRCLE',   'CIRCLE', 'BLOCKLIST', ${FAR_LAT}, ${FAR_LNG}, 1000, false),
      -- Another organisation, same coordinates. Must never appear.
      ('f_other', 'org_other', 'OTHER ORG', 'CIRCLE', 'BLOCKLIST', ${LAT}, ${LNG}, 50, true)
  `)
}

/**
 * A run with a deliberate 30-minute silence in the middle.
 *
 * Fixes are 30 s apart, matching the real poll cadence, because the bucket
 * width derives from the span: at this density every bucket holds exactly one
 * fix and the ONLY empty buckets are the real silence. A sparser fixture would
 * make every fix look like it followed a gap and would prove nothing.
 */
async function seedRun() {
  const rows: string[] = []
  const push = (sec: number, lat: number, lng: number) =>
    rows.push(`('${VEH}','${stamp(at(sec))}',${lat},${lng},true,10)`)

  for (let s = 0;    s <= 300; s += 30) push(s, LAT, LNG)                 // SMALL (and BIG)
  for (let s = 330;  s <= 480; s += 30) push(s, LAT_500M, LNG)            // BIG only
  for (let s = 510;  s <= 600; s += 30) push(s, LAT, LNG)                 // back to SMALL
  // ---- 30 minutes of nothing ----
  for (let s = 2400; s <= 2580; s += 30) push(s, FAR_LAT, FAR_LNG)        // FAR
  for (let s = 2610; s <= 2700; s += 30) push(s, NOWHERE_LAT, NOWHERE_LNG) // outside everything

  await prisma.$executeRawUnsafe(`
    INSERT INTO "vehicle_telemetries"
      ("vehicle_id","captured_at","lat","lng","engine_on","speed_kmh")
    VALUES ${rows.join(',')}
  `)
}

/** The instant the silence ends, which is the only fix that may carry a gap. */
const FIRST_AFTER_GAP = at(2400).getTime()

describe.skipIf(!TEST_URL)('track SQL against real PostGIS', () => {
  beforeAll(async () => {
    const [{ postgis }] = await prisma.$queryRawUnsafe<{ postgis: string }[]>(
      'SELECT postgis_version() AS postgis',
    )
    expect(postgis).toBeTruthy()
  })

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "vehicle_telemetries", "geofences"')
    await seedFences()
    await seedRun()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  describe('the geofence trigger', () => {
    it('derives a shape for every seeded fence', async () => {
      const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        'SELECT count(*) AS n FROM "geofences" WHERE "geom" IS NULL',
      )
      expect(Number(rows[0].n)).toBe(0)
    })
  })

  describe('findSampledFixes', () => {
    it('marks exactly one gap, at the fix that ends the silence', async () => {
      const res = await findSampledFixes(VEH, at(-60), at(3000))

      const gaps = res!.rows.filter(r => r.gap_before)
      // Defect (1): with the null-filter inside the CTE, lag() never sees an
      // empty bucket and this comes back as zero.
      expect(gaps).toHaveLength(1)
      expect(gaps[0].captured_at.getTime()).toBe(FIRST_AFTER_GAP)
    })

    it('returns fixes oldest-first and drops no positioned fix', async () => {
      const res = await findSampledFixes(VEH, at(-60), at(3000))
      const times = res!.rows.map(r => r.captured_at.getTime())

      expect(times).toEqual([...times].sort((a, b) => a - b))
      // 30 s cadence and a 30 s bucket: every fix survives sampling.
      expect(res!.bucketSec).toBe(30)
      expect(res!.rows.length).toBe(32)
    })

    it('buckets across the reported span, not the requested window', async () => {
      // A 30-day request over 45 minutes of data. Bucketing the request would
      // spend the whole budget on emptiness — measured 19.9 s vs 5.7 s on prod.
      const wide = await findSampledFixes(VEH, new Date(T0.getTime() - 30 * 864e5), at(3000))
      expect(wide!.bucketSec).toBe(30)
      expect(wide!.rows.length).toBe(32)
    })

    it('returns nothing for a window the unit was silent through', async () => {
      const res = await findSampledFixes(VEH, at(1200), at(1800))
      expect(res).toEqual({ rows: [], bucketSec: 0 })
    })
  })

  describe('findZoneTimeline', () => {
    it('attributes a point to the SMALLEST fence containing it', async () => {
      const res = await findZoneTimeline(VEH, ORG, at(-60), at(3000))
      const first = res!.rows[0]

      // Centre of both circles. Defect (3) territory: order by anything other
      // than true area and the 1000 m fence can win.
      expect(first.zone_name).toBe('SMALL CIRCLE')
      expect(first.enforced).toBe(true)
    })

    it('reports an INACTIVE fence rather than dropping it', async () => {
      const res = await findZoneTimeline(VEH, ORG, at(-60), at(3000))
      const big = res!.rows.find(r => r.zone_name === 'BIG CIRCLE')

      // Defect (2): filtering is_active made a fortnight of movement collapse
      // to one "outside every fence" visit. BIG is inactive and must still
      // appear — as context, with enforced false.
      expect(big).toBeDefined()
      expect(big!.enforced).toBe(false)
    })

    it('records time outside every fence as its own visit', async () => {
      const res = await findZoneTimeline(VEH, ORG, at(-60), at(3000))
      const outside = res!.rows.filter(r => r.zone_id === null)

      // An inner join would delete the most interesting segment a backtrack has.
      expect(outside).toHaveLength(1)
      expect(Number(outside[0].samples)).toBe(4)
    })

    it('splits a re-entered zone into separate visits', async () => {
      const res = await findZoneTimeline(VEH, ORG, at(-60), at(3000))
      const names = res!.rows.map(r => r.zone_name)

      // SMALL -> BIG -> SMALL again: three visits, not two merged ranges.
      expect(names).toEqual([
        'SMALL CIRCLE', 'BIG CIRCLE', 'SMALL CIRCLE', 'FAR CIRCLE', null,
      ])
    })

    it('orders visits chronologically and keeps their bounds', async () => {
      const res = await findZoneTimeline(VEH, ORG, at(-60), at(3000))

      const starts = res!.rows.map(r => r.entered_at.getTime())
      expect(starts).toEqual([...starts].sort((a, b) => a - b))
      for (const v of res!.rows) {
        expect(v.left_at.getTime()).toBeGreaterThanOrEqual(v.entered_at.getTime())
      }
      expect(res!.rows[0].entered_at.getTime()).toBe(T0.getTime())
    })

    it('never attributes to another organisation\'s fence', async () => {
      // org_other has a 50 m fence on the same centre — smaller than SMALL, so
      // a missing tenancy filter would hand it every point at the centre.
      const res = await findZoneTimeline(VEH, ORG, at(-60), at(3000))
      expect(res!.rows.map(r => r.zone_name)).not.toContain('OTHER ORG')
    })
  })
})
