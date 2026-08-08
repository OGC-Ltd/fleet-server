-- The gate a fleet leaves through, as distinct from the yard's centre point.
--
-- "Left the yard" was measured as 800 m from `hub_lat`/`hub_lng`. On SUKARI the
-- hub sits 17 m from the gate, so that rule fired one radius PAST the gate by
-- construction: measured over 54 departures, the median notification landed
-- 867 m beyond the barrier (p90 4,210 m). Triggering on the gate instead brings
-- the median to 118 m and gains a median 264 s of warning.
--
-- Nullable on purpose: an organisation with no gate recorded keeps the old hub
-- radius behaviour, so nothing regresses for orgs whose gate nobody has
-- supplied yet.
ALTER TABLE "organisations" ADD COLUMN "gate_lat" DOUBLE PRECISION;
ALTER TABLE "organisations" ADD COLUMN "gate_lng" DOUBLE PRECISION;
ALTER TABLE "organisations" ADD COLUMN "gate_radius_m" INTEGER;
