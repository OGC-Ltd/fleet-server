-- Weighbridge tickets from RaiFactorySuite's two weighment feeds.
--
-- The provider serves only about two days of tickets and cannot be asked for
-- more (measured 2026-09-10: every window inside the last month returns the
-- same 729 rows, dated the last two days). This table is therefore the only
-- history that will exist, so it is written by BOTH paths — the reconciler
-- poll and the `weighment.created` / `weighment.updated` webhook — converging
-- on the unique key below.
--
-- One table for both categories on purpose. A delivery is weighed twice at one
-- place; a transfer is weighed twice at a centre and twice again at the
-- factory. The shared columns hold the weighing that happened AT `center_code`
-- and the `factory_*` columns hold a transfer's second half, so every stat,
-- filter and grid on the weighbridge page is written once.

-- CreateEnum
CREATE TYPE "WeighmentCategory" AS ENUM ('CANE_DELIVERY', 'CANE_TRANSFER');

-- CreateTable
CREATE TABLE "weighments" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "category" "WeighmentCategory" NOT NULL,
    -- BIGINT: delivery tokens are already ten digits (1,000,893,559).
    "token_number" BIGINT NOT NULL,
    "token_at" TIMESTAMP(3) NOT NULL,
    "vehicle_no" TEXT NOT NULL,
    "vehicle_plate" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "driver_name" TEXT NOT NULL,
    "center_code" INTEGER NOT NULL,
    "center_name" TEXT NOT NULL,
    "gross_weight_kg" DOUBLE PRECISION,
    "gross_at" TIMESTAMP(3),
    "gross_operator" TEXT,
    "gross_bridge_no" INTEGER,
    "tare_weight_kg" DOUBLE PRECISION,
    "tare_at" TIMESTAMP(3),
    "tare_operator" TEXT,
    "tare_bridge_no" INTEGER,
    "net_weight_kg" DOUBLE PRECISION,
    "factory_gross_weight_kg" DOUBLE PRECISION,
    "factory_gross_at" TIMESTAMP(3),
    "factory_gross_operator" TEXT,
    "factory_gross_bridge_no" INTEGER,
    "factory_tare_weight_kg" DOUBLE PRECISION,
    "factory_tare_at" TIMESTAMP(3),
    "factory_tare_operator" TEXT,
    "factory_tare_bridge_no" INTEGER,
    "factory_net_weight_kg" DOUBLE PRECISION,
    "product_code" TEXT,
    "product_name" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'reconciler',

    CONSTRAINT "weighments_pkey" PRIMARY KEY ("id")
);

-- The ticket's identity at the provider. Token numbers are unique within a
-- category and not across them — deliveries run in the 1,000,000,000s and
-- transfers in the 1,000,000s, and nothing promises those ranges stay apart.
-- CreateIndex
CREATE UNIQUE INDEX "weighments_category_token_number_key" ON "weighments"("category", "token_number");

-- The page's own query: one centre, one day, newest first.
-- CreateIndex
CREATE INDEX "weighments_organisation_id_center_code_token_at_idx" ON "weighments"("organisation_id", "center_code", "token_at");

-- The stats strip and the all-centres view, which do not narrow by centre.
-- CreateIndex
CREATE INDEX "weighments_organisation_id_token_at_idx" ON "weighments"("organisation_id", "token_at");

-- "every ticket this lorry did today" — what the turnaround gaps are computed
-- from, and what a plate search matches.
-- CreateIndex
CREATE INDEX "weighments_organisation_id_vehicle_plate_token_at_idx" ON "weighments"("organisation_id", "vehicle_plate", "token_at");

-- AddForeignKey
ALTER TABLE "weighments" ADD CONSTRAINT "weighments_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ON DELETE SET NULL, not RESTRICT: a ticket is the factory's record of a
-- weighing and outlives our registry row for whatever lorry did it. Most
-- tickets have no vehicle_id at all — cane is hauled by contractors' lorries
-- that carry no tracker and appear in no fleet we hold.
-- AddForeignKey
ALTER TABLE "weighments" ADD CONSTRAINT "weighments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
