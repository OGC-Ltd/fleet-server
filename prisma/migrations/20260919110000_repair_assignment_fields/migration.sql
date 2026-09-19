-- Add the assignment handoff columns that predate assignment responses.
-- These are nullable because existing repair jobs were filed before triage
-- existed and have no assignee yet.

ALTER TABLE "repair_report_items"
  ADD COLUMN "assigned_to_id" TEXT,
  ADD COLUMN "assigned_at" TIMESTAMP(3),
  ADD COLUMN "assigned_by_id" TEXT,
  ADD COLUMN "assignment_note" TEXT;

ALTER TABLE "repair_report_items"
  ADD CONSTRAINT "repair_report_items_assigned_to_id_fkey"
  FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "repair_report_items"
  ADD CONSTRAINT "repair_report_items_assigned_by_id_fkey"
  FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "repair_report_items_organisation_id_assigned_to_id_idx"
  ON "repair_report_items"("organisation_id", "assigned_to_id");
