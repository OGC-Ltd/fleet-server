-- Machine model, and WHY a drain happened.
--
-- Two changes that belong together: the cause classifier cannot pick a burn
-- band without knowing what kind of machine it is looking at, and the model is
-- the thing that decides consumption. See
-- docs/fuel-theft-discrimination-plan.md.
--
-- ## Why `vehicles.model` has to exist
--
-- Fuel burn is a property of the MODEL, not of `vehicle_type`. A Cat D6 burns
-- 14-22 L/h and a Cat D11 59-97, and both are "PLANT". Measured over 2,267
-- drains on 2026-08-16, that conflation was the single largest source of false
-- fuel alerts: KASULU's TRACTOR label spans 84 L to 1,631 L tanks and derived
-- rates of 1.6 to 28.3 L/h, and two machines held to its 4.32 L/h median
-- produced 64% of every alert the classifier raised in thirty days.
--
-- It is recorded nowhere else. `vehicles.name` is a copy of the plate on this
-- fleet, and the Wialon units carry only probe identifiers and SIM ICCIDs in
-- their custom fields. Both were checked before adding a column.
--
-- Nullable, and left NULL for every existing row. There is no defensible way to
-- backfill it from what we hold — tank capacity is the obvious proxy and
-- disagrees with the probe on 180 of 299 units — so it is populated by hand as
-- the operator supplies models, and a vehicle without one simply falls back to
-- its derived rate.
--
-- ## Why the cause columns are separate from `verdict`
--
-- `fuel_thefts.verdict` answers "did the fuel leave the tank" and is written on
-- 3,300 rows read by the analytics, the reports, the AI insight and the
-- dashboard chips. Cause answers "why", which is a different question; folding
-- it into the same enum would silently change what every one of those consumers
-- means by a verdict. The pair mirrors the existing
-- verdict/verdictReason/verdictConfidence triple deliberately.
--
-- ## Cost on this instance
--
-- Additive and cheap. Adding a nullable column without a default is a catalogue
-- update in PostgreSQL 11+, not a table rewrite, so none of these ALTERs scan
-- `vehicles` or `fuel_thefts`. That matters here: the instance is a 1 GB RDS
-- holding a 5.9 GB database, where a rewrite of fuel_thefts would be felt.
--
-- The index is the one part that does real work — it builds over ~3,300 rows,
-- which is trivial. It leads on `drain_cause` because the dashboard asks for
-- only two of the seven values, so the scan starts from a small slice rather
-- than from a date range spanning every drain on the ledger.

-- CreateEnum
CREATE TYPE "FuelDrainCause" AS ENUM (
  'ENGINE_BURN',
  'HIGH_BURN',
  'UNEXPLAINED_BURN',
  'SIPHON',
  'SLOSH',
  'SETTLING',
  'INDETERMINATE'
);

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN "model" TEXT;

-- AlterTable
ALTER TABLE "fuel_thefts" ADD COLUMN "drain_cause" "FuelDrainCause";
ALTER TABLE "fuel_thefts" ADD COLUMN "cause_confidence" DOUBLE PRECISION;
ALTER TABLE "fuel_thefts" ADD COLUMN "cause_reason" TEXT;

-- CreateIndex
CREATE INDEX "fuel_thefts_drain_cause_began_at_idx" ON "fuel_thefts"("drain_cause", "began_at");
