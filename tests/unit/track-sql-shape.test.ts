/**
 * Regression guards on the raw SQL in telemetry.repository.
 *
 * ## Why these assert on query TEXT
 *
 * Three defects reached prod verification on 2026-08-09 and none of them could
 * have been caught by the rest of the suite, because the suite mocks Prisma and
 * therefore never executes a statement. All three produced output that looked
 * entirely reasonable:
 *
 *   1. `WHERE captured_at IS NOT NULL` sat in the same query level as the
 *      lag() that detects gaps. WHERE runs BEFORE window functions, so the
 *      empty buckets — which are the entire gap evidence — were removed before
 *      lag() could see them, and no gap was ever detectable.
 *   2. The fence lookup filtered on `is_active`. Only 8 of 107 fences are
 *      active, and lib/zone-presence.ts reports the other 99 as context; the
 *      filter reduced a fortnight of movement to a single "outside every
 *      fence" visit.
 *   3. `ORDER BY ST_Area(f.geom)` inside the LATERAL recomputed a spheroid
 *      area per candidate per probe over rings of up to 872 vertices — 15.2 s
 *      against 3.9 s for identical output.
 *
 * Asserting on text is a weak form of test and it is chosen deliberately over
 * asserting nothing. Each check below encodes the STRUCTURAL invariant that was
 * violated, not the incidental spelling: where a filter sits relative to a
 * window function, which columns may appear in a predicate, and which
 * expression may be a sort key. Reformatting the queries will not trip them;
 * reintroducing any of the three defects will.
 *
 * These do not prove the SQL returns correct rows. That needs a live PostGIS —
 * see docs/postgis-setup.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Without this the repository imports the real client and every test here
// blocks trying to reach the production database.
vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { findSampledFixes, findZoneTimeline } from '../../src/modules/telemetry/telemetry.repository.js'

const FROM = new Date('2026-07-26T00:00:00Z')
const TO   = new Date('2026-08-09T00:00:00Z')

/**
 * The SQL a $queryRaw tagged template would send, with interpolations shown as
 * `$n`. Prisma receives the template's static strings plus its values; joining
 * the strings back together is the statement minus its parameters.
 *
 * `--` comments are stripped. These queries are heavily commented, and several
 * of those comments quote the very constructs asserted against below — the
 * first run of this file failed because the warning against planar ST_Area
 * matched the regex looking for planar ST_Area. What is under test is what
 * Postgres executes, and a comment is not that.
 */
function capturedSql(): string {
  const call = prismaMock.$queryRaw.mock.calls[0]
  const strings = call?.[0] as unknown as string[]
  return strings
    .map((s, i) => (i === 0 ? s : `$${i} ${s}`))
    .join('')
    .replace(/--[^\n]*/g, '')
}

beforeEach(() => {
  // reportedSpan runs first and its result decides whether the raw query runs
  // at all, so it has to return a real span.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.vehicleTelemetry.aggregate as any).mockResolvedValue({
    _min: { capturedAt: FROM },
    _max: { capturedAt: TO },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.$queryRaw as any).mockResolvedValue([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.$executeRawUnsafe as any).mockResolvedValue(0)
})

describe('sampled-track SQL', () => {
  it('filters empty buckets one level ABOVE the window function that needs them', async () => {
    await findSampledFixes('veh_01', FROM, TO)
    const sql = capturedSql()

    const lagAt      = sql.indexOf('lag(')
    const fromFlagAt = sql.indexOf('FROM flagged')
    const filterAt   = sql.indexOf('WHERE captured_at IS NOT NULL')

    expect(lagAt).toBeGreaterThan(-1)
    expect(fromFlagAt).toBeGreaterThan(-1)
    expect(filterAt).toBeGreaterThan(-1)

    // lag() is computed inside the CTE; the null filter is applied only after
    // selecting FROM it. Reversing these two is defect (1): the empty buckets
    // vanish before the window function runs and gap_before is always false.
    expect(lagAt).toBeLessThan(fromFlagAt)
    expect(filterAt).toBeGreaterThan(fromFlagAt)
  })

  it('keeps the bucket join as a LEFT join, so empty buckets survive to be counted', async () => {
    await findSampledFixes('veh_01', FROM, TO)
    const sql = capturedSql()

    // A CROSS JOIN LATERAL here would silently drop every empty bucket at the
    // source, which is the same bug as above by a different route.
    expect(sql).toMatch(/LEFT JOIN LATERAL/)
  })

  it('asks each bucket for one row only', async () => {
    await findSampledFixes('veh_01', FROM, TO)

    // The LIMIT is what makes cost O(buckets) instead of O(fixes) — without it
    // a 30-day window reads 160,890 rows and exceeds a minute.
    expect(capturedSql()).toMatch(/ORDER BY t\."captured_at"\s+LIMIT 1/)
  })

  it('never runs without a statement timeout', async () => {
    await findSampledFixes('veh_01', FROM, TO)

    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/SET LOCAL statement_timeout = \d+/),
    )
  })

  it('gives the transaction more time than the statement it wraps', async () => {
    await findSampledFixes('veh_01', FROM, TO)

    // Two independent clocks, and the order they fire in decides whether a slow
    // query degrades or explodes. Prisma's interactive transaction defaults to
    // 5 s; when that is shorter than the statement timeout it expires first and
    // throws P2028 instead of the query_canceled the handler expects. Caught
    // end-to-end 2026-08-09: a 5.7 s read that was inside its 8 s statement
    // budget and would have SUCCEEDED returned a 500 instead.
    const stmt = Number(
      /statement_timeout = (\d+)/.exec(
        prismaMock.$executeRawUnsafe.mock.calls[0]?.[0] as string,
      )?.[1],
    )
    const opts = prismaMock.$transaction.mock.calls[0]?.[1] as { timeout?: number } | undefined

    expect(stmt).toBeGreaterThan(0)
    expect(opts?.timeout).toBeDefined()
    expect(opts!.timeout!).toBeGreaterThan(stmt)
  })
})

