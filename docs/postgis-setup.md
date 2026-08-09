# PostGIS on the fleet database

Status as of 2026-08-08: **prepared, not yet applied.** Step 1 below needs the
RDS master credential, which is not on the box and not in this repo.

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

## Step 1 — install the extension (RDS master user, once)

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

`geom` is `Unsupported(...)` in the Prisma schema, so it is never returned by
`findMany`/`findFirst`. Read it through `$queryRaw`:

```ts
const rows = await prisma.$queryRaw<Array<{ name: string; pings: bigint }>>`
  SELECT g."name", count(*) AS pings
  FROM "vehicle_telemetries" t
  JOIN "geofences" g
    ON ST_Intersects(g."geom", ST_SetSRID(ST_MakePoint(t."lng", t."lat"), 4326)::geography)
  WHERE t."vehicle_id" = ${vehicleId}
    AND t."captured_at" >= ${since}
  GROUP BY g."name"
  ORDER BY count(*) DESC
`
```

## What was deliberately not done

- **The live containment path was not moved.** `lib/zone-presence.ts` keeps
  evaluating every ping in memory against its cached zone list. PostGIS would
  add a round trip per ping to beat microseconds of arithmetic.
- **No geography column on `vehicle_telemetries`.** That would rewrite a 1876 MB
  table. The expression index gets the same query plans without the rewrite; add
  a real column only if a workload actually needs one.
- **The extension is not declared in the Prisma datasource.** Turning on
  `postgresqlExtensions` would make Prisma attempt `CREATE EXTENSION` during
  migration, which `fleet_app` cannot do — the migration would fail every time.
