-- Separate what a machine burns idling from what it burns working.
--
-- Measured 2026-08-27 over 7 days of HOURS machines: working burn is 1.85x
-- idle overall, and far more per class -- TRACTOR_MEDIUM 7.22x (0.8 against
-- 6.1 L/h), TRACTOR_SMALL 2.75x, EXCAVATOR_LARGE 2.33x. That is most of the
-- 2-4x within-type spread the single blended rate has always carried.
--
-- All four columns nullable with no default: on PostgreSQL 11+ that is a
-- catalogue-only change and rewrites nothing, and `vehicle_fuel_rates` held
-- ~243 rows when this was written in any case.
--
-- Null is load-bearing here. A machine the window gave too few runs of one kind
-- has NO rate of that kind, and a reader must fall through rather than
-- substitute the other figure -- an idle rate borrowed from working burn would
-- be roughly double the truth on a tractor, which is the direction that turns
-- ordinary idling into an unexplained drop.

ALTER TABLE "vehicle_fuel_rates"
  ADD COLUMN "idle_l_per_hour" DOUBLE PRECISION,
  ADD COLUMN "work_l_per_hour" DOUBLE PRECISION,
  ADD COLUMN "idle_runs"       INTEGER,
  ADD COLUMN "work_runs"       INTEGER;
