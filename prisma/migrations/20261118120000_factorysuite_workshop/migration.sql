-- FactorySuite's Auto Workshop feeds our repair workflow (operator, 2026-11-18:
-- "feed our workflow"). See docs/factorysuite-workshop-integration.md.
--
-- Four mirror tables hold what FactorySuite last said, keyed on its own ids,
-- so a re-read is an upsert and the sync can tell what changed:
--   factorysuite_job_cards      GET /workshop/job-cards   -> a repair job each
--   factorysuite_breakdowns     GET /workshop/breakdowns  -> a flag, until carded
--   factorysuite_requisitions   GET /workshop/requisitions (empty so far: raw)
--   factorysuite_parts          GET /workshop/parts       -> the stores part picker
--
-- A repair report raised by the integration has no user behind it, so
-- reported_by_id becomes nullable and `source` says who raised it instead.
-- An app report still needs its author (CHECK).
--
-- Additive and catalog-only on the existing tables (a nullable drop and a
-- column with a constant default), so no rewrite and no long lock.

SET lock_timeout = '5s';

ALTER TABLE "repair_reports" ALTER COLUMN "reported_by_id" DROP NOT NULL;
ALTER TABLE "repair_reports" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'app';
ALTER TABLE "repair_reports"
    ADD CONSTRAINT "repair_reports_source_check" CHECK ("source" IN ('app', 'factorysuite'));
ALTER TABLE "repair_reports"
    ADD CONSTRAINT "repair_reports_author_check" CHECK ("source" <> 'app' OR "reported_by_id" IS NOT NULL);

-- ── Job cards ───────────────────────────────────────────────────────────────
CREATE TABLE "factorysuite_job_cards" (
    "id"                 TEXT NOT NULL,
    "organisation_id"    TEXT NOT NULL,
    "factory_code"       TEXT NOT NULL,
    "card_number"        TEXT NOT NULL,
    "machine"            TEXT NOT NULL,
    "vehicle_id"         TEXT,
    "status"             TEXT NOT NULL,
    "source"             TEXT,
    "priority"           TEXT,
    "category"           TEXT,
    "reported_fault"     TEXT,
    "diagnosis"          TEXT,
    "checked_in_at"      TIMESTAMP(3),
    "confirmed_down_at"  TIMESTAMP(3),
    "repair_started_at"  TIMESTAMP(3),
    "parts_requested_at" TIMESTAMP(3),
    "parts_received_at"  TIMESTAMP(3),
    "work_completed_at"  TIMESTAMP(3),
    "released_at"        TIMESTAMP(3),
    "is_service"         BOOLEAN NOT NULL DEFAULT false,
    "service_type"       TEXT,
    "meter_in"           DOUBLE PRECISION,
    "meter_out"          DOUBLE PRECISION,
    "fuel_in"            DOUBLE PRECISION,
    "fuel_out"           DOUBLE PRECISION,
    "fuel_source_in"     TEXT,
    "fuel_source_out"    TEXT,
    "fuel_discrepancy"   BOOLEAN NOT NULL DEFAULT false,
    "labour_cost"        DOUBLE PRECISION,
    "parts_cost"         DOUBLE PRECISION,
    "raw"                JSONB NOT NULL,
    "repair_item_id"     TEXT,
    "applied_stage"      TEXT,
    "first_seen_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "factorysuite_job_cards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "factorysuite_job_cards_card_number_key" ON "factorysuite_job_cards"("card_number");
CREATE INDEX "factorysuite_job_cards_organisation_id_status_idx" ON "factorysuite_job_cards"("organisation_id", "status");
CREATE INDEX "factorysuite_job_cards_vehicle_id_checked_in_at_idx" ON "factorysuite_job_cards"("vehicle_id", "checked_in_at");
CREATE INDEX "factorysuite_job_cards_repair_item_id_idx" ON "factorysuite_job_cards"("repair_item_id");
ALTER TABLE "factorysuite_job_cards" ADD CONSTRAINT "factorysuite_job_cards_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "factorysuite_job_cards" ADD CONSTRAINT "factorysuite_job_cards_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "factorysuite_job_cards" ADD CONSTRAINT "factorysuite_job_cards_repair_item_id_fkey"
    FOREIGN KEY ("repair_item_id") REFERENCES "repair_report_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Breakdowns ──────────────────────────────────────────────────────────────
CREATE TABLE "factorysuite_breakdowns" (
    "id"              TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "factory_code"    TEXT NOT NULL,
    "machine"         TEXT NOT NULL,
    "vehicle_id"      TEXT,
    "reported_fault"  TEXT,
    "location"        TEXT,
    "status"          TEXT NOT NULL,
    "reported_at"     TIMESTAMP(3),
    "decided_at"      TIMESTAMP(3),
    "decision_note"   TEXT,
    "job_card_number" TEXT,
    "raw"             JSONB NOT NULL,
    "repair_item_id"  TEXT,
    "first_seen_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "factorysuite_breakdowns_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "factorysuite_breakdowns_organisation_id_reported_at_idx" ON "factorysuite_breakdowns"("organisation_id", "reported_at");
ALTER TABLE "factorysuite_breakdowns" ADD CONSTRAINT "factorysuite_breakdowns_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "factorysuite_breakdowns" ADD CONSTRAINT "factorysuite_breakdowns_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "factorysuite_breakdowns" ADD CONSTRAINT "factorysuite_breakdowns_repair_item_id_fkey"
    FOREIGN KEY ("repair_item_id") REFERENCES "repair_report_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Requisitions (no live row yet: kept raw until the shape is known) ──────
CREATE TABLE "factorysuite_requisitions" (
    "id"              TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "factory_code"    TEXT NOT NULL,
    "status"          TEXT,
    "job_card_number" TEXT,
    "raw"             JSONB NOT NULL,
    "first_seen_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "factorysuite_requisitions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "factorysuite_requisitions_organisation_id_idx" ON "factorysuite_requisitions"("organisation_id");
CREATE INDEX "factorysuite_requisitions_job_card_number_idx" ON "factorysuite_requisitions"("job_card_number");
ALTER TABLE "factorysuite_requisitions" ADD CONSTRAINT "factorysuite_requisitions_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Spare parts catalogue with stock ────────────────────────────────────────
CREATE TABLE "factorysuite_parts" (
    "id"               TEXT NOT NULL,
    "organisation_id"  TEXT NOT NULL,
    "factory_code"     TEXT NOT NULL,
    "part_number"      TEXT NOT NULL,
    "description"      TEXT,
    "unit"             TEXT,
    "quantity_on_hand" DOUBLE PRECISION,
    "minimum_level"    DOUBLE PRECISION,
    "unit_cost"        DOUBLE PRECISION,
    "supplier"         TEXT,
    "active"           BOOLEAN NOT NULL DEFAULT true,
    "synced_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "factorysuite_parts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "factorysuite_parts_organisation_id_part_number_idx" ON "factorysuite_parts"("organisation_id", "part_number");
ALTER TABLE "factorysuite_parts" ADD CONSTRAINT "factorysuite_parts_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