describe('zone-timeline SQL', () => {
  it('does not filter fences by is_active', async () => {
    await findZoneTimeline('veh_01', 'org_01', FROM, TO)
    const sql = capturedSql()

    // is_active is legitimate in exactly one place: deriving `enforced`. Any
    // other appearance is a predicate, and a predicate here is defect (2).
    const uses = sql.match(/is_active/g) ?? []
    expect(uses).toHaveLength(1)
    expect(sql).toMatch(/\(f\."is_active" AND f\."mode" = 'BLOCKLIST'\)\s+AS enforced/)
  })

  it('still restricts fences to the caller\'s organisation', async () => {
    await findZoneTimeline('veh_01', 'org_01', FROM, TO)

    // Dropping the is_active filter must not have loosened the tenancy one.
    expect(capturedSql()).toMatch(/f\."organisation_id" = \$/)
  })

  it('sorts by a precomputed area, never by ST_Area per probe', async () => {
    await findZoneTimeline('veh_01', 'org_01', FROM, TO)
    const sql = capturedSql()

    expect(sql).toMatch(/AS MATERIALIZED/)
    expect(sql).toMatch(/ORDER BY fa\.area_m2/)
    // Defect (3): a spheroid area recomputed for every candidate on every probe.
    expect(sql).not.toMatch(/ORDER BY\s+ST_Area/)
  })

  it('does not substitute planar area for spheroid area', async () => {
    await findZoneTimeline('veh_01', 'org_01', FROM, TO)
    const sql = capturedSql()

    // Held to the exact form on purpose, though this one is a definition guard
    // rather than a bug guard, and the distinction is worth keeping straight.
    // Measured on prod: planar area reranks 62 of 107 fences but inverts ZERO
    // pairs differing by more than 1% in area, so it would not change which
    // fence is chosen. It is simply slower than the exact version once ST_Area
    // is hoisted (4.4 s vs 3.9 s), so there is nothing to buy by loosening it.
    //
    // The live DB test cannot see this substitution at all — its fixture uses
    // concentric circles, which rank identically either way. That is precisely
    // why this file still earns its place alongside it.
    expect(sql).not.toMatch(/ST_Area\([^)]*::geometry/)
    expect(sql).toMatch(/ST_Area\(f\."geom"\)\s+AS area_m2/)
  })

  it('left-joins the fence lookup so time outside every fence is still a visit', async () => {
    await findZoneTimeline('veh_01', 'org_01', FROM, TO)
    const sql = capturedSql()

    // An inner join deletes exactly the segment a backtrack most wants to show.
    expect(sql).toMatch(/LEFT JOIN LATERAL/)
    // ...and the run-detection has to treat that null as a value, not skip it.
    expect(sql).toMatch(/zone_id IS DISTINCT FROM lag\(zone_id\)/)
  })

  it('never runs without a statement timeout', async () => {
    await findZoneTimeline('veh_01', 'org_01', FROM, TO)

    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/SET LOCAL statement_timeout = \d+/),
    )
  })
})

describe('span clamping', () => {
  it('skips the raw query entirely when the unit reported nothing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicleTelemetry.aggregate as any).mockResolvedValue({
      _min: { capturedAt: null }, _max: { capturedAt: null },
    })

    const res = await findSampledFixes('veh_01', FROM, TO)

    expect(res).toEqual({ rows: [], bucketSec: 0 })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
  })

  it('buckets across the reported span, not the requested window', async () => {
    // Unit reported for one day of a fourteen-day request. Bucketing the whole
    // request would spend most of the probe budget on prehistory that cannot
    // contain a fix — measured 19.9 s against 5.7 s.
    const oneDayIn  = new Date('2026-08-01T00:00:00Z')
    const oneDayOut = new Date('2026-08-02T00:00:00Z')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(prismaMock.vehicleTelemetry.aggregate as any).mockResolvedValue({
      _min: { capturedAt: oneDayIn }, _max: { capturedAt: oneDayOut },
    })

    const res = await findSampledFixes('veh_01', FROM, TO)

    // 86,400 s over the 400-sample budget, not 1,209,600 s.
    expect(res?.bucketSec).toBe(216)
  })
})
