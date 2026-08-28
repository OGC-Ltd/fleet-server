-- Record which denominator a stored rate is really measured in, and reserve the
-- columns the tank-balance measurement will be persisted into.
--
-- `vehicle_fuel_rates` held ~225 rows when this was written, one per vehicle
-- that has earned a rate, so every ALTER here is instant. All columns are added
-- NULLABLE with no default, which on PostgreSQL 11+ is a catalogue-only change
-- and rewrites nothing regardless.
--
-- `primary_basis` is deliberately left NULL rather than defaulted to HOURS.
-- Defaulting would assert that every existing row is an hours machine, which is
-- exactly the over-generalisation the consumption-basis work exists to undo --
-- 207 of 822 vehicles are DISTANCE. The weekly derivation populates it, and
-- until it runs a null reads as "not yet resolved".
--
-- The measured_* columns are unpopulated by design: the pipeline that fills
-- them (modules/fuel/fuel-burn-rate.service) is still display-only, and its
-- distance sibling is blocked on the plausibility filter for `coveredSince`.
-- They are added now so the table takes one lock rather than two.

CREATE TYPE "ConsumptionBasis" AS ENUM ('HOURS', 'DISTANCE');

ALTER TABLE "vehicle_fuel_rates"
  ADD COLUMN "primary_basis"           "ConsumptionBasis",
  ADD COLUMN "measured_l_per_hour"     DOUBLE PRECISION,
  ADD COLUMN "measured_lo_l_per_hour"  DOUBLE PRECISION,
  ADD COLUMN "measured_hi_l_per_hour"  DOUBLE PRECISION,
  ADD COLUMN "measured_l_per_km"       DOUBLE PRECISION,
  ADD COLUMN "measured_days"           INTEGER,
  ADD COLUMN "measured_at"             TIMESTAMP(3);
