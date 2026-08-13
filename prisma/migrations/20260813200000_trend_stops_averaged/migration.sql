-- Turbulence is averaged over STOPS, not clock windows.
--
-- Asked for by the operator: the moving average is "to be computed per every
-- stop". The column recorded how many 30-minute motion windows the mean spanned;
-- it now records how many RUNS — the motion between two stops — which is the
-- unit the average is actually taken over.
--
-- That weights correctly: a machine making three runs today and eleven
-- yesterday should not have yesterday dominate simply by being busier. Every
-- run counts once whatever its length.
--
-- The formula is written out at `stopTurbulence` in
-- modules/fuel/fuel-tank-state.ts.
--
-- Existing rows are stale under the new definition — they hold a window count
-- against a windowed mean — so the values are cleared rather than reinterpreted.
-- prisma/fuel-trends.ts --days N rewrites them.

ALTER TABLE "fuel_daily_trends" RENAME COLUMN "motion_windows" TO "stops_averaged";

UPDATE "fuel_daily_trends" SET "stops_averaged" = 0, "turbulence_ml" = NULL;
