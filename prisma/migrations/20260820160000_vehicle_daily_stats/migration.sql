-- Rename probe_daily_stats to vehicle_daily_stats, and move the idle ratio's
-- fix counts onto it from fuel_daily_trends.
--
-- The counts were put on fuel_daily_trends first, and that was wrong.
-- recordFuelTrends skips any unit with no fuel level that day -- a row needs an
-- opening or a closing to be worth keeping -- so the table covers 1,565
-- vehicle-days where telemetry covers 2,002. Measured 2026-08-20, MUFINDI: MTR
-- 11 had three trend days against six of telemetry.
--
-- Idling is a question about the engine and the wheels. It has nothing to do
-- with whether the fuel probe worked, and gating it on fuel would have left
-- every unit with a dead probe -- 12 DIED and 31 SILENT on KASULU alone --
-- without an idle figure, or with one drawn from whichever days its probe
-- happened to report.
--
-- vehicle_daily_stats has a row for every unit that sent anything at all, which
-- is the right population for both consumers. The rename follows: the table is
-- no longer about probes, it is a day's telemetry summarised per vehicle.
ALTER TABLE "probe_daily_stats" RENAME TO "vehicle_daily_stats";

ALTER INDEX "probe_daily_stats_pkey"                 RENAME TO "vehicle_daily_stats_pkey";
ALTER INDEX "probe_daily_stats_day_idx"              RENAME TO "vehicle_daily_stats_day_idx";
ALTER INDEX "probe_daily_stats_vehicle_id_day_key"   RENAME TO "vehicle_daily_stats_vehicle_id_day_key";

ALTER TABLE "vehicle_daily_stats"
  RENAME CONSTRAINT "probe_daily_stats_vehicle_id_fkey" TO "vehicle_daily_stats_vehicle_id_fkey";

ALTER TABLE "vehicle_daily_stats" ADD COLUMN "engine_fixes" INTEGER;
ALTER TABLE "vehicle_daily_stats" ADD COLUMN "idle_fixes"   INTEGER;

-- Never read by shipped code: added and superseded the same day.
ALTER TABLE "fuel_daily_trends" DROP COLUMN "engine_fixes";
ALTER TABLE "fuel_daily_trends" DROP COLUMN "idle_fixes";
