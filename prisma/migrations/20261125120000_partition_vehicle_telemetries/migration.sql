-- vehicle_telemetries becomes a table partitioned by RANGE (captured_at), one
-- partition per UTC month. The existing table is NOT copied: it is renamed to
-- vehicle_telemetries_legacy and attached as the partition for everything
-- before the cut-over, so the change takes seconds however large it is.
--
-- Why: on 24 Nov 2026 an hour of new fixes sat on 41,965 pages instead of
-- ~1,900, because Postgres put them into holes that rewrites had left in old
-- pages, and every "today" query read 25x the pages it needed. #149 stopped the
-- rewrites; partitioning makes it structural. New rows can only land in the
-- current partition, which nothing ever rewrites or deletes from, so the state
-- of old data can no longer slow today's queries. Old partitions are vacuumed
-- and frozen once and then left alone.
--
-- Why monthly, not daily: about ten queries ask for a vehicle's newest fix
-- with no lower bound on captured_at (the fleet snapshot and its last-moved
-- lookup, work plans, movement events, odometer-at, probe report). Postgres
-- answers those by probing partitions newest first, and a vehicle that has not
-- moved walks every partition. 12 a year keeps that cheap; 365 would not.
--
-- Why not pg_partman: monthly ranges need one CREATE TABLE a month, done by
-- vehicle_telemetries_ensure_partitions() below, called here and nightly by the
-- app (lib/telemetry-partitions.ts). The same SQL then works on databases that
-- do not have the extension, and nothing is installed on RDS.
--
-- Nothing is ever dropped. There is no retention here, on purpose: the old
-- fixes are kept (operator, 2026-10-12).
--
-- ON PRODUCTION THIS IS NOT RUN BY `prisma migrate deploy` COLD. Two steps must
-- come first, out of band, because they read the whole 20 GB heap and must not
-- do so under a lock: a unique index on (id, captured_at) built CONCURRENTLY,
-- and the legacy CHECK added NOT VALID and then validated. The block below
-- REFUSES to run on a table over a million rows without them, rather than
-- build them while holding ingest. Runbook: docs/telemetry-partitioning.md.
-- On an empty or small database (a new environment) it does everything inline.
--
-- Re-running is a no-op: the block returns at once if the table is already
-- partitioned.

SET lock_timeout = '5s';

-- ─── partition upkeep ──────────────────────────────────────────────────────
--
-- Makes sure there is a partition for every month from the newest existing one
-- up to `months_ahead` months past the current one, and returns the names it
-- created. Each new partition is built detached, given any rows the DEFAULT
-- partition holds for its range, and then attached, so a fix that arrived with
-- a far-future clock is moved to where it belongs rather than blocking the
-- attach.
--
-- The first partition after the legacy one may start mid-month (the cut-over
-- instant); every one after it starts on the 1st. Names are by start month:
-- vehicle_telemetries_pYYYYMM.
CREATE OR REPLACE FUNCTION vehicle_telemetries_ensure_partitions(months_ahead int DEFAULT 3)
RETURNS text[]
LANGUAGE plpgsql
AS $fn$
DECLARE
  upper_bound timestamp;
  next_bound  timestamp;
  target      timestamp := date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => months_ahead + 1);
  part        text;
  created     text[] := '{}';
  has_default boolean;
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.vehicle_telemetries'::regclass) <> 'p' THEN
    RAISE EXCEPTION 'vehicle_telemetries is not partitioned';
  END IF;

  -- Upper bound of the newest ranged partition. The DEFAULT partition's bound
  -- has no TO and drops out as NULL.
  SELECT max((regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamp)
    INTO upper_bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
   WHERE i.inhparent = 'public.vehicle_telemetries'::regclass;

  IF upper_bound IS NULL THEN
    RAISE EXCEPTION 'vehicle_telemetries has no ranged partition to extend from';
  END IF;

  has_default := to_regclass('public.vehicle_telemetries_default') IS NOT NULL;

  WHILE upper_bound < target LOOP
    next_bound := date_trunc('month', upper_bound) + interval '1 month';
    part       := 'vehicle_telemetries_p' || to_char(upper_bound, 'YYYYMM');

    -- Append-only, so the default fillfactor (100) and an insert-driven vacuum
    -- every ~45k rows, which keeps the visibility map current for the
    -- index-only scans that read today.
    EXECUTE format(
      'CREATE TABLE %I (LIKE vehicle_telemetries INCLUDING DEFAULTS)
         WITH (autovacuum_vacuum_insert_scale_factor = 0, autovacuum_vacuum_insert_threshold = 45000)',
      part);

    IF has_default THEN
      EXECUTE format(
        'WITH moved AS (DELETE FROM vehicle_telemetries_default
                         WHERE captured_at >= %L AND captured_at < %L RETURNING *)
         INSERT INTO %I SELECT * FROM moved',
        upper_bound, next_bound, part);
    END IF;

    EXECUTE format(
      'ALTER TABLE vehicle_telemetries ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
      part, upper_bound, next_bound);

    created     := created || part;
    upper_bound := next_bound;
  END LOOP;

  RETURN created;
END
$fn$;

-- ─── the cut-over ──────────────────────────────────────────────────────────

