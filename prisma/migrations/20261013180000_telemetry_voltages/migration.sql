-- The tracker's external supply and internal battery voltages per fix (Wialon
-- pwr_ext / pwr_int), in volts. See VehicleTelemetry.extVoltageV. Nullable with
-- no default, so a catalog-only change: no rewrite of the table and no long
-- lock. Must be applied BEFORE the code that writes these columns is deployed;
-- ingest names them on every insert.

-- Fail fast rather than queue behind a long read (see the accelerometer
-- migration). If it times out, mark it rolled back and run it again.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "vehicle_telemetries" ADD COLUMN "ext_voltage_v" REAL,
ADD COLUMN "int_voltage_v" REAL;
