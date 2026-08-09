-- Give the 107 zones a real spatial representation.
--
-- Until now a geofence has been three loosely-related columns — a centre and a
-- radius, or a `polygon_coords` blob of untyped Jsonb — and the only thing that
-- could interpret them was lib/geofence.ts. That is fine for the live path,
-- which stays exactly as it is (see lib/zone-presence.ts on why containment is
-- evaluated in memory per ping). It is useless for anything set-based: there is
-- currently no way to ask the database which of 4.85M telemetry rows fell
-- inside FARM #212 last week, and no way to check that a 872-vertex ring is
-- even a valid polygon.
--
-- So `geom` is DERIVED, not authoritative. The existing columns remain the
-- source of truth and no application write path changes; a trigger keeps geom
-- in step with them. Nothing that works today can break because of this column.
--
-- Requires the extension, which the app role cannot install itself — see
-- prisma/postgis/00-bootstrap-as-master.sql.

-- ---------------------------------------------------------------------------
-- Guard: fail with an instruction, not with 40 lines of "type geography does
-- not exist" further down.
-- ---------------------------------------------------------------------------
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    RAISE EXCEPTION
      'PostGIS is not installed on this database. It needs the RDS master user: psql "$DIRECT_URL_AS_postgres" -f prisma/postgis/00-bootstrap-as-master.sql';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Derivation
-- ---------------------------------------------------------------------------

/*
 * One fence row -> one geography, mirroring lib/geofence.ts exactly:
 *
 *   CIRCLE  inside when haversine(point, centre) <= radius_m
 *             -> the centre buffered by radius_m
 *   POLYGON inside when ray-casting says the ring contains the point
 *             -> the ring itself
 *   LINE    inside when distance to the centre-line <= width_m / 2
 *             -> the centre-line buffered by width_m / 2
 *
 * Buffering on `geography` rather than `geometry` is the point of the exercise:
 * it measures in metres on the spheroid, where lib/geofence.ts approximates
 * with a cos(lat) scaling that it openly documents as planar. At this latitude
 * (~4S) the two agree closely, which is why the JS is fine for the live path —
 * but the corridors here are only 2-10 m wide, so anything comparing history
 * against a boundary wants the exact one.
 *
 * STABLE, not IMMUTABLE: ST_Buffer on geography consults spatial_ref_sys. That
 * is also why `geom` is a trigger-maintained column and not GENERATED ALWAYS —
 * Postgres requires a generated expression to be immutable, and this is not.
 */
CREATE OR REPLACE FUNCTION public.geofence_geog(
  p_type           "GeofenceType",
  p_polygon_coords jsonb,
  p_center_lat     double precision,
  p_center_lng     double precision,
  p_radius_m       integer,
  p_width_m        double precision
) RETURNS geography
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_ring jsonb;
  v_geom geometry;
BEGIN
  -- CIRCLE carries no ring at all: all 67 rows store Jsonb `null` in
  -- polygon_coords and describe themselves entirely with centre + radius.
  IF p_type = 'CIRCLE' THEN
    IF p_center_lat IS NULL OR p_center_lng IS NULL OR COALESCE(p_radius_m, 0) <= 0 THEN
      RETURN NULL;
    END IF;
    RETURN ST_Buffer(
      ST_SetSRID(ST_MakePoint(p_center_lng, p_center_lat), 4326)::geography,
      p_radius_m
    );
  END IF;

  -- POLYGON and LINE both read polygon_coords as [[lng,lat], ...].
  IF p_polygon_coords IS NULL
     OR jsonb_typeof(p_polygon_coords) <> 'array'
     OR jsonb_array_length(p_polygon_coords) = 0
  THEN
    RETURN NULL;
  END IF;

  IF p_type = 'LINE' THEN
    IF COALESCE(p_width_m, 0) <= 0 THEN
      RETURN NULL;
    END IF;

    IF jsonb_array_length(p_polygon_coords) = 1 THEN
      -- Degenerate centre-line. isInsideCorridor() falls back to a plain radius
      -- check around the single vertex, so buffer a Point and match it.
      v_geom := ST_SetSRID(
        ST_GeomFromGeoJSON(
          jsonb_build_object('type', 'Point', 'coordinates', p_polygon_coords -> 0)::text
        ), 4326);
    ELSE
      v_geom := ST_SetSRID(
        ST_GeomFromGeoJSON(
          jsonb_build_object('type', 'LineString', 'coordinates', p_polygon_coords)::text
        ), 4326);
    END IF;

    RETURN ST_Buffer(v_geom::geography, p_width_m / 2.0);
  END IF;

  -- POLYGON. GeoJSON demands a closed ring and 28 of the 29 already repeat
  -- their first vertex — but exactly one does not, and that one would abort
  -- the whole migration on ST_GeomFromGeoJSON. Close it here rather than
  -- trusting the source, the same way geofence.repository.ts does when it
  -- projects these rings out to the map.
  v_ring := p_polygon_coords;
  IF (v_ring -> 0) <> (v_ring -> -1) THEN
    v_ring := v_ring || jsonb_build_array(v_ring -> 0);
  END IF;

  -- A closed ring needs 4 positions to enclose any area at all.
  IF jsonb_array_length(v_ring) < 4 THEN
    RETURN NULL;
  END IF;

  v_geom := ST_SetSRID(
    ST_GeomFromGeoJSON(
      jsonb_build_object('type', 'Polygon', 'coordinates', jsonb_build_array(v_ring))::text
    ), 4326);

  -- Rings arrive from Wialon and from hand edits, and a self-intersecting one
  -- makes every later ST_Intersects against it throw rather than return false.
  IF NOT ST_IsValid(v_geom) THEN
    v_geom := ST_MakeValid(v_geom);
  END IF;

  RETURN v_geom::geography;
