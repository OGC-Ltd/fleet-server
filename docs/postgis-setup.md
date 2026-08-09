# PostGIS on the fleet database

Status as of 2026-08-09: **steps 1, 2 and 4 are done. Step 3 is not.**

| Step | State |
|---|---|
| 1 — extension | Done. `postgis` 3.6.1 is installed, owned by `rdsadmin`, and `fleet_app` can read `spatial_ref_sys`, `geometry_columns`, `geography_columns`. The master credential is **no longer needed**. |
| 2 — migration | Done. `20260808120000_postgis_geofence_geometry` applied 2026-08-09 02:47 UTC. All 107 fences derived a shape: 0 null, 0 invalid, across 67 CIRCLE / 29 POLYGON / 11 LINE. |
| 3 — telemetry index | **Not built.** Attempted 2026-08-09 and rolled back — see below. |
| 4 — verify | Sections 1–4 pass. Section 5 cannot run until step 3 exists. |

## Step 3 was attempted on 2026-08-09 and backed out

The `CREATE INDEX CONCURRENTLY` ran for about 12 minutes, reached ~40% of the
heap scan, and took the instance down with it: every backend stacked up on
`wait_event_type = IO`, new connections stopped completing from both the app box
and the dev tunnel, and `/api/v1/bootstrap` went from ~1 ms to 8.7 s to timing
out. The build was cancelled, and the 392 MB INVALID index it left behind was
dropped with `DROP INDEX CONCURRENTLY`. Index space is back to its pre-build
1181 MB and the API recovered. Nothing else was changed.

The cause is instance size, not the index. `fleet-store` reports
`shared_buffers` 225 MB, `effective_cache_size` 451 MB, `max_connections` 79 —
RDS derives all three from instance memory, which puts it at roughly **1 GB of
RAM serving a 5932 MB database**. On top of that, `01-telemetry-spatial-index.sql`
was setting `maintenance_work_mem = '256MB'`, more than the instance had left to
give. That `SET` has been removed.

Before retrying, pick one:

- **Scale the instance up** for the build and back down after. Cleanest, but
  changing instance class restarts the database.
- **Retry as-is in a genuinely quiet window**, at the default 64 MB
  `maintenance_work_mem`, from the app box rather than over the dev tunnel, with
  someone watching the API. Slower, and still not free on a 1 GB box.
- **Leave it unbuilt.** Everything in steps 1, 2 and 4 keeps working; only the
  history-against-boundary query in section 5 stays a sequential scan, so don't
  put it on a request path.

The rest of this document describes the original plan and is still accurate.

## Why

Zones are stored as three loosely-related columns — a centre and a radius, or a
`polygon_coords` blob of untyped `Jsonb` — and the only thing that can interpret
them is `src/lib/geofence.ts`. That is fine for the live path and it stays: the
in-memory evaluation in `src/lib/zone-presence.ts` is correct for what it does,
and a per-ping database round trip across the fleet would be worse in every way.

What was impossible is anything set-based:

- No way to ask which of 4.85M telemetry rows fell inside a given zone.
- No way to check that a 872-vertex ring is a valid polygon at all — the reason
  `prisma/fix-ring-geofences.ts` exists.
- Zone area came from a hand-rolled spherical approximation in
  `lib/zone-taxonomy.ts` rather than a spheroid calculation.

So `geofences.geom` is **derived, never authoritative**. The existing columns
remain the source of truth, a trigger keeps `geom` in step with them, and no
application write path changed. Nothing that works today depends on it.

## What the database looked like before

Verified against prod on 2026-08-08:

| | |
|---|---|
| Engine | PostgreSQL 18.3 (aarch64), database `fleet`, 5591 MB |
| PostGIS | 3.6.1 available; `rds.allowed_extensions = *` |
| Installed extensions | `plpgsql` only |
| App role | `fleet_app` — **owns** the database, CREATE on db and `public` |
| Zones | 107 total: 67 CIRCLE (all r=1000 m), 29 POLYGON, 11 LINE (2–10 m wide) |
| Telemetry | `vehicle_telemetries` 4.85M rows / 1876 MB (758 MB heap, 1118 MB indexes) |

Two data details the DDL has to handle, both found by inspection rather than
assumed: CIRCLE rows store Jsonb `null` in `polygon_coords` and describe
themselves purely with centre + radius; and **one of the 29 POLYGON rings is not
closed** — `Workshop A`, 12 vertices whose last does not repeat its first —
which would abort `ST_GeomFromGeoJSON` if it were not closed in code.

