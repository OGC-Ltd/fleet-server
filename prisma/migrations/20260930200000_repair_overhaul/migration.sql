-- Overhaul audit on a repair job: an inspection checklist and the spare parts
-- outsourced for the fix. See RepairInspection, RepairSparePart and
-- repairs.overhaul. New tables only; nothing existing is altered.

-- Never queue behind a long read on a hot table; fail fast instead.
SET lock_timeout = '5s';

CREATE TABLE "repair_inspections" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "repair_item_id" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "note" TEXT,
    "inspected_by_id" TEXT,
    "inspected_by_name" TEXT,
    "inspected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repair_inspections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repair_inspections_component_check"
        CHECK ("component" IN ('probe', 'probe_cable', 'tank_bracket', 'tracker', 'calibration')),
    CONSTRAINT "repair_inspections_verdict_check"
        CHECK ("verdict" IN ('ok', 'faulty', 'replaced'))
);

CREATE UNIQUE INDEX "repair_inspections_repair_item_id_component_key"
    ON "repair_inspections"("repair_item_id", "component");
CREATE INDEX "repair_inspections_organisation_id_idx" ON "repair_inspections"("organisation_id");

ALTER TABLE "repair_inspections" ADD CONSTRAINT "repair_inspections_repair_item_id_fkey"
    FOREIGN KEY ("repair_item_id") REFERENCES "repair_report_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "repair_spare_parts" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "repair_item_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "supplier" TEXT,
    "cost_kes" INTEGER,
    "expected_at" DATE,
    "status" TEXT NOT NULL DEFAULT 'ordered',
    "note" TEXT,
    "ordered_by_id" TEXT,
    "ordered_by_name" TEXT,
    "ordered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMP(3),
    "fitted_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "repair_spare_parts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repair_spare_parts_status_check"
        CHECK ("status" IN ('ordered', 'received', 'fitted', 'cancelled')),
    CONSTRAINT "repair_spare_parts_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "repair_spare_parts_cost_check" CHECK ("cost_kes" IS NULL OR "cost_kes" >= 0),
    CONSTRAINT "repair_spare_parts_name_check" CHECK (length(btrim("name")) > 0)
);

CREATE INDEX "repair_spare_parts_repair_item_id_idx" ON "repair_spare_parts"("repair_item_id");
CREATE INDEX "repair_spare_parts_organisation_id_status_idx" ON "repair_spare_parts"("organisation_id", "status");

ALTER TABLE "repair_spare_parts" ADD CONSTRAINT "repair_spare_parts_repair_item_id_fkey"
    FOREIGN KEY ("repair_item_id") REFERENCES "repair_report_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
