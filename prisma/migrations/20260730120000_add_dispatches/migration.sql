-- Dispatches as RaiFactorySuite records them: this vehicle, this driver, to
-- this destination, at this time.
--
-- Persisted rather than read live because `/dispatches` is capped at 1000 rows
-- and ignores offset/page/skip -- a sliding window. The map tooltip needs the
-- OPEN dispatch per vehicle, and the due-back estimate needs the CLOSED ones:
-- the provider exposes no coordinates, so the only honest ETA is the median of
-- this fleet's own completed round trips to the same destination, and those
-- trips fall off the provider's window as it moves.
--
-- `destination` is free text, verbatim. It is deliberately never geocoded -- the
-- names are local cane-zone names (152 distinct in use) that public gazetteers
-- do not carry; a probe of the fourteen busiest returned five matches, three of
-- them plainly wrong.

-- CreateTable
CREATE TABLE "dispatches" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "plate" TEXT NOT NULL,
    "driver_name" TEXT NOT NULL,
    "destination" TEXT,
    "status" TEXT NOT NULL,
    "dispatched_at" TIMESTAMP(3) NOT NULL,
    "expected_return_at" TIMESTAMP(3),
    "actual_return_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'webhook',

    CONSTRAINT "dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dispatches_external_id_key" ON "dispatches"("external_id");

-- CreateIndex
CREATE INDEX "dispatches_organisation_id_actual_return_at_dispatched_at_idx" ON "dispatches"("organisation_id", "actual_return_at", "dispatched_at");

-- CreateIndex
CREATE INDEX "dispatches_vehicle_id_dispatched_at_idx" ON "dispatches"("vehicle_id", "dispatched_at");

-- CreateIndex
CREATE INDEX "dispatches_organisation_id_destination_actual_return_at_idx" ON "dispatches"("organisation_id", "destination", "actual_return_at");

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

