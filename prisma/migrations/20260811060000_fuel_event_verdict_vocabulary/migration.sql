-- Fuel verdicts: describe the event, do not accuse.
--
-- Asked for directly by the operator on 2026-08-11: "we need to have either a
-- refill, drain or redistribution (undulation)", and "avoid strong words like
-- loss".
--
-- Two values go, for two different reasons.
--
--   LOSS asserted where the fuel went. Telemetry cannot see that. All it
--   observes is that the level fell and did not come back — which is what DRAIN
--   says, and as far as this data can honestly go. Whether a drain was theft, a
--   transfer or a machine working hard is not a question the probe answers, and
--   the word decided it for whoever read the row.
--
--   UNVERIFIED was not a description of the fuel at all. It described OUR
--   evidence, promoted to a verdict, and it covered 1,938 of 2,571 rows — so
--   for three quarters of the ledger an operator could not tell whether the
--   fuel had gone. That distinction is real and is kept: verdict_reason already
--   carries it on every row, and the application derives `confirmed` from it.
--
-- Postgres cannot drop a value from an enum in place, so the type is rebuilt
-- and the column cast through a CASE. Nothing is deleted and no volume is
-- edited — stolen_ml, the levels and the timestamps are untouched.
--
-- Mapping, and the row counts it moves as of 2026-08-11:
--
--   LOSS                          417  -> DRAIN
--   UNVERIFIED insufficient-telemetry
--            / drop-not-observed
--            / no-drop-observed  1,503 -> DRAIN   (provider saw a fall, we could
--                                                  not check it; we relay the
--                                                  claim rather than contradict)
--   UNVERIFIED filling-too-soon    435 -> REFILL  (fuel demonstrably went IN and
--                                                  we cannot see it having gone
--                                                  out; calling these drains
--                                                  reports a refuelling round as
--                                                  a month of theft)
--   REDISTRIBUTION                 212 -> unchanged
--   SENSOR_FAULT                     4 -> unchanged
--   PENDING                          0 -> unchanged
--
-- The reason slug `filling-too-soon` is renamed to `filling-in-window` in the
-- same pass: it now names a verdict rather than an obstacle to reaching one.

ALTER TYPE "FuelLossVerdict" RENAME TO "FuelLossVerdict_old";

CREATE TYPE "FuelEventVerdict" AS ENUM (
  'PENDING', 'REFILL', 'DRAIN', 'REDISTRIBUTION', 'SENSOR_FAULT'
);

ALTER TABLE "fuel_thefts" ALTER COLUMN "verdict" DROP DEFAULT;

ALTER TABLE "fuel_thefts"
  ALTER COLUMN "verdict" TYPE "FuelEventVerdict"
  USING (
    CASE
      WHEN "verdict"::text = 'LOSS' THEN 'DRAIN'
      WHEN "verdict"::text = 'UNVERIFIED' AND "verdict_reason" = 'filling-too-soon' THEN 'REFILL'
      WHEN "verdict"::text = 'UNVERIFIED' THEN 'DRAIN'
      ELSE "verdict"::text
    END
  )::"FuelEventVerdict";

ALTER TABLE "fuel_thefts" ALTER COLUMN "verdict" SET DEFAULT 'PENDING';

UPDATE "fuel_thefts"
   SET "verdict_reason" = 'filling-in-window'
 WHERE "verdict_reason" = 'filling-too-soon';

DROP TYPE "FuelLossVerdict_old";
