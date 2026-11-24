SET lock_timeout = '5s';

-- Odometer readings filled in from Wialon get their own table instead of being
-- written onto old vehicle_telemetries rows (see VehicleOdometerFill in
-- schema.prisma). One new table, nothing altered; readings already written
-- onto telemetry rows stay where they are and are still read first.

-- CreateTable
CREATE TABLE IF NOT EXISTS "vehicle_odometer_fills" (
    "vehicle_id" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "odometer_m" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "vehicle_odometer_fills_pkey" PRIMARY KEY ("vehicle_id","captured_at")
);
