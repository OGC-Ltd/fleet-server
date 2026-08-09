-- ---------------------------------------------------------------------------
-- PostGIS bootstrap — run ONCE, as the RDS MASTER user (`postgres`).
-- ---------------------------------------------------------------------------
--
-- Why this file is separate from prisma/migrations:
--
--   The app role `fleet_app` OWNS the `fleet` database and has CREATE on both
--   the database and the `public` schema — but it is NOT a member of
--   `rds_superuser`, and on RDS that is what `CREATE EXTENSION postgis`
--   demands. Verified against prod (PostgreSQL 18.3) on 2026-08-08:
--
--       ERROR:  permission denied to create extension "postgis"
--       HINT:   Must be rds_superuser to create this extension.
--
--   `postgres` is the only role on the instance in `rds_superuser`. So the
--   extension has to be installed out of band, once, by that role. Everything
--   after this file — geometry columns, indexes, triggers — is ordinary DDL
--   that `fleet_app` can run, so it lives in a normal Prisma migration and
--   deploys the usual way. This script never needs to run again.
--
-- Run it with (from the dev machine, over the existing SSH tunnel):
--
--   psql "postgresql://postgres:<master-pw>@localhost:15432/fleet?sslmode=require" \
--        -v ON_ERROR_STOP=1 -f prisma/postgis/00-bootstrap-as-master.sql
--
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- Fail loudly rather than installing PostGIS into the wrong database.
DO $$
BEGIN
  IF current_database() <> 'fleet' THEN
    RAISE EXCEPTION 'Wrong database: expected "fleet", connected to "%"', current_database();
  END IF;
  IF NOT pg_has_role(current_user, 'rds_superuser', 'member') THEN
    RAISE EXCEPTION
      'Run this as the RDS master user. "%" is not in rds_superuser.', current_user;
  END IF;
END
$$;

-- Installed into `public` deliberately. Every application table already lives
-- there, so this keeps PostGIS on the default search_path and means neither
-- Prisma nor any raw query needs a schema qualifier or a search_path override.
CREATE EXTENSION IF NOT EXISTS postgis;

-- `spatial_ref_sys` ends up owned by the master user, not by fleet_app.
-- PostGIS grants SELECT to PUBLIC on it, but be explicit: without readable
-- SRID rows, every geography cast fails at runtime.
GRANT SELECT ON TABLE public.spatial_ref_sys TO fleet_app;

-- The metadata views the migration and any tooling introspect.
GRANT SELECT ON TABLE public.geometry_columns  TO fleet_app;
GRANT SELECT ON TABLE public.geography_columns TO fleet_app;

-- Confirm, so the operator running this sees the result rather than assuming it.
SELECT
  postgis_full_version()                                   AS postgis,
  has_table_privilege('fleet_app','public.spatial_ref_sys','SELECT') AS fleet_app_can_read_srids;
