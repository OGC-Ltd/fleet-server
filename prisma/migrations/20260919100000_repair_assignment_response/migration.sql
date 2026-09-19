-- Track whether the person receiving a repair assignment accepted or declined it.
-- Existing assignments are treated as accepted because this field did not exist
-- before the handoff workflow was introduced.

ALTER TABLE "repair_report_items"
  ADD COLUMN "assignment_status" TEXT NOT NULL DEFAULT 'accepted';

ALTER TABLE "repair_report_items"
  ADD CONSTRAINT "repair_report_items_assignment_status_check"
  CHECK ("assignment_status" IN ('pending', 'accepted', 'declined'))
  NOT VALID;

ALTER TABLE "repair_report_items"
  VALIDATE CONSTRAINT "repair_report_items_assignment_status_check";
