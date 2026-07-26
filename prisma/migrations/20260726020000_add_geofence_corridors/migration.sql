-- Geofence support for provider-sourced zones (Wialon geozones):
--   LINE       — a corridor: polygon_coords holds the centre-line and width_m
--                its width. Haulage roads, drains and rivers are drawn this
--                way; a vehicle is inside when within width_m/2 of the line.
--   external_id — the provider's own zone id, so a re-sync updates in place.
--   width_m     — corridor width in metres (NULL for circles and polygons).
--
-- ALTER TYPE ... ADD VALUE is safe inside this transaction because the new
-- value is not referenced by any statement in the same migration (PG 12+).
ALTER TYPE "GeofenceType" ADD VALUE IF NOT EXISTS 'LINE';

ALTER TABLE "geofences"
  ADD COLUMN "external_id" TEXT,
  ADD COLUMN "width_m" DOUBLE PRECISION;

CREATE UNIQUE INDEX "geofences_external_id_key" ON "geofences"("external_id");
