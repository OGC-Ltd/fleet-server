-- Keep each run's slosh, so the moving average can span days.
--
-- TURBULENCE_STOPS is 8, but most vehicles make only 1-2 runs a day (measured
-- 2026-08-13: mean stops_averaged 1.3-2.0 across the fleet). An average that
-- restarts at midnight therefore spanned one or two runs, not eight — it was a
-- daily figure wearing a moving average's name.
--
-- Storing the individual run values is what lets the window cross a day
-- boundary: to average the last 8 runs you have to know what they were, and a
-- day's mean cannot be un-meaned. The array is small — one element per run, so
-- typically one or two per row.
--
-- turbulence_ml stays the answer to "what is this vehicle's current slosh
-- average", now genuinely over the last 8 runs whenever they happened;
-- stops_averaged says how many of the 8 were actually found.
--
-- Existing turbulence values were computed within-day and are stale under the
-- carried definition, so they are cleared rather than left to be read as
-- something they are not. prisma/fuel-trends.ts rewrites them.

ALTER TABLE "fuel_daily_trends"
  ADD COLUMN "run_slosh_ml" INTEGER[] NOT NULL DEFAULT '{}';

UPDATE "fuel_daily_trends" SET "turbulence_ml" = NULL, "stops_averaged" = 0;
