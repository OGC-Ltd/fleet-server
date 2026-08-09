-- ---------------------------------------------------------------------------
-- Minimal schema for the track SQL integration tests. Applied to a scratch
-- PostGIS database, never to a real one.
-- ---------------------------------------------------------------------------
--
-- Only the two tables the track queries touch, with column types copied from
-- prod on 2026-08-09 rather than guessed. `captured_at` in particular is
-- `timestamp WITHOUT time zone` while the queries bucket with `timestamptz`,
-- so the comparison goes through an implicit coercion — a fixture that used
-- timestamptz would quietly not exercise the thing being tested.
--
-- The geom column, its derivation function and its trigger are NOT redefined
-- here: the real migration is applied on top of this file, so the tests run
-- against the same derivation prod uses.

CREATE TYPE "GeofenceType" AS ENUM ('CIRCLE', 'POLYGON', 'LINE');
CREATE TYPE "FenceMode"    AS ENUM ('ALLOWLIST', 'BLOCKLIST');

CREATE TABLE "geofences" (
  "id"              text PRIMARY KEY,
  "organisation_id" text NOT NULL,
  "name"            text NOT NULL,
  "type"            "GeofenceType" NOT NULL,
  "mode"            "FenceMode" NOT NULL DEFAULT 'ALLOWLIST',
  "center_lat"      double precision,
  "center_lng"      double precision,
  "radius_m"        integer,
  "polygon_coords"  jsonb,
  "width_m"         double precision,
  "is_active"       boolean NOT NULL DEFAULT true
);

CREATE TABLE "vehicle_telemetries" (
  "id"          bigserial PRIMARY KEY,
  "vehicle_id"  text NOT NULL,
  "captured_at" timestamp(3) without time zone NOT NULL,
  "lat"         double precision,
  "lng"         double precision,
  "engine_on"   boolean NOT NULL DEFAULT false,
  "speed_kmh"   double precision
);

-- The index the whole long-window design leans on.
CREATE INDEX "vehicle_telemetries_vehicle_id_captured_at_idx"
  ON "vehicle_telemetries" ("vehicle_id", "captured_at");
