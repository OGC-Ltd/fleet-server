-- Adjudicate fillings, not just drains.
--
-- Every fuel_fillings row is Wialon's claim that a level RISE was a refuelling,
-- stored unchecked since the table existed. Drains have been judged against our
-- own telemetry since 2026-08-04; fillings never were.
--
-- Measured 2026-08-11 over 5,794 fillings since 2026-07-01: 1,865 are decidable
-- (>=3 readings either side) and of those, 1,558 (84%) show at least half the
-- claimed volume arriving, with a median observed-over-claimed of 0.96. The
-- ledger is mostly sound. This is for the 307 that are not — 210 of which show
-- NO RISE AT ALL, being the up-swings of oscillating probes on the same
-- machines whose down-swings arrive as "thefts".
--
-- Reuses FuelEventVerdict rather than inventing a second enum: a fuel event is
-- a REFILL, a DRAIN or a REDISTRIBUTION whichever ledger it arrives on, which
-- is the operator's own model.
--
-- Nothing is deleted and no volume is edited. filled_ml stays exactly as the
-- provider reported it; observed_rise_ml records what our telemetry actually
-- saw, so the two can always be compared.

ALTER TABLE "fuel_fillings"
  ADD COLUMN "verdict"          "FuelEventVerdict" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "verdict_at"       TIMESTAMP(3),
  ADD COLUMN "verdict_reason"   TEXT,
  ADD COLUMN "observed_rise_ml" INTEGER;

-- Drives the sweep: "which fillings are still PENDING and old enough to judge?"
CREATE INDEX "fuel_fillings_verdict_filled_at_idx"
  ON "fuel_fillings" ("verdict", "filled_at");
