-- What the provider says is FITTED to a unit, as opposed to what the unit has
-- lately reported. Telemetry history answers "is this channel alive"; only the
-- sensor configuration answers "is there anything there to be alive".
--
-- calibration_points = 0 is the case this table exists to name: a fuel sensor
-- that is configured but carries no calibration table produces no litres AND no
-- fault, so it is invisible to every rule we have. That is a Wialon record to
-- correct, not a probe to service, and the two must not read the same.
CREATE TABLE "vehicle_sensors" (
    "id"                 TEXT NOT NULL,
    "vehicle_id"         TEXT NOT NULL,
    "external_id"        TEXT NOT NULL,
    "name"               TEXT NOT NULL,
    "type"               TEXT NOT NULL,
    "parameter"          TEXT NOT NULL,
    "calibration_points" INTEGER NOT NULL,
    "calibrated_max"     DOUBLE PRECISION,
    "first_seen_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicle_sensors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vehicle_sensors_vehicle_id_external_id_key"
    ON "vehicle_sensors"("vehicle_id", "external_id");

CREATE INDEX "vehicle_sensors_vehicle_id_idx" ON "vehicle_sensors"("vehicle_id");

-- "every unit carrying a fuel sensor, calibrated or not" — the report's
-- leading question.
CREATE INDEX "vehicle_sensors_type_calibration_points_idx"
    ON "vehicle_sensors"("type", "calibration_points");

ALTER TABLE "vehicle_sensors" ADD CONSTRAINT "vehicle_sensors_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
