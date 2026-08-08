-- Adjudicate the provider's drain claims instead of banking them.
--
-- Wialon's report decides that a fuel-level drop is a theft. Measured over the
-- 250 most recent drains per org (2026-08-04): 40% of KASULU's and 50% of
-- SUKARI's DECIDABLE loss volume came back with no filling to explain it —
-- fuel that moved away from the probe on a slope and returned, not fuel that
-- left. KES 703,177 and KES 138,934 of those samples alone.
--
-- Every row keeps its place on the ledger whatever the verdict, so the rule
-- stays auditable against the provider and an operator who saw a notification
-- can find out what became of it.
CREATE TYPE "FuelLossVerdict" AS ENUM ('PENDING', 'LOSS', 'REDISTRIBUTION', 'UNVERIFIED');

-- Existing rows default to PENDING, and analytics excludes only
-- REDISTRIBUTION, so applying this migration changes no reported figure. The
-- history is re-judged separately by `npm run fuel:adjudicate -- --backfill`.
ALTER TABLE "fuel_thefts" ADD COLUMN "verdict" "FuelLossVerdict" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "fuel_thefts" ADD COLUMN "verdict_at" TIMESTAMP(3);
ALTER TABLE "fuel_thefts" ADD COLUMN "recovered_ml" INTEGER;
ALTER TABLE "fuel_thefts" ADD COLUMN "verdict_reason" TEXT;

-- The sweep's only query: still PENDING, and old enough to judge.
CREATE INDEX "fuel_thefts_verdict_detected_at_idx" ON "fuel_thefts"("verdict", "detected_at");
