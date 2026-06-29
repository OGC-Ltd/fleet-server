/*
  Warnings:

  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "AssignmentType" AS ENUM ('PRIMARY', 'RELIEF');

-- CreateEnum
CREATE TYPE "PeriodType" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "FuelEventType" AS ENUM ('FILLING', 'THEFT');

-- DropTable
DROP TABLE "User";

-- CreateTable
CREATE TABLE "organisations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "licence_number" TEXT,
    "employee_id" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "assigned_by" TEXT,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_groups" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_group_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "registration_plate" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "vehicle_type" TEXT NOT NULL,
    "fuel_efficiency_kmpl" DOUBLE PRECISION,
    "tank_capacity_litres" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_assignments" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "assignment_type" "AssignmentType" NOT NULL DEFAULT 'PRIMARY',
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassigned_at" TIMESTAMP(3),
    "assigned_by" TEXT,
    "notes" TEXT,

    CONSTRAINT "vehicle_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporting_periods" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "period_type" "PeriodType" NOT NULL,

    CONSTRAINT "reporting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trips" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "reporting_period_id" TEXT NOT NULL,
    "began_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "initial_location" TEXT,
    "final_location" TEXT,
    "duration_seconds" INTEGER NOT NULL,
    "mileage_km" DOUBLE PRECISION NOT NULL,
    "avg_speed_kmh" DOUBLE PRECISION,
    "max_speed_kmh" DOUBLE PRECISION,
    "engine_hours_seconds" INTEGER,
    "consumed_ml" INTEGER,
    "consumed_by_fls_ml" INTEGER,
    "rates_deviation_by_fls" DOUBLE PRECISION,
    "avg_consumption_l100km" DOUBLE PRECISION,
    "avg_consumption_by_fls" DOUBLE PRECISION,
    "avg_idle_consumption_by_fls" DOUBLE PRECISION,
    "avg_mileage_per_unit_fls" DOUBLE PRECISION,
    "initial_fuel_level_ml" INTEGER,
    "final_fuel_level_ml" INTEGER,
    "max_fuel_level_ml" INTEGER,
    "min_fuel_level_ml" INTEGER,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_hour_sessions" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "reporting_period_id" TEXT NOT NULL,
    "began_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3) NOT NULL,
    "initial_location" TEXT,
    "final_location" TEXT,
    "engine_hours_seconds" INTEGER NOT NULL,
    "initial_engine_hours_seconds" INTEGER,
    "final_engine_hours_seconds" INTEGER,
    "total_time_seconds" INTEGER NOT NULL,
    "off_time_seconds" INTEGER,
    "in_motion_seconds" INTEGER,
    "idling_seconds" INTEGER,
    "mileage_km" DOUBLE PRECISION,
    "avg_speed_kmh" DOUBLE PRECISION,
    "max_speed_kmh" DOUBLE PRECISION,
    "consumed_ml" INTEGER,
    "consumed_by_fls_ml" INTEGER,
    "consumed_fls_motion_ml" INTEGER,
    "consumed_fls_idle_ml" INTEGER,
    "avg_consumption_by_fls" DOUBLE PRECISION,
    "avg_consumption_fls_motion" DOUBLE PRECISION,
    "avg_consumption_fls_idle" DOUBLE PRECISION,
    "avg_consumption_fls_trips" DOUBLE PRECISION,
    "initial_fuel_level_ml" INTEGER,
    "final_fuel_level_ml" INTEGER,
    "max_fuel_level_ml" INTEGER,
    "min_fuel_level_ml" INTEGER,

    CONSTRAINT "engine_hour_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_fillings" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "reporting_period_id" TEXT NOT NULL,
    "filled_at" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "mileage_at_fill_km" DOUBLE PRECISION,
    "initial_fuel_level_ml" INTEGER,
    "filled_ml" INTEGER NOT NULL,
    "final_fuel_level_ml" INTEGER,

    CONSTRAINT "fuel_fillings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_thefts" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "reporting_period_id" TEXT NOT NULL,
    "began_at" TIMESTAMP(3) NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL,
    "initial_location" TEXT,
    "initial_fuel_level_ml" INTEGER,
    "final_fuel_level_ml" INTEGER,
    "stolen_ml" INTEGER NOT NULL,
    "initial_speed_kmh" DOUBLE PRECISION,
    "final_speed_kmh" DOUBLE PRECISION,

    CONSTRAINT "fuel_thefts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_period_summaries" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "reporting_period_id" TEXT NOT NULL,
    "mileage_in_trips_km" DOUBLE PRECISION,
    "mileage_all_messages_km" DOUBLE PRECISION,
    "avg_speed_kmh" DOUBLE PRECISION,
    "max_speed_kmh" DOUBLE PRECISION,
    "time_in_trips_seconds" INTEGER,
    "engine_hours_seconds" INTEGER,
    "consumed_by_fls_ml" INTEGER,
    "avg_consumption_by_fls" DOUBLE PRECISION,
    "avg_mileage_per_unit_fls" DOUBLE PRECISION,
    "initial_fuel_level_ml" INTEGER,
    "final_fuel_level_ml" INTEGER,
    "total_filled_ml" INTEGER,
    "total_stolen_ml" INTEGER,
    "refreshed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_period_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisations_code_key" ON "organisations"("code");

-- CreateIndex
CREATE INDEX "roles_organisation_id_idx" ON "roles"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_organisation_id_slug_key" ON "roles"("organisation_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_slug_key" ON "permissions"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_resource_action_key" ON "permissions"("resource", "action");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_organisation_id_idx" ON "users"("organisation_id");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_organisation_id_status_idx" ON "users"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE INDEX "user_roles_user_id_revoked_at_idx" ON "user_roles"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "vehicle_groups_organisation_id_idx" ON "vehicle_groups"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_groups_organisation_id_code_key" ON "vehicle_groups"("organisation_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_registration_plate_key" ON "vehicles"("registration_plate");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_device_id_key" ON "vehicles"("device_id");

-- CreateIndex
CREATE INDEX "vehicles_organisation_id_idx" ON "vehicles"("organisation_id");

-- CreateIndex
CREATE INDEX "vehicles_vehicle_group_id_idx" ON "vehicles"("vehicle_group_id");

-- CreateIndex
CREATE INDEX "vehicles_device_id_idx" ON "vehicles"("device_id");

-- CreateIndex
CREATE INDEX "vehicle_assignments_vehicle_id_unassigned_at_idx" ON "vehicle_assignments"("vehicle_id", "unassigned_at");

-- CreateIndex
CREATE INDEX "vehicle_assignments_user_id_unassigned_at_idx" ON "vehicle_assignments"("user_id", "unassigned_at");

-- CreateIndex
CREATE INDEX "vehicle_assignments_vehicle_id_assigned_at_idx" ON "vehicle_assignments"("vehicle_id", "assigned_at");

-- CreateIndex
CREATE INDEX "reporting_periods_organisation_id_period_start_idx" ON "reporting_periods"("organisation_id", "period_start");

-- CreateIndex
CREATE INDEX "trips_vehicle_id_began_at_idx" ON "trips"("vehicle_id", "began_at");

-- CreateIndex
CREATE INDEX "trips_driver_id_began_at_idx" ON "trips"("driver_id", "began_at");

-- CreateIndex
CREATE INDEX "trips_reporting_period_id_idx" ON "trips"("reporting_period_id");

-- CreateIndex
CREATE INDEX "trips_began_at_idx" ON "trips"("began_at");

-- CreateIndex
CREATE INDEX "engine_hour_sessions_vehicle_id_began_at_idx" ON "engine_hour_sessions"("vehicle_id", "began_at");

-- CreateIndex
CREATE INDEX "engine_hour_sessions_reporting_period_id_idx" ON "engine_hour_sessions"("reporting_period_id");

-- CreateIndex
CREATE INDEX "engine_hour_sessions_began_at_idx" ON "engine_hour_sessions"("began_at");

-- CreateIndex
CREATE INDEX "fuel_fillings_vehicle_id_filled_at_idx" ON "fuel_fillings"("vehicle_id", "filled_at");

-- CreateIndex
CREATE INDEX "fuel_fillings_reporting_period_id_idx" ON "fuel_fillings"("reporting_period_id");

-- CreateIndex
CREATE INDEX "fuel_fillings_filled_at_idx" ON "fuel_fillings"("filled_at");

-- CreateIndex
CREATE INDEX "fuel_thefts_vehicle_id_began_at_idx" ON "fuel_thefts"("vehicle_id", "began_at");

-- CreateIndex
CREATE INDEX "fuel_thefts_reporting_period_id_idx" ON "fuel_thefts"("reporting_period_id");

-- CreateIndex
CREATE INDEX "fuel_thefts_began_at_idx" ON "fuel_thefts"("began_at");

-- CreateIndex
CREATE INDEX "vehicle_period_summaries_reporting_period_id_idx" ON "vehicle_period_summaries"("reporting_period_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_period_summaries_vehicle_id_reporting_period_id_key" ON "vehicle_period_summaries"("vehicle_id", "reporting_period_id");

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_groups" ADD CONSTRAINT "vehicle_groups_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_vehicle_group_id_fkey" FOREIGN KEY ("vehicle_group_id") REFERENCES "vehicle_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporting_periods" ADD CONSTRAINT "reporting_periods_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_reporting_period_id_fkey" FOREIGN KEY ("reporting_period_id") REFERENCES "reporting_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_hour_sessions" ADD CONSTRAINT "engine_hour_sessions_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_hour_sessions" ADD CONSTRAINT "engine_hour_sessions_reporting_period_id_fkey" FOREIGN KEY ("reporting_period_id") REFERENCES "reporting_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_fillings" ADD CONSTRAINT "fuel_fillings_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_fillings" ADD CONSTRAINT "fuel_fillings_reporting_period_id_fkey" FOREIGN KEY ("reporting_period_id") REFERENCES "reporting_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_thefts" ADD CONSTRAINT "fuel_thefts_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_thefts" ADD CONSTRAINT "fuel_thefts_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_thefts" ADD CONSTRAINT "fuel_thefts_reporting_period_id_fkey" FOREIGN KEY ("reporting_period_id") REFERENCES "reporting_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_period_summaries" ADD CONSTRAINT "vehicle_period_summaries_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_period_summaries" ADD CONSTRAINT "vehicle_period_summaries_reporting_period_id_fkey" FOREIGN KEY ("reporting_period_id") REFERENCES "reporting_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
