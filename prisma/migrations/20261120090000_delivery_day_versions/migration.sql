-- Earlier versions of each Deliveries day list: a save that changes the list
-- first keeps the list it replaces here, so a day emptied or overwritten by
-- mistake can be put back (18 and 19 Nov 2026 were saved empty and were lost).
-- New table only: nothing existing is altered.

SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "delivery_day_versions" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "vehicles" JSONB NOT NULL,
    "saved_by" TEXT,
    "saved_at" TIMESTAMP(3) NOT NULL,
    "replaced_by" TEXT,
    "replaced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_day_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_day_versions_organisation_id_day_replaced_at_idx" ON "delivery_day_versions"("organisation_id", "day", "replaced_at");

-- AddForeignKey
ALTER TABLE "delivery_day_versions" ADD CONSTRAINT "delivery_day_versions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
