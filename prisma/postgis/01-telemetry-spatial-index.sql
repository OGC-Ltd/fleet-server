-- ---------------------------------------------------------------------------
-- Spatial index over telemetry history. Run ONCE, by hand, as `fleet_app`.
-- ---------------------------------------------------------------------------
--
-- Deliberately NOT a Prisma migration. `prisma migrate deploy` runs each
-- migration inside a transaction, and CREATE INDEX CONCURRENTLY cannot run in
-- one. The non-concurrent form would take an ACCESS EXCLUSIVE lock on
-- vehicle_telemetries for the whole build — a 758 MB heap, 4.85M rows — while
-- the poller is writing to it every few seconds. That is an outage.
--
-- CONCURRENTLY makes two passes and never blocks writers. It costs more wall
-- clock and it CANNOT be rolled back cleanly: if it fails partway it leaves an
-- INVALID index behind, which must be dropped before retrying. Both checks are
-- at the bottom of this file.
--
-- No column is added and no row is rewritten. The table keeps its existing
-- heap; this is purely additive index space. Measured on 2026-08-09: the
-- cancelled build had already written 392 MB before it was stopped, so budget
-- ~400 MB on top of the 1181 MB of indexes already there, against a 5932 MB
-- database — check free storage first.
--
-- Run it in a QUIET WINDOW, and watch the app while it runs. See the note on
-- maintenance_work_mem below: this instance is small enough that the build
-- competes with the poller for memory and IO, and on 2026-08-09 it won.
--
-- Run with (over the dev SSH tunnel), NOT inside a transaction:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/postgis/01-telemetry-spatial-index.sql
--
-- The dev tunnel is the weak link in that command: if it drops, the build dies
-- and leaves an INVALID index. Running it from the app box (which has psql and
-- sits next to the database) avoids that.
--
-- ---------------------------------------------------------------------------

-- DO NOT raise maintenance_work_mem here. An earlier revision of this file set
-- it to '256MB' on the theory that it "speeds the build up materially". That is
-- true on a normally-sized instance and false — destructively so — on this one.
--
-- Measured against prod on 2026-08-09: shared_buffers 225 MB,
-- effective_cache_size 451 MB, max_connections 79. RDS derives all three from
-- instance memory, and those numbers put `fleet-store` at roughly 1 GB of RAM
-- (a t4g/t3 micro) holding a 5.9 GB database. Handing one maintenance operation
-- 256 MB on top of a 225 MB buffer cache leaves the instance nothing.
--
-- What happened: the GiST build ran for ~12 minutes, the instance went to its
-- knees, every backend piled up on wait_event_type = IO, new connections stopped
-- completing at all (both from the app box and over the dev tunnel), and
-- /api/v1/bootstrap went from milliseconds to 8.7 s and then to outright
-- timeouts. The build was cancelled and its 392 MB INVALID index dropped.
--
-- The 64 MB default is what this instance can actually absorb. The build takes
-- longer. That is the correct trade here: CONCURRENTLY never blocks writers, so
-- a slow build is invisible, whereas a build that starves the box is an outage.
-- Raise this only after the instance is scaled up, and lower it back after.

-- The indexed expression must be written EXACTLY like this at every call site,
-- or the planner will not match it and will seq-scan 4.85M rows instead. It is
-- geography, not geometry, to match geofences.geom so comparisons need no cast:
--
--   WHERE ST_Intersects(g.geom, ST_SetSRID(ST_MakePoint(t.lng, t.lat), 4326)::geography)
--
-- lat/lng are nullable in the Prisma model, though 0 of 4.85M rows are actually
-- null today. Null coordinates simply produce no index entry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "vehicle_telemetries_geog_idx"
  ON public."vehicle_telemetries"
  USING gist ((ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)::geography));

-- The planner will not use a new index until the table has fresh stats on the
-- expression.
ANALYZE public."vehicle_telemetries";

-- ---------------------------------------------------------------------------
-- Verify. A CONCURRENTLY build that failed leaves the index present but
-- INVALID, and an invalid index is silently ignored by every query — so
-- "the index exists" is not the check that matters.
-- ---------------------------------------------------------------------------
SELECT
  c.relname                                        AS index_name,
  i.indisvalid                                     AS is_valid,
  pg_size_pretty(pg_relation_size(c.oid))          AS size
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = 'vehicle_telemetries_geog_idx';

-- If is_valid came back false, the build failed. Drop it and re-run this file:
--
--   DROP INDEX CONCURRENTLY "vehicle_telemetries_geog_idx";
