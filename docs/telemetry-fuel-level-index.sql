-- Builds vehicle_telemetries_fuel_level_idx on production without holding
-- ingest. Run with psql in autocommit mode (NOT -1, NOT inside BEGIN):
--
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f docs/telemetry-fuel-level-index.sql
--
-- then mark the migration applied:
--
--   npx prisma migrate resolve --applied 20261128120000_telemetry_fuel_level_partial_index
--
-- Safe to run again after a failure: every step skips what already exists.
-- Runbook and what to watch: docs/telemetry-fuel-level-index.md.

SET maintenance_work_mem = '1GB';
SET statement_timeout = 0;

-- STEP 1
CREATE INDEX IF NOT EXISTS vehicle_telemetries_fuel_level_idx ON ONLY vehicle_telemetries (vehicle_id, captured_at) WHERE fuel_level_ml >= 1000;

-- STEP 2: each partition's own index, built CONCURRENTLY (inserts carry on).
-- The legacy partition is the long one; the monthly ones take seconds.
SELECT format('CREATE INDEX CONCURRENTLY IF NOT EXISTS %I ON %I (vehicle_id, captured_at) WHERE fuel_level_ml >= 1000',
              c.relname || '_fuel_level_idx', c.relname)
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
 WHERE i.inhparent = 'vehicle_telemetries'::regclass
 ORDER BY c.relname
\gexec

-- STEP 3: hang each one under the parent's index. Once every partition has
-- one attached, Postgres marks the parent's index valid by itself.
SELECT format('ALTER INDEX vehicle_telemetries_fuel_level_idx ATTACH PARTITION %I', c.relname || '_fuel_level_idx')
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
 WHERE i.inhparent = 'vehicle_telemetries'::regclass
   AND NOT EXISTS (SELECT 1 FROM pg_inherits ii
                    WHERE ii.inhparent = 'vehicle_telemetries_fuel_level_idx'::regclass
                      AND ii.inhrelid = to_regclass(c.relname || '_fuel_level_idx'))
 ORDER BY c.relname
\gexec

-- STEP 4: check. Expect valid = t, and one row per partition, each valid.
SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'vehicle_telemetries_fuel_level_idx'::regclass;
SELECT x.indexrelid::regclass AS index, x.indisvalid AS valid, pg_size_pretty(pg_relation_size(x.indexrelid)) AS size
  FROM pg_inherits i JOIN pg_index x ON x.indexrelid = i.inhrelid
 WHERE i.inhparent = 'vehicle_telemetries_fuel_level_idx'::regclass
 ORDER BY 1;
