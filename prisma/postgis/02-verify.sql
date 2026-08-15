q-- ---------------------------------------------------------------------------
-- Read-only. Proves the PostGIS setup is actually correct, and that the
-- telemetry index is actually used. Safe to run any time, as `fleet_app`.
--
--   psql "$DIRECT_URL" -f prisma/postgis/02-verify.sql
-- ---------------------------------------------------------------------------
\pset border 1

\echo
\echo ### 1. Extension
SELECT extname, extversion FROM pg_extension WHERE extname LIKE 'postgis%';

\echo
\echo ### 2. Every fence derived a shape (expect 0 missing)
SELECT
  "type",
  count(*)                                AS fences,
  count(*) FILTER (WHERE "geom" IS NULL)   AS missing_geom,
  count(*) FILTER (WHERE NOT ST_IsValid("geom"::geometry)) AS invalid_geom
FROM "geofences"
GROUP BY "type"
ORDER BY "type";

\echo
\echo ### 3. Derived shape agrees with the stored scalars
\echo '    CIRCLE: measured radius should be ~= radius_m (buffer is a 32-gon,'
\echo '    so it inscribes slightly under the true circle).'
SELECT
  "name",
  "radius_m"                                                            AS declared_m,
  round(ST_Perimeter("geom") / (2 * pi()))                              AS measured_m
FROM "geofences"
WHERE "type" = 'CIRCLE'
ORDER BY "name"
LIMIT 5;

\echo
\echo '    LINE: measured width should be ~= width_m.'
SELECT
  "name",
  "width_m"                                                             AS declared_m,
  round((ST_Area("geom") / NULLIF(ST_Length(ST_Boundary("geom"::geometry)::geography) / 2, 0))::numeric, 2) AS approx_width_m
FROM "geofences"
WHERE "type" = 'LINE'
ORDER BY "name"
LIMIT 5;

\echo
\echo '    POLYGON: PostGIS spheroid area vs the hand-rolled ringAreaHa in'
\echo '    lib/zone-taxonomy.ts. Large disagreement means one of them is wrong.'
SELECT
  "name",
  jsonb_array_length("polygon_coords")        AS vertices,
  round((ST_Area("geom") / 10000)::numeric, 2) AS postgis_ha
FROM "geofences"
WHERE "type" = 'POLYGON'
ORDER BY ST_Area("geom") DESC
LIMIT 10;

\echo
\echo ### 4. Zones overlap sanity - a point in several zones ranks smallest-first
\echo '    (this is the ordering lib/zone-presence.ts applies in memory)'
SELECT
  a."name" AS zone,
  count(*) AS overlaps_other_zones
FROM "geofences" a
JOIN "geofences" b
  ON a."id" <> b."id" AND ST_Intersects(a."geom", b."geom")
GROUP BY a."name"
ORDER BY count(*) DESC
LIMIT 5;

\echo
\echo ### 5. THE PAYOFF - telemetry history against a boundary.
\echo '    Impossible before this migration. Uses vehicle_telemetries_geog_idx.'
-- One zone as a single constant, so the planner has a fixed geometry to probe
-- the index with rather than a value from the other side of a join.
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)
SELECT count(*)
FROM "vehicle_telemetries" t
WHERE ST_Intersects(
        (SELECT "geom" FROM "geofences" WHERE "type" = 'POLYGON' ORDER BY ST_Area("geom") LIMIT 1),
        ST_SetSRID(ST_MakePoint(t."lng", t."lat"), 4326)::geography
      );

\echo
\echo '    ^ Look for "Index Scan using vehicle_telemetries_geog_idx".'
\echo '    A Seq Scan means the expression at the call site does not match the'
\echo '    indexed one exactly - see 01-telemetry-spatial-index.sql.'