The migration's jsonb logic (type branching, ring closure, GeoJSON assembly) was
replayed against all 107 production rows before being written, with PostGIS
absent: 67/67 circles have a usable centre and radius, 29/29 rings and 11/11
centre-lines assemble, nothing comes out null, no vertex is non-numeric or
outside WGS-84 range, and `Workshop A` closes to 13 points.

## Step 1 — install the extension (RDS master user, once) — ALREADY DONE

> Kept for the record. The extension is installed and owned by `rdsadmin`, so
> this never needs running again and the master password is not needed. The
> credential on hand as of 2026-08-09 does not authenticate as `postgres`, so if
> a superuser is ever needed again, reset it in the RDS console first.


`fleet_app` cannot do this. It is not a member of `rds_superuser`, and on RDS
that is what `CREATE EXTENSION postgis` requires:

```
ERROR:  permission denied to create extension "postgis"
HINT:   Must be rds_superuser to create this extension.
```

`postgres` is the only role on the instance in `rds_superuser`. If its password
is unknown, reset it in the RDS console (Modify → New master password) — that
applies immediately and does not restart the instance or disturb `fleet_app`.

Open the tunnel:

```bash
ssh -i keys/logistics.pem -N -L 15432:fleet-store.c8ty8uocsdjp.us-east-1.rds.amazonaws.com:5432 ubuntu@ec2-18-232-178-169.compute-1.amazonaws.com
```

Then, as master:

```bash
psql "postgresql://postgres:<master-pw>@localhost:15432/fleet?sslmode=require" -v ON_ERROR_STOP=1 -f prisma/postgis/00-bootstrap-as-master.sql
```

The script refuses to run against the wrong database or as a non-superuser, and
prints `postgis_full_version()` on success. This is the only step that ever
needs the master credential — everything after it is ordinary DDL `fleet_app`
owns.

## Step 2 — apply the migration (normal deploy)

`prisma/migrations/20260808120000_postgis_geofence_geometry/` adds the derived
column, the trigger that maintains it, the backfill and a GiST index. It runs in
a transaction, touches only the 107-row `geofences` table, and aborts with a
readable message if step 1 was skipped.

It also refuses to apply if any fence with usable source geometry produced no
`geom`, rather than leaving the column half-populated for later queries to
silently under-report against.

Deploy the usual way — see `docs/ci-deploy.md`.

## Step 3 — build the telemetry index (once, by hand)

```bash
psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/postgis/01-telemetry-spatial-index.sql
```

Deliberately **not** a Prisma migration: `migrate deploy` wraps each migration in
a transaction, and `CREATE INDEX CONCURRENTLY` cannot run inside one. The
non-concurrent form would hold an ACCESS EXCLUSIVE lock on `vehicle_telemetries`
for the entire build while the poller is writing to it — an outage.

No column is added and no row is rewritten; the 758 MB heap is untouched. Budget
roughly 300–400 MB of additional index space on top of the 1118 MB already
there, and check free storage first.

If the build fails partway it leaves an **INVALID** index, which every query
silently ignores. The script reports `is_valid` at the end; if it is false:

```sql
DROP INDEX CONCURRENTLY "vehicle_telemetries_geog_idx";
```

then re-run.

## Step 4 — verify

```bash
psql "$DIRECT_URL" -f prisma/postgis/02-verify.sql
```

Read-only. Confirms every fence derived a valid shape, cross-checks measured
radius/width against the declared scalars, and runs `EXPLAIN ANALYZE` on a
history-against-boundary query to prove the index is used.

## Using it

The indexed expression must be written **exactly** as below at every call site
or the planner will not match it and will sequential-scan 4.85M rows:

```sql
ST_SetSRID(ST_MakePoint(t."lng", t."lat"), 4326)::geography
```

