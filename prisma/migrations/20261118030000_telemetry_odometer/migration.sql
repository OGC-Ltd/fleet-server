-- The tracker's own running odometer per fix (Teltonika io_16), in metres. See
-- VehicleTelemetry.odometerM. Nullable with no default, so a catalog-only change:
-- no rewrite of the table and no long lock. Must be applied BEFORE the code that
-- writes it is deployed; ingest names it on every insert.

-- Fail fast rather than queue behind a long read (see the accelerometer
-- migration). If it times out, mark it rolled back and run it again.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "vehicle_telemetries" ADD COLUMN "odometer_m" DOUBLE PRECISION;
