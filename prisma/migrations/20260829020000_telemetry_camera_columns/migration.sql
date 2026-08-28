-- On-board camera / MDVR state, per fix.
--
-- ## Why these are nullable and why that is not a defect
--
-- One unit of 1,496 in this Wialon account reports a recorder at all:
-- `VS Menengai CAMERA - KCS 078M` (Wialon id 28628615), measured 2026-08-29.
-- So every column here is NULL on essentially every row, forever, until camera
-- hardware is fitted more widely. That is the honest shape of the data — a
-- default of false would assert "checked, no camera" for 1,495 units where the
-- question never arose.
--
-- ## Why per-fix rather than on `vehicles`
--
-- All four change over time. A recorder loses video signal, fills its disk, or
-- has its stream URL expire, and the fleet snapshot already reads the latest
-- fix for exactly this kind of state (the LATERAL join in
-- telemetry.repository). Putting capability on `vehicles` would also mean
-- writing to that table on every ping, which is the write amplification the
-- telemetry table exists to avoid.
--
-- ## Wired at the same time, deliberately
--
-- `ignition_known` / `ignition_source` were added and backfilled on 2026-08-26
-- and NOT wired into ingest, which left a seven-day island of history followed
-- by nulls — see the note at ingestTelemetry. These columns are written by
-- ingest in the same change that creates them, so no such island can form.
--
-- No backfill: there is nothing to backfill from. The provider has never sent
-- a `video_uri` (0 of 1,707 messages over seven days), and the recorder
-- diagnostics were discarded rather than stored before now.

ALTER TABLE "vehicle_telemetries"
  ADD COLUMN "camera_fitted"      BOOLEAN,
  ADD COLUMN "camera_stream_url"  TEXT,
  ADD COLUMN "camera_recording"   BOOLEAN,
  ADD COLUMN "camera_signal_lost" BOOLEAN;

-- NO INDEX, deliberately, and this is the whole reason to read this file.
--
-- The obvious partial index -- (vehicle_id, captured_at DESC) WHERE
-- camera_fitted -- was written and then removed after measuring the table:
--
--   rows        11,976,597
--   total size  4,904 MB   (2,897 MB of it already indexes)
--
-- A partial index still requires a FULL HEAP SCAN to discover which rows match
-- its predicate, and a plain CREATE INDEX holds a SHARE lock that blocks every
-- INSERT for the duration. The telemetry poller writes continuously, so that
-- lock is dropped telemetry -- paid to build an index that matches ZERO rows,
-- because no unit reports a camera yet.
--
-- Add it when there is something to index, and add it with CREATE INDEX
-- CONCURRENTLY, outside a migration (Prisma wraps migrations in a transaction
-- and CONCURRENTLY cannot run inside one):
--
--   CREATE INDEX CONCURRENTLY vehicle_telemetries_camera_idx
--     ON vehicle_telemetries (vehicle_id, captured_at DESC)
--     WHERE camera_fitted;
--
-- Until then every camera query is for a single known vehicle over a bounded
-- window, which the existing (vehicle_id, captured_at) index already serves.
--
-- The ALTER above is safe on a table this size: PostgreSQL 11+ adds a NULLABLE
-- column with no DEFAULT as a catalogue change only, with no table rewrite.
-- This database is PostgreSQL 18.3.
