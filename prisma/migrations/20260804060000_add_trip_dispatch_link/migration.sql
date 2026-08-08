-- The completed dispatch a trip was measured from.
--
-- `trips` is EMPTY on every live database (0 rows for both orgs, measured
-- 2026-08-04) — the only writers were the retired simulator and an unused REST
-- endpoint — so both the column add and the unique index are instant and carry
-- no rewrite risk.
ALTER TABLE "trips" ADD COLUMN "dispatch_id" TEXT;

-- UNIQUE is what makes the builder safe to re-run over any window: a dispatch
-- already turned into a trip updates that row instead of adding another.
CREATE UNIQUE INDEX "trips_dispatch_id_key" ON "trips"("dispatch_id");