…but that only applies to **fleet-wide** questions ("which units crossed this
boundary"), which are the ones that need step 3. Per-unit backtracking does not
need step 3 at all — see below.

`geom` is `Unsupported(...)` in the Prisma schema, so it is never returned by
`findMany`/`findFirst`. Read it through `$queryRaw`.

### Backtracking one unit — no telemetry index required

This is the important case, and it inverts the usual advice: **filter by unit
and time first**, on the existing `(vehicle_id, captured_at)` B-tree, and only
then hand the surviving few thousand rows to PostGIS. The selective predicate is
the time window, not the geometry. `geofences_geom_idx` does the spatial work
from the other side.

Do **not** write it as a plain join against `geofences`. Measured on prod
2026-08-09: **every ping on the estate falls inside 16 zones at once** — the 67
CIRCLE zones all carry r=1000 m and blanket the site, and `FARM #215` alone
overlaps 84 other zones. A plain join reports a unit as simultaneously present
in sixteen places. Take the smallest enclosing zone, which is the rule
`lib/zone-presence.ts` already applies in memory:

```ts
const timeline = await prisma.$queryRaw<Array<{
  name: string; type: string; pings: bigint; first_seen: Date; last_seen: Date
}>>`
  WITH pings AS (
    SELECT t."captured_at",
           ST_SetSRID(ST_MakePoint(t."lng", t."lat"), 4326)::geography AS g
    FROM "vehicle_telemetries" t
    WHERE t."vehicle_id" = ${vehicleId}
      AND t."captured_at" >= ${since}
      AND t."lat" IS NOT NULL AND t."lng" IS NOT NULL
  )
  SELECT z."name", z."type", count(*) AS pings,
         min(p."captured_at") AS first_seen, max(p."captured_at") AS last_seen
  FROM pings p
  CROSS JOIN LATERAL (
    SELECT f."name", f."type"
    FROM "geofences" f
    WHERE ST_Intersects(f."geom", p.g)
    ORDER BY ST_Area(f."geom")
    LIMIT 1
  ) z
  GROUP BY z."name", z."type"
  ORDER BY count(*) DESC
`
```

Measured on prod, one unit over a 12 h window, 3,298 positioned fixes:
**327 ms**, no geography column, no telemetry spatial index. The planner
memoises the LATERAL on `(lng, lat)` — 3,200 cache hits against 98 real probes,
because a working unit reports the same coordinates over and over — and the
sixteen-way ambiguity collapses to a readable three-zone timeline.

Path length over the same window is the same shape and costs 250 ms:

```sql
SELECT round((ST_Length(ST_MakeLine(g)::geography) / 1000)::numeric, 2) AS path_km
FROM (
  SELECT ST_SetSRID(ST_MakePoint(t."lng", t."lat"), 4326) AS g
  FROM "vehicle_telemetries" t
  WHERE t."vehicle_id" = $1 AND t."captured_at" >= $2
    AND t."lat" IS NOT NULL AND t."lng" IS NOT NULL
  ORDER BY t."captured_at"
) pts;
```

Note that this measures the drawn path, not distance driven, and the two differ:
the unit above logged 3,299 fixes across 12 hours to travel 1.01 km inside an
8.3 ha box. Read it alongside the caveat in `lib/zone-taxonomy.ts` about
position freezing at speed 0.

### Two traps in the attribution query

Both were hit while building `findZoneTimeline`, and both produce output that
looks fine.

**Do not filter on `is_active`.** Only 8 of the 107 fences are active; the other
99 were bulk-imported from Wialon and never switched on. `lib/zone-presence.ts`
still reports them — it uses `isActive` solely to decide whether being inside
one is *enforced*, never whether the vehicle is inside it. Filtering here
returned a single "outside every fence" visit for a fortnight of movement, and
would have made a backtrack disagree with the live map about the same unit.

**Do not put `ST_Area` in the LATERAL's `ORDER BY`.** It recomputes a spheroid
area for every matching fence on every probe — rings here run to 872 vertices —
and cost 15.2 s where 3.9 s was available for identical output. Hoist it into a
`MATERIALIZED` CTE keyed by fence id and order by that; the GiST index still
drives candidate selection from the real table.

Planar `ST_Area(geom::geometry)` is the tempting shortcut, and it is worth being
precise about it rather than repeating a scare. Measured 2026-08-09: 62 of the
107 fences do rank differently under it — but **zero pairs whose areas differ by
more than 1% invert**. All the reshuffling is among the 67 identical-radius
circles, so it would not change which fence gets picked. The reason not to use
it is simply that it is *slower than the exact version* (4.4 s against 3.9 s)
while also being approximate: the `MATERIALIZED` CTE removes the cost that made
the shortcut tempting in the first place.

## Backtracking over long windows

`GET …/vehicles/:vehicleId/track` accepts windows up to 30 days and serves them
at two fidelities, reported as `resolution`:

| | |
|---|---|
| `full` (≤ 48 h, or no `from`) | Every fix, thinned by distance. Unchanged behaviour. |
| `sampled` (> 48 h) | One fix per time bucket, `sampleBucketSec` wide. `fixes` is `null` — this path never read them all and will not guess. |

Sampling is not a preference. A 30-day window on the busiest unit is 160,890
fixes and reading them exceeded 60 s before the statement was cancelled, because
those rows are scattered through an 807 MB heap that a 225 MB buffer cache
cannot hold. A bucketed `LEFT JOIN LATERAL … LIMIT 1` is an index range scan
that stops on its first row, so cost is O(buckets) and a month costs about what
a day costs.

Three details worth knowing before changing any of it:

- **Empty buckets are the gap evidence.** A bucket the unit sent nothing into is
  a real silence, and that is how `gapBefore` survives downsampling. The flag
  must be computed *before* empty buckets are filtered out — `WHERE` runs before
  window functions, so filtering in the same query level leaves `lag()` seeing
  only buckets that found a fix, and no gap is ever detected.
- **The window is clamped to what the unit actually reported.** Telemetry only
  begins 2026-07-26, so a 30-day request today spends half its budget probing
  prehistory. Two `min`/`max` index probes (11 ms) avoid hundreds of wasted ones
  — measured 19.9 s down to 5.7 s.
- **Both raw queries carry `SET LOCAL statement_timeout`.** After 2026-08-09
  nothing on a request path may be able to pin this instance; a timeout returns
  a degraded response rather than holding a connection.

### Testing the track SQL

The main suite mocks Prisma, so it never executes a statement — which is how
all three traps above reached prod verification unnoticed. Two files cover it
now, and they are complementary rather than redundant:

- `tests/unit/track-sql-shape.test.ts` — asserts the generated SQL's structure.
  Runs everywhere, no database. Catches the planar-area substitution, which the
  live test provably cannot see.
- `tests/integration/track-sql.db.test.ts` — executes the real queries against
  real PostGIS. Skipped unless `TEST_DATABASE_URL` is set. Catches the
  semantics: gap detection, inactive fences, smallest-enclosing, re-visits,
  tenancy.

Every assertion in both was verified by reintroducing the defect and watching it
fail; a guard that has never failed is not known to guard anything.

A scratch database exists for this on the app box — PostgreSQL 18 with PostGIS
3.6.4, local to the box and holding no real data:

```bash
ssh -i keys/logistics.pem -N -L 15433:127.0.0.1:5432 ubuntu@ec2-18-232-178-169.compute-1.amazonaws.com
```

```bash
TEST_DATABASE_URL="postgresql://fleet_test:tracktest_local_only@localhost:15433/fleet_test" npm run test:db
```

`npm run test:db:setup` rebuilds that database's schema from
`tests/helpers/track-test-schema.sql` plus the real geofence migration. **Never
point `TEST_DATABASE_URL` at anything real** — every test truncates both tables.

Measured on prod, busiest unit, full 30-day request: track 5.7 s, zone timeline
6.6 s. Those are cold-cache numbers and they are the reason the budgets in
`telemetry.repository.ts` are as low as they are. Applying
`prisma/postgis/03-track-covering-index.sql` is what lifts them — it turns the
random heap reads into an index-only scan — but read the warning in that file
first.

## What was deliberately not done

- **The live containment path was not moved.** `lib/zone-presence.ts` keeps
  evaluating every ping in memory against its cached zone list. PostGIS would
  add a round trip per ping to beat microseconds of arithmetic.
- **No geography column on `vehicle_telemetries`, and backtracking is not a
  reason to add one.** Reconfirmed 2026-08-09 when the question was asked
  directly. Adding the column is genuinely free — nullable with no default is a
  catalogue change in PG 11+, no rewrite. The cost is the *backfill*, and it is
  unavoidable: a column that is NULL for all history is useless to a feature
  whose entire subject is history. Backfilling means updating all 5.1M rows,
  which writes a dead tuple for every live one (the 807 MB heap roughly doubles
  before vacuum can catch up), adds ~165 MB of new column data, re-maintains
  three indexes, and pushes all of it through WAL — on the 1 GB instance that
  fell over earlier the same day doing something lighter — see the
  `maintenance_work_mem` note in `prisma/postgis/01-telemetry-spatial-index.sql`.
  Deriving the point on the fly costs 327 ms for a 12 h window and is
  measured above. Materialise only if a fleet-wide workload appears that the
  per-unit pattern cannot serve, and scale the instance first.
- **The extension is not declared in the Prisma datasource.** Turning on
  `postgresqlExtensions` would make Prisma attempt `CREATE EXTENSION` during
  migration, which `fleet_app` cannot do — the migration would fail every time.
