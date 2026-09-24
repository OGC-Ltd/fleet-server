-- Fuel follow-ups can be declined, and assigned by an administrator.
-- See FuelTheftFollowUp.assignedToId and fuel-followup.service.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FuelFollowUpActionKind" ADD VALUE 'ASSIGNED';
ALTER TYPE "FuelFollowUpActionKind" ADD VALUE 'DECLINED';

-- AlterTable
ALTER TABLE "fuel_theft_followups" ADD COLUMN     "assigned_at" TIMESTAMP(3),
ADD COLUMN     "assigned_by_id" TEXT,
ADD COLUMN     "assigned_to_id" TEXT;

-- AlterTable
ALTER TABLE "fuel_theft_followup_actions" ADD COLUMN     "subject_id" TEXT;

-- AddForeignKey
ALTER TABLE "fuel_theft_followups" ADD CONSTRAINT "fuel_theft_followups_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft_followups" ADD CONSTRAINT "fuel_theft_followups_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft_followup_actions" ADD CONSTRAINT "fuel_theft_followup_actions_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

