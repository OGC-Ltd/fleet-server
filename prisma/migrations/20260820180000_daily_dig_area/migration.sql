-- Excavator worked-area, stored per vehicle per fleet day.
--
-- It was computed on demand behind an hourly cache, and it stopped fitting.
-- Measured 2026-08-20 the endpoint returned 500 after 60 s -- the client
-- query_timeout -- because reading and unioning one machine's digging day takes
-- about 19 s and there are nineteen machines. The union was never the expensive
-- part: a count over the same rows with no geometry at all also timed out.
--
-- The day is complete and immutable, so it is computed once by the nightly job
-- and read back. Nullable throughout: only excavators get an area, and only on
-- a day with enough fixes to draw one.
ALTER TABLE "vehicle_daily_stats" ADD COLUMN "dig_area_m2" INTEGER;
ALTER TABLE "vehicle_daily_stats" ADD COLUMN "dig_seconds" INTEGER;
