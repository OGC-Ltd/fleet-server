-- CreateEnum
CREATE TYPE "GeofenceType" AS ENUM ('CIRCLE', 'POLYGON');

-- CreateEnum
CREATE TYPE "FenceMode" AS ENUM ('ALLOWLIST', 'BLOCKLIST');

-- CreateEnum
CREATE TYPE "CargoType" AS ENUM ('BULK', 'PACKAGED', 'LIVESTOCK', 'HAZMAT', 'FUEL', 'MACHINERY', 'OTHER');

-- AlterTable
ALTER TABLE "trip" ADD COLUMN     "route_id" TEXT;

-- CreateTable
CREATE TABLE "ingest_api_key" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_by" TEXT,

    CONSTRAINT "ingest_api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "origin_name" TEXT NOT NULL,
    "origin_lat" DOUBLE PRECISION NOT NULL,
    "origin_lng" DOUBLE PRECISION NOT NULL,
    "destination_name" TEXT NOT NULL,
    "destination_lat" DOUBLE PRECISION NOT NULL,
    "destination_lng" DOUBLE PRECISION NOT NULL,
    "distance_km" DOUBLE PRECISION,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_waypoint" (
    "id" TEXT NOT NULL,
    "route_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "name" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "radius_m" INTEGER NOT NULL DEFAULT 200,

    CONSTRAINT "route_waypoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geofence" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "GeofenceType" NOT NULL,
    "mode" "FenceMode" NOT NULL DEFAULT 'ALLOWLIST',
    "center_lat" DOUBLE PRECISION,
    "center_lng" DOUBLE PRECISION,
    "radius_m" INTEGER,
    "polygon_coords" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "geofence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_geofence" (
    "vehicle_id" TEXT NOT NULL,
    "geofence_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" TEXT,

    CONSTRAINT "vehicle_geofence_pkey" PRIMARY KEY ("vehicle_id","geofence_id")
);

-- CreateTable
CREATE TABLE "geofence_violation" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "geofence_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speed_kmh" DOUBLE PRECISION,
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "geofence_violation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_telemetry" (
    "id" BIGSERIAL NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "altitude_m" DOUBLE PRECISION,
    "heading_deg" DOUBLE PRECISION,
    "accuracy_m" DOUBLE PRECISION,
    "speed_kmh" DOUBLE PRECISION,
    "engine_on" BOOLEAN NOT NULL DEFAULT false,
    "fuel_level_ml" INTEGER,
    "fuel_used_ml" INTEGER,
    "cargo_weight_kg" DOUBLE PRECISION,

    CONSTRAINT "vehicle_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_telemetry_raw" (
    "telemetry_id" BIGINT NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "vehicle_telemetry_raw_pkey" PRIMARY KEY ("telemetry_id")
);

-- CreateTable
CREATE TABLE "cargo_manifest" (
    "id" TEXT NOT NULL,
    "trip_id" TEXT NOT NULL,
    "description" TEXT,
    "cargo_type" "CargoType",
    "declared_weight_kg" DOUBLE PRECISION,
    "departure_weight_kg" DOUBLE PRECISION,
    "arrival_weight_kg" DOUBLE PRECISION,
    "weight_variance_kg" DOUBLE PRECISION,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cargo_manifest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingest_api_key_key_hash_key" ON "ingest_api_key"("key_hash");

-- CreateIndex
CREATE INDEX "ingest_api_key_organisation_id_idx" ON "ingest_api_key"("organisation_id");

-- CreateIndex
CREATE INDEX "ingest_api_key_key_hash_idx" ON "ingest_api_key"("key_hash");

-- CreateIndex
CREATE INDEX "route_organisation_id_idx" ON "route"("organisation_id");

-- CreateIndex
CREATE INDEX "route_organisation_id_is_active_idx" ON "route"("organisation_id", "is_active");

-- CreateIndex
CREATE INDEX "route_waypoint_route_id_sequence_idx" ON "route_waypoint"("route_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "route_waypoint_route_id_sequence_key" ON "route_waypoint"("route_id", "sequence");

-- CreateIndex
CREATE INDEX "geofence_organisation_id_idx" ON "geofence"("organisation_id");

-- CreateIndex
CREATE INDEX "geofence_organisation_id_is_active_idx" ON "geofence"("organisation_id", "is_active");

-- CreateIndex
CREATE INDEX "vehicle_geofence_geofence_id_idx" ON "vehicle_geofence"("geofence_id");

-- CreateIndex
CREATE INDEX "geofence_violation_vehicle_id_occurred_at_idx" ON "geofence_violation"("vehicle_id", "occurred_at");

-- CreateIndex
CREATE INDEX "geofence_violation_geofence_id_occurred_at_idx" ON "geofence_violation"("geofence_id", "occurred_at");

-- CreateIndex
CREATE INDEX "geofence_violation_driver_id_occurred_at_idx" ON "geofence_violation"("driver_id", "occurred_at");

-- CreateIndex
CREATE INDEX "geofence_violation_occurred_at_idx" ON "geofence_violation"("occurred_at");

-- CreateIndex
CREATE INDEX "vehicle_telemetry_vehicle_id_captured_at_idx" ON "vehicle_telemetry"("vehicle_id", "captured_at");

-- CreateIndex
CREATE INDEX "vehicle_telemetry_captured_at_idx" ON "vehicle_telemetry"("captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_telemetry_device_id_captured_at_key" ON "vehicle_telemetry"("device_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "cargo_manifest_trip_id_key" ON "cargo_manifest"("trip_id");

-- CreateIndex
CREATE INDEX "trip_route_id_idx" ON "trip"("route_id");

-- AddForeignKey
ALTER TABLE "ingest_api_key" ADD CONSTRAINT "ingest_api_key_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingest_api_key" ADD CONSTRAINT "ingest_api_key_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_waypoint" ADD CONSTRAINT "route_waypoint_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence" ADD CONSTRAINT "geofence_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_geofence" ADD CONSTRAINT "vehicle_geofence_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_geofence" ADD CONSTRAINT "vehicle_geofence_geofence_id_fkey" FOREIGN KEY ("geofence_id") REFERENCES "geofence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_geofence" ADD CONSTRAINT "vehicle_geofence_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_violation" ADD CONSTRAINT "geofence_violation_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_violation" ADD CONSTRAINT "geofence_violation_geofence_id_fkey" FOREIGN KEY ("geofence_id") REFERENCES "geofence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence_violation" ADD CONSTRAINT "geofence_violation_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "route"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_telemetry" ADD CONSTRAINT "vehicle_telemetry_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cargo_manifest" ADD CONSTRAINT "cargo_manifest_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
