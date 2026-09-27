-- The two-stage parked-fall rule: a fall of fuel on a PARKED machine, from
-- the live watch (stage one, lib/fuel-drop-watch) to what happened when the
-- machine next started (stage two, lib/queues/parked-falls). See
-- modules/fuel/parked-fall and ParkedFuelFall. Additive: nothing existing changes.

-- The foreign keys lock vehicles and organisations against writes for an
-- instant; fail fast rather than queue behind a long transaction. If it times
-- out, mark the migration rolled back (prisma migrate resolve --rolled-back)
-- and run it again.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ParkedFallVerdict" AS ENUM ('PENDING', 'CONFIRMED', 'TOPPED_UP', 'REFUELLED', 'CLEARED', 'UNRESOLVED', 'WITHHELD');

-- CreateTable
CREATE TABLE "parked_fuel_falls" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "settled_at" TIMESTAMP(3) NOT NULL,
    "flagged_at" TIMESTAMP(3) NOT NULL,
    "baseline_ml" INTEGER NOT NULL,
    "trough_ml" INTEGER NOT NULL,
    "dropped_ml" INTEGER NOT NULL,
    "still_for_ms" INTEGER NOT NULL,
    "engine_on_ms" INTEGER NOT NULL,
    "engine_evidence" TEXT NOT NULL,
    "meter_advance_h" DOUBLE PRECISION,
    "verdict" "ParkedFallVerdict" NOT NULL DEFAULT 'PENDING',
    "verdict_at" TIMESTAMP(3),
    "verdict_reason" TEXT,
    "next_start_at" TIMESTAMP(3),
    "next_start_by" TEXT,
    "jump_ml" INTEGER,
    "back_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parked_fuel_falls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parked_fuel_falls_verdict_settled_at_idx" ON "parked_fuel_falls"("verdict", "settled_at");

-- CreateIndex
CREATE INDEX "parked_fuel_falls_organisation_id_settled_at_idx" ON "parked_fuel_falls"("organisation_id", "settled_at");

-- CreateIndex
CREATE UNIQUE INDEX "parked_fuel_falls_vehicle_id_settled_at_key" ON "parked_fuel_falls"("vehicle_id", "settled_at");

-- AddForeignKey
ALTER TABLE "parked_fuel_falls" ADD CONSTRAINT "parked_fuel_falls_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parked_fuel_falls" ADD CONSTRAINT "parked_fuel_falls_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

