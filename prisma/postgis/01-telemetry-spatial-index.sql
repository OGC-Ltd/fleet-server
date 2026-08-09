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
-- 758 MB heap; this is purely additive index space (expect roughly 300-400 MB
-- on top of the 1118 MB of indexes already there — check free storage first).
--
-- Run with (over the dev SSH tunnel), NOT inside a transaction:
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/postgis/01-telemetry-spatial-index.sql
--
-- ---------------------------------------------------------------------------

-- Speeds the build up materially; USERSET, so this needs no extra privilege and
-- lasts only for this session.
SET maintenance_work_mem = '256MB';

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
