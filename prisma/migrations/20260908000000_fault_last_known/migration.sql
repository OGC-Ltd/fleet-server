-- Where the sensor was last working, and what the unit was doing there.
--
-- A fault episode said WHEN a sensor stopped and never WHERE. For the fault
-- that dominates this ledger — a tracker gone silent — "where was it when it
-- last spoke" is the question that decides whether anyone drives out to it,
-- and it was unanswerable from the row: the position lives in
-- vehicle_telemetries, which is swept at 30 days, so by the time a stale
-- episode is read the fix behind it is usually gone.
--
-- So the position is COPIED onto the episode when it opens, the same reasoning
-- speeding_incidents already applies to limit_kmh: a fact about the moment
-- belongs on the row describing that moment, not re-derived later from data
-- that may no longer exist.
--
-- `last_moving` is stored rather than computed from `last_speed_kmh` at read
-- time for the same reason. The moving threshold is a policy constant
-- (MOVING_THRESHOLD_KMH), and re-reading it later would silently restate
-- history the day somebody changes it.
--
-- `last_fix_at` is WHEN that fix was taken, and it is not the same instant as
-- `started_at`. For a silent tracker they coincide — the fault began when the
-- last message did. For a channel death they do not: the odometer stopped at
-- `started_at`, and the newest position at or before that moment may be
-- minutes older. The table showed where the sensor last worked and had no
-- column for when, which left the coordinates unanchored.
--
-- `last_place` is the reverse-geocoded label, filled asynchronously after the
-- row lands: Nominatim's usage policy caps us at roughly one request every
-- 1.1s, so resolving it inline would put a rate limiter in the path of fault
-- capture. Null means "not resolved yet or not resolvable", never "nowhere".
--
-- All five are nullable with no default, so this is a catalogue-only change on
-- PostgreSQL 11+ — no table rewrite, no lock worth measuring, whatever the
-- table has grown to.
ALTER TABLE "sensor_fault_episodes"
  ADD COLUMN "last_fix_at"    TIMESTAMP(3),
  ADD COLUMN "last_lat"       DOUBLE PRECISION,
  ADD COLUMN "last_lng"       DOUBLE PRECISION,
  ADD COLUMN "last_speed_kmh" DOUBLE PRECISION,
  ADD COLUMN "last_moving"    BOOLEAN,
  ADD COLUMN "last_place"     TEXT;
