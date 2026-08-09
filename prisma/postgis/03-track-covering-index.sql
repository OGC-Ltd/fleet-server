-- ---------------------------------------------------------------------------
-- Full-fidelity long-window tracks. PREPARED, NOT APPLIED.
-- ---------------------------------------------------------------------------
--
-- This is the index that would let a 30-day backtrack return every fix instead
-- of one per bucket. It is written down because the measurements that justify
-- it are perishable, not because it should be run today — see the WARNING at
-- the bottom, which is not boilerplate.
--
-- ## What is actually slow
--
-- Nothing about the query is wrong. `vehicle_telemetries_vehicle_id_captured_at_idx`
-- is matched, the range is exact, and no extra rows are examined. Measured
-- against prod 2026-08-09, one unit:
--
--     window   fixes      time
--      12 h     3,073      331 ms
--      24 h     6,855      513 ms
--      48 h    17,804    9,221 ms
--      30 d   160,890    >60 s, cancelled
--
-- That is not a curve that a faster CPU fixes. The index gives the planner a
-- sorted list of row pointers; fetching lat/lng then costs one heap access per
-- row, and one unit's pings are scattered through an 807 MB heap interleaved
-- with 330 other units reporting on the same cadence. With 225 MB of
-- shared_buffers, past roughly 20k rows nearly every fetch is a cache miss and
-- the query degenerates into random IO. The 48 h row above is the cliff.
--
-- ## Why a covering index fixes it and a plain one does not
--
-- INCLUDE puts lat/lng/engine_on/speed_kmh in the index leaves. The planner can
-- then answer the whole track from the index alone — an index-only scan over a
-- contiguous range, sequential, no heap access at all. The random IO does not
-- get faster; it stops happening.
--
-- `vehicle_telemetries` is insert-only, which is the condition index-only scans
-- need: autovacuum marks pages all-visible and they stay that way, so the
-- visibility-map check that would otherwise send the scan back to the heap
-- almost always passes. A table with churn would not benefit nearly as much.
--
-- Once this exists, `TRACK_FULL_FIDELITY_HOURS` in telemetry.schema.ts can rise
-- from 48 to 720 and the bucketed path in telemetry.service.ts becomes a
-- fallback rather than the normal route for long windows. Raise it only after
-- re-measuring the table above — not on the strength of this comment.
--
-- ## Cost
--
-- Roughly 45-55 bytes per row over 5.1M rows: budget 300-400 MB on top of the
-- 1181 MB of indexes already on this table, and check free storage first. It is
-- additive — no column is added and no row is rewritten.
--
-- ---------------------------------------------------------------------------
-- WARNING — do not run this on the current instance
-- ---------------------------------------------------------------------------
--
-- On 2026-08-09 a comparable CONCURRENTLY build on this exact table took prod
-- down: ~12 minutes in, every backend was stacked on wait_event_type = IO, new
-- connections stopped completing from both the app box and the dev tunnel, and
-- /api/v1/bootstrap went from ~1 ms to timing out. It was cancelled and its
-- 392 MB INVALID index dropped. Full account in docs/postgis-setup.md.
--
-- The cause was instance size — `fleet-store` has roughly 1 GB of RAM for a
-- 5932 MB database. THAT HAS NOT CHANGED. Scale the instance first, run this in
-- a quiet window, from the app box rather than over the dev SSH tunnel (a
-- dropped tunnel kills the build), and watch /api/v1/bootstrap while it runs.
--
-- Deliberately NOT a Prisma migration: `migrate deploy` wraps each migration in
-- a transaction and CREATE INDEX CONCURRENTLY cannot run inside one. The
-- non-concurrent form would hold ACCESS EXCLUSIVE on the table for the whole
-- build while the poller writes to it, which is an outage by construction.
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f prisma/postgis/03-track-covering-index.sql
--
-- ---------------------------------------------------------------------------

-- Left at the instance default deliberately. Raising maintenance_work_mem is
-- what turned the 2026-08-09 build into an outage; see the note in
-- 01-telemetry-spatial-index.sql before touching it.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "vehicle_telemetries_track_covering_idx"
  ON public."vehicle_telemetries" ("vehicle_id", "captured_at")
  INCLUDE ("lat", "lng", "engine_on", "speed_kmh");

ANALYZE public."vehicle_telemetries";

-- A cancelled CONCURRENTLY build leaves the index present but INVALID, and an
-- invalid index is silently ignored by every query while still being maintained
-- by every INSERT — the worst of both. "It exists" is not the check that
-- matters; is_valid is.
SELECT
  c.relname                               AS index_name,
  i.indisvalid                            AS is_valid,
  pg_size_pretty(pg_relation_size(c.oid)) AS size
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = 'vehicle_telemetries_track_covering_idx';

-- If is_valid came back false:
--
--   DROP INDEX CONCURRENTLY "vehicle_telemetries_track_covering_idx";
--
-- then re-run this file.