DO $cutover$
DECLARE
  boundary  timestamp;
  validated boolean;
  big       boolean := (SELECT reltuples FROM pg_class WHERE oid = 'public.vehicle_telemetries'::regclass) > 1000000;
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid = 'public.vehicle_telemetries'::regclass) = 'p' THEN
    RAISE NOTICE 'vehicle_telemetries is already partitioned; nothing to do';
    RETURN;
  END IF;

  -- 1. The key a partitioned table's primary key must have: it has to include
  --    the partition column.
  IF to_regclass('public.vehicle_telemetries_id_captured_at_key') IS NULL THEN
    IF big THEN
      RAISE EXCEPTION 'vehicle_telemetries is large: build vehicle_telemetries_id_captured_at_key CONCURRENTLY first (docs/telemetry-partitioning.md, step 1)';
    END IF;
    CREATE UNIQUE INDEX vehicle_telemetries_id_captured_at_key ON vehicle_telemetries (id, captured_at);
  END IF;

  -- 2. Where the legacy partition ends. Read from the CHECK the runbook built,
  --    so the attach can trust it instead of scanning; on a small database,
  --    the start of next month.
  SELECT (regexp_match(pg_get_constraintdef(oid), '''([^'']+)'''))[1]::timestamp, convalidated
    INTO boundary, validated
    FROM pg_constraint
   WHERE conrelid = 'public.vehicle_telemetries'::regclass
     AND conname  = 'vehicle_telemetries_legacy_range';

  IF boundary IS NULL THEN
    IF big THEN
      RAISE EXCEPTION 'vehicle_telemetries is large: add and validate vehicle_telemetries_legacy_range first (docs/telemetry-partitioning.md, step 2)';
    END IF;
    boundary := date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month';
    EXECUTE format('ALTER TABLE vehicle_telemetries ADD CONSTRAINT vehicle_telemetries_legacy_range CHECK (captured_at < %L)', boundary);
  ELSIF NOT validated THEN
    RAISE EXCEPTION 'vehicle_telemetries_legacy_range is NOT VALID: run ALTER TABLE vehicle_telemetries VALIDATE CONSTRAINT vehicle_telemetries_legacy_range first';
  END IF;

  IF boundary <= now() AT TIME ZONE 'UTC' THEN
    -- The CHECK has been refusing every fix stamped after it since then.
    RAISE WARNING 'legacy boundary % is already past: fixes after it were rejected until now', boundary;
  END IF;

  -- 3. The old table becomes the legacy partition. Its index names move out of
  --    the way of the parent's, which keep the names Prisma knows.
  ALTER TABLE vehicle_telemetries RENAME TO vehicle_telemetries_legacy;
  ALTER TABLE vehicle_telemetries_legacy DROP CONSTRAINT vehicle_telemetries_pkey;
  ALTER TABLE vehicle_telemetries_legacy
    ADD CONSTRAINT vehicle_telemetries_legacy_pkey PRIMARY KEY USING INDEX vehicle_telemetries_id_captured_at_key;
  ALTER INDEX vehicle_telemetries_device_id_captured_at_key  RENAME TO vehicle_telemetries_legacy_device_id_captured_at_key;
  ALTER INDEX vehicle_telemetries_vehicle_id_captured_at_idx RENAME TO vehicle_telemetries_legacy_vehicle_id_captured_at_idx;
  ALTER INDEX vehicle_telemetries_captured_at_idx            RENAME TO vehicle_telemetries_legacy_captured_at_idx;
  ALTER INDEX IF EXISTS vehicle_telemetries_moving_idx       RENAME TO vehicle_telemetries_legacy_moving_idx;

  -- 4. The partitioned parent: same columns, defaults and keys. Created empty,
  --    so its indexes are instant; on attach Postgres adopts the legacy
  --    table's matching indexes and foreign key instead of building them.
  CREATE TABLE vehicle_telemetries (
    LIKE vehicle_telemetries_legacy INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING STORAGE INCLUDING COMMENTS
  ) PARTITION BY RANGE (captured_at);

  ALTER SEQUENCE vehicle_telemetry_id_seq OWNED BY vehicle_telemetries.id;

  ALTER TABLE vehicle_telemetries ADD CONSTRAINT vehicle_telemetries_pkey PRIMARY KEY (id, captured_at);
  CREATE UNIQUE INDEX vehicle_telemetries_device_id_captured_at_key  ON vehicle_telemetries (device_id, captured_at);
  CREATE INDEX        vehicle_telemetries_vehicle_id_captured_at_idx ON vehicle_telemetries (vehicle_id, captured_at);
  CREATE INDEX        vehicle_telemetries_captured_at_idx            ON vehicle_telemetries (captured_at);
  -- The partial index from 20260801000000_telemetry_moving_partial_index.
  CREATE INDEX        vehicle_telemetries_moving_idx                 ON vehicle_telemetries (vehicle_id, captured_at DESC)
    WHERE speed_kmh > 0;
  ALTER TABLE vehicle_telemetries ADD CONSTRAINT vehicle_telemetries_vehicle_id_fkey
    FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON UPDATE CASCADE ON DELETE RESTRICT;

  EXECUTE format(
    'ALTER TABLE vehicle_telemetries ATTACH PARTITION vehicle_telemetries_legacy FOR VALUES FROM (MINVALUE) TO (%L)',
    boundary);

  -- The partition bound now says the same thing.
  ALTER TABLE vehicle_telemetries_legacy DROP CONSTRAINT vehicle_telemetries_legacy_range;

  -- 5. The months ahead, then a DEFAULT partition so a fix with a wildly wrong
  --    clock is kept rather than refused. The app alerts when it holds rows.
  PERFORM vehicle_telemetries_ensure_partitions(3);

  CREATE TABLE vehicle_telemetries_default PARTITION OF vehicle_telemetries DEFAULT
    WITH (autovacuum_vacuum_insert_scale_factor = 0, autovacuum_vacuum_insert_threshold = 45000);
END
$cutover$;
