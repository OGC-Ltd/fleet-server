-- Temporary vs heavy stops, and the run/window parameters the operator set.
--
--   a STOP is 1 minute or more of continuous engine-off
--   under 60 minutes it is TEMPORARY — a gate, a weighbridge, a break
--   60 minutes or more it is HEAVY — the machine standing down
--   either one ends a run, whichever comes first
--   a window counts with MORE THAN ONE reading at speed >= 1 km/h
--
-- The previous parameters were a 15-minute stop, 10 readings per window and a
-- 0.1 km/h motion floor. The 15-minute stop merged brief halts into the runs
-- either side and undercounted journeys badly, so every stored turbulence value
-- was averaged over the wrong segments.
--
-- Values are therefore cleared, not migrated: they answer a different question.
-- prisma/fuel-trends.ts --days N rewrites them, OLDEST FIRST.

ALTER TABLE "fuel_daily_trends"
  ADD COLUMN "temporary_stops" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "heavy_stops"     INTEGER NOT NULL DEFAULT 0;

UPDATE "fuel_daily_trends"
   SET "turbulence_ml" = NULL, "stops_averaged" = 0, "run_slosh_ml" = '{}';
