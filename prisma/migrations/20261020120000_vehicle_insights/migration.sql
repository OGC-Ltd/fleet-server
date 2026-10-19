-- A unit's insight and its memory (VehicleInsight, modules/vehicles/vehicle-insight).
-- A new table only: no rewrite of anything that exists. Must be applied BEFORE
-- the code that writes it is deployed.

SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "vehicle_insights" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "model" TEXT,
    "headline" TEXT NOT NULL,
    "findings" JSONB NOT NULL,
    "action" TEXT,
    "risk" TEXT NOT NULL,
    "signals" JSONB NOT NULL,
    "signals_hash" TEXT NOT NULL,

    CONSTRAINT "vehicle_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_insights_vehicle_id_generated_at_idx" ON "vehicle_insights"("vehicle_id", "generated_at" DESC);

-- CreateIndex
CREATE INDEX "vehicle_insights_organisation_id_generated_at_idx" ON "vehicle_insights"("organisation_id", "generated_at");

-- AddForeignKey
ALTER TABLE "vehicle_insights" ADD CONSTRAINT "vehicle_insights_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_insights" ADD CONSTRAINT "vehicle_insights_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
