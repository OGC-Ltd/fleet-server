/*
  Warnings:

  - You are about to drop the `engine_hour_sessions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `fuel_fillings` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `fuel_thefts` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `organisations` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `permissions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `reporting_periods` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `role_permissions` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `roles` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `trips` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `user_roles` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `users` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vehicle_assignments` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vehicle_groups` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vehicle_period_summaries` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `vehicles` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "engine_hour_sessions" DROP CONSTRAINT "engine_hour_sessions_reporting_period_id_fkey";

-- DropForeignKey
ALTER TABLE "engine_hour_sessions" DROP CONSTRAINT "engine_hour_sessions_vehicle_id_fkey";

-- DropForeignKey
ALTER TABLE "fuel_fillings" DROP CONSTRAINT "fuel_fillings_reporting_period_id_fkey";

-- DropForeignKey
ALTER TABLE "fuel_fillings" DROP CONSTRAINT "fuel_fillings_vehicle_id_fkey";

-- DropForeignKey
ALTER TABLE "fuel_thefts" DROP CONSTRAINT "fuel_thefts_driver_id_fkey";

-- DropForeignKey
ALTER TABLE "fuel_thefts" DROP CONSTRAINT "fuel_thefts_reporting_period_id_fkey";

-- DropForeignKey
ALTER TABLE "fuel_thefts" DROP CONSTRAINT "fuel_thefts_vehicle_id_fkey";

-- DropForeignKey
ALTER TABLE "reporting_periods" DROP CONSTRAINT "reporting_periods_organisation_id_fkey";

-- DropForeignKey
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_permission_id_fkey";

-- DropForeignKey
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_role_id_fkey";

-- DropForeignKey
ALTER TABLE "roles" DROP CONSTRAINT "roles_organisation_id_fkey";

-- DropForeignKey
ALTER TABLE "trips" DROP CONSTRAINT "trips_driver_id_fkey";

-- DropForeignKey
ALTER TABLE "trips" DROP CONSTRAINT "trips_reporting_period_id_fkey";

-- DropForeignKey
ALTER TABLE "trips" DROP CONSTRAINT "trips_vehicle_id_fkey";

-- DropForeignKey
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_assigned_by_fkey";

-- DropForeignKey
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_role_id_fkey";

-- DropForeignKey
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_organisation_id_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_assignments" DROP CONSTRAINT "vehicle_assignments_assigned_by_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_assignments" DROP CONSTRAINT "vehicle_assignments_user_id_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_assignments" DROP CONSTRAINT "vehicle_assignments_vehicle_id_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_groups" DROP CONSTRAINT "vehicle_groups_organisation_id_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_period_summaries" DROP CONSTRAINT "vehicle_period_summaries_reporting_period_id_fkey";

-- DropForeignKey
ALTER TABLE "vehicle_period_summaries" DROP CONSTRAINT "vehicle_period_summaries_vehicle_id_fkey";

-- DropForeignKey
ALTER TABLE "vehicles" DROP CONSTRAINT "vehicles_organisation_id_fkey";

-- DropForeignKey
ALTER TABLE "vehicles" DROP CONSTRAINT "vehicles_vehicle_group_id_fkey";

-- DropTable
DROP TABLE "engine_hour_sessions";

-- DropTable
DROP TABLE "fuel_fillings";

-- DropTable
DROP TABLE "fuel_thefts";

-- DropTable
DROP TABLE "organisations";

-- DropTable
DROP TABLE "permissions";

-- DropTable
DROP TABLE "reporting_periods";

-- DropTable
DROP TABLE "role_permissions";

-- DropTable
DROP TABLE "roles";

-- DropTable
DROP TABLE "trips";

-- DropTable
DROP TABLE "user_roles";

-- DropTable
DROP TABLE "users";

-- DropTable
DROP TABLE "vehicle_assignments";

-- DropTable
DROP TABLE "vehicle_groups";

-- DropTable
DROP TABLE "vehicle_period_summaries";

-- DropTable
DROP TABLE "vehicles";

-- CreateTable
CREATE TABLE "organisation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user" (
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

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "assigned_by" TEXT,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_group" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle" (
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

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_assignment" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "assignment_type" "AssignmentType" NOT NULL DEFAULT 'PRIMARY',
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassigned_at" TIMESTAMP(3),
    "assigned_by" TEXT,
    "notes" TEXT,

    CONSTRAINT "vehicle_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reporting_period" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "period_type" "PeriodType" NOT NULL,

    CONSTRAINT "reporting_period_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip" (
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

    CONSTRAINT "trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_hour_session" (
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

    CONSTRAINT "engine_hour_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_filling" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "reporting_period_id" TEXT NOT NULL,
    "filled_at" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "mileage_at_fill_km" DOUBLE PRECISION,
    "initial_fuel_level_ml" INTEGER,
    "filled_ml" INTEGER NOT NULL,
    "final_fuel_level_ml" INTEGER,

    CONSTRAINT "fuel_filling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_theft" (
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

    CONSTRAINT "fuel_theft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_period_summary" (
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

    CONSTRAINT "vehicle_period_summary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisation_code_key" ON "organisation"("code");

-- CreateIndex
CREATE INDEX "role_organisation_id_idx" ON "role"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_organisation_id_slug_key" ON "role"("organisation_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "permission_slug_key" ON "permission"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "permission_resource_action_key" ON "permission"("resource", "action");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_organisation_id_idx" ON "user"("organisation_id");

-- CreateIndex
CREATE INDEX "user_email_idx" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_organisation_id_status_idx" ON "user"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "user_role_user_id_idx" ON "user_role"("user_id");

-- CreateIndex
CREATE INDEX "user_role_role_id_idx" ON "user_role"("role_id");

-- CreateIndex
CREATE INDEX "user_role_user_id_revoked_at_idx" ON "user_role"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "vehicle_group_organisation_id_idx" ON "vehicle_group"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_group_organisation_id_code_key" ON "vehicle_group"("organisation_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_registration_plate_key" ON "vehicle"("registration_plate");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_device_id_key" ON "vehicle"("device_id");

-- CreateIndex
CREATE INDEX "vehicle_organisation_id_idx" ON "vehicle"("organisation_id");

-- CreateIndex
CREATE INDEX "vehicle_vehicle_group_id_idx" ON "vehicle"("vehicle_group_id");

-- CreateIndex
CREATE INDEX "vehicle_device_id_idx" ON "vehicle"("device_id");

-- CreateIndex
CREATE INDEX "vehicle_assignment_vehicle_id_unassigned_at_idx" ON "vehicle_assignment"("vehicle_id", "unassigned_at");

-- CreateIndex
CREATE INDEX "vehicle_assignment_user_id_unassigned_at_idx" ON "vehicle_assignment"("user_id", "unassigned_at");

-- CreateIndex
CREATE INDEX "vehicle_assignment_vehicle_id_assigned_at_idx" ON "vehicle_assignment"("vehicle_id", "assigned_at");

-- CreateIndex
CREATE INDEX "reporting_period_organisation_id_period_start_idx" ON "reporting_period"("organisation_id", "period_start");

-- CreateIndex
CREATE INDEX "trip_vehicle_id_began_at_idx" ON "trip"("vehicle_id", "began_at");

-- CreateIndex
CREATE INDEX "trip_driver_id_began_at_idx" ON "trip"("driver_id", "began_at");

-- CreateIndex
CREATE INDEX "trip_reporting_period_id_idx" ON "trip"("reporting_period_id");

-- CreateIndex
CREATE INDEX "trip_began_at_idx" ON "trip"("began_at");

-- CreateIndex
CREATE INDEX "engine_hour_session_vehicle_id_began_at_idx" ON "engine_hour_session"("vehicle_id", "began_at");

-- CreateIndex
CREATE INDEX "engine_hour_session_reporting_period_id_idx" ON "engine_hour_session"("reporting_period_id");

-- CreateIndex
CREATE INDEX "engine_hour_session_began_at_idx" ON "engine_hour_session"("began_at");

-- CreateIndex
CREATE INDEX "fuel_filling_vehicle_id_filled_at_idx" ON "fuel_filling"("vehicle_id", "filled_at");

-- CreateIndex
CREATE INDEX "fuel_filling_reporting_period_id_idx" ON "fuel_filling"("reporting_period_id");

-- CreateIndex
CREATE INDEX "fuel_filling_filled_at_idx" ON "fuel_filling"("filled_at");

-- CreateIndex
CREATE INDEX "fuel_theft_vehicle_id_began_at_idx" ON "fuel_theft"("vehicle_id", "began_at");

-- CreateIndex
CREATE INDEX "fuel_theft_reporting_period_id_idx" ON "fuel_theft"("reporting_period_id");

-- CreateIndex
CREATE INDEX "fuel_theft_began_at_idx" ON "fuel_theft"("began_at");

-- CreateIndex
CREATE INDEX "vehicle_period_summary_reporting_period_id_idx" ON "vehicle_period_summary"("reporting_period_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_period_summary_vehicle_id_reporting_period_id_key" ON "vehicle_period_summary"("vehicle_id", "reporting_period_id");

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_group" ADD CONSTRAINT "vehicle_group_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_vehicle_group_id_fkey" FOREIGN KEY ("vehicle_group_id") REFERENCES "vehicle_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "vehicle_assignment_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "vehicle_assignment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "vehicle_assignment_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reporting_period" ADD CONSTRAINT "reporting_period_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_reporting_period_id_fkey" FOREIGN KEY ("reporting_period_id") REFERENCES "reporting_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_hour_session" ADD CONSTRAINT "engine_hour_session_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engine_hour_session" ADD CONSTRAINT "engine_hour_session_reporting_period_id_fkey" FOREIGN KEY ("reporting_period_id") REFERENCES "reporting_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_filling" ADD CONSTRAINT "fuel_filling_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_filling" ADD CONSTRAINT "fuel_filling_reporting_period_id_fkey" FOREIGN KEY ("reporting_period_id") REFERENCES "reporting_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft" ADD CONSTRAINT "fuel_theft_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft" ADD CONSTRAINT "fuel_theft_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft" ADD CONSTRAINT "fuel_theft_reporting_period_id_fkey" FOREIGN KEY ("reporting_period_id") REFERENCES "reporting_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_period_summary" ADD CONSTRAINT "vehicle_period_summary_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_period_summary" ADD CONSTRAINT "vehicle_period_summary_reporting_period_id_fkey" FOREIGN KEY ("reporting_period_id") REFERENCES "reporting_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