END
$fn$;

-- ---------------------------------------------------------------------------
-- Column, trigger, backfill, index
-- ---------------------------------------------------------------------------

ALTER TABLE "geofences" ADD COLUMN "geom" geography(Geometry, 4326);

CREATE OR REPLACE FUNCTION public.geofences_sync_geom() RETURNS trigger
LANGUAGE plpgsql
AS $t$
BEGIN
  NEW."geom" := public.geofence_geog(
    NEW."type", NEW."polygon_coords",
    NEW."center_lat", NEW."center_lng", NEW."radius_m", NEW."width_m"
  );
  RETURN NEW;
END
$t$;

-- Zones are written by sync-geofences.ts, fix-ring-geofences.ts, seed scripts
-- and the REST API. A trigger is the only place that catches all of them.
CREATE TRIGGER "geofences_geom_sync"
  BEFORE INSERT OR UPDATE OF "type", "polygon_coords", "center_lat", "center_lng", "radius_m", "width_m"
  ON "geofences"
  FOR EACH ROW
  EXECUTE FUNCTION public.geofences_sync_geom();

-- Backfill. Assigning geom directly does not re-fire the trigger above, whose
-- UPDATE OF list deliberately excludes it.
UPDATE "geofences"
SET "geom" = public.geofence_geog(
  "type", "polygon_coords", "center_lat", "center_lng", "radius_m", "width_m"
);

-- Every one of the 107 rows had usable source geometry when this was written
-- (verified against prod 2026-08-08: no null radius, no null width, every
-- vertex a well-formed [lng,lat] pair). If that stopped being true, the column
-- would silently be full of holes and every later spatial query would quietly
-- under-report, so refuse to apply instead.
DO $check$
DECLARE
  v_missing integer;
BEGIN
  -- "Usable source geometry" is spelled out per type rather than approximated,
  -- because NULL is the CORRECT answer for a LINE with no width or a ring too
  -- short to enclose anything. Flagging those would fail the deploy over data
  -- that is merely incomplete, and the syncs keep running between now and
  -- whenever this is applied.
  SELECT count(*) INTO v_missing
  FROM "geofences"
  WHERE "geom" IS NULL
    AND CASE "type"
          WHEN 'CIRCLE' THEN
            "center_lat" IS NOT NULL AND "center_lng" IS NOT NULL AND COALESCE("radius_m", 0) > 0
          WHEN 'POLYGON' THEN
            jsonb_typeof("polygon_coords") = 'array' AND jsonb_array_length("polygon_coords") >= 3
          WHEN 'LINE' THEN
            jsonb_typeof("polygon_coords") = 'array' AND jsonb_array_length("polygon_coords") >= 1
            AND COALESCE("width_m", 0) > 0
        END;

  IF v_missing > 0 THEN
    RAISE EXCEPTION
      '% geofence row(s) have source geometry but produced no geom — refusing to leave the spatial column half-populated', v_missing;
  END IF;
END
$check$;

CREATE INDEX "geofences_geom_idx" ON "geofences" USING gist ("geom");
