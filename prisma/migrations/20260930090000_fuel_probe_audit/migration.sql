-- Fuel Audit: a fuel case can be decided as a faulty fuel probe. The case
-- raises (or joins) a probe job in Repairs and closes when that job is signed
-- off fixed. See FuelFollowUpStatus.PROBE_FAULT and fuel-followup.service.

-- Never queue an ALTER behind a long read on a hot table; fail fast instead.
SET lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "FuelFollowUpStatus" ADD VALUE 'PROBE_FAULT';
ALTER TYPE "FuelFollowUpStatus" ADD VALUE 'PROBE_FIXED';

ALTER TYPE "FuelFollowUpActionKind" ADD VALUE 'PROBE_FAULT';
ALTER TYPE "FuelFollowUpActionKind" ADD VALUE 'REPAIR_RAISED';
ALTER TYPE "FuelFollowUpActionKind" ADD VALUE 'REPAIR_FAILED';
ALTER TYPE "FuelFollowUpActionKind" ADD VALUE 'PROBE_FIXED';

ALTER TYPE "FuelAlertReview" ADD VALUE 'PROBE_FAULT';

-- AlterTable
ALTER TABLE "fuel_theft_followups" ADD COLUMN "repair_item_id" TEXT;

-- CreateIndex
CREATE INDEX "fuel_theft_followups_repair_item_id_idx" ON "fuel_theft_followups"("repair_item_id");

-- AddForeignKey
ALTER TABLE "fuel_theft_followups" ADD CONSTRAINT "fuel_theft_followups_repair_item_id_fkey"
    FOREIGN KEY ("repair_item_id") REFERENCES "repair_report_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A job raised by the audit carries the outcome 'audit': nobody has been out
-- to the unit yet. The CHECK is widened, never narrowed, so existing rows pass.
ALTER TABLE "repair_report_items"
    DROP CONSTRAINT "repair_report_items_outcome_check";
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_outcome_check"
    CHECK ("outcome" IN ('fixing', 'needs_spare', 'cannot_fix', 'audit'));
