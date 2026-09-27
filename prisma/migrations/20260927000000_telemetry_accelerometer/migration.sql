-- The tracker's accelerometer axes per fix (Teltonika AVL 17/18/19), in g. See
-- VehicleTelemetry.accelXG. Nullable with no default, so on this Postgres it is
-- a catalog-only change: no rewrite of the table and no long lock, whatever its
-- size. Must be applied BEFORE the code that writes these columns is deployed;
-- ingest names them on every insert.

-- Fail fast rather than queue. ADD COLUMN holds an ACCESS EXCLUSIVE lock for an
-- instant, but WAITING for it behind a long read would stall every insert and
-- read queued behind this statement. If it times out, mark the migration rolled
-- back (prisma migrate resolve --rolled-back) and run it again.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "vehicle_telemetries" ADD COLUMN "accel_x_g" REAL,
ADD COLUMN "accel_y_g" REAL,
ADD COLUMN "accel_z_g" REAL;
