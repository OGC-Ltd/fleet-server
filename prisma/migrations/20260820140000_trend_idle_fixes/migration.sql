-- The idle ratio's two counts, per vehicle per fleet day.
--
-- fleet_state derived these by scanning a week of vehicle_telemetries on every
-- build: 4.95 s, 2.1M buffers touched. They are counts, so they sum across days
-- like every other figure on this table, and the week and month figures can be
-- read rather than re-derived.
--
-- Nullable because every existing row predates them. A null is not a zero: zero
-- would claim the unit ran its engine and never idled, where null says the day
-- was recorded before anyone counted.
--
-- No fallback is needed for that. SUM ignores nulls, so an uncounted day drops
-- out of BOTH sides of the ratio and the figure stays honest over the days that
-- do carry counts -- it is a ratio, not a total. prisma/trend-fixes.ts fills
-- the history so the window is complete anyway.
ALTER TABLE "fuel_daily_trends" ADD COLUMN "engine_fixes" INTEGER;
ALTER TABLE "fuel_daily_trends" ADD COLUMN "idle_fixes"   INTEGER;
