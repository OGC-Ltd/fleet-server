-- An administrator can take a fuel follow-up back from whoever holds it.
-- See FuelFollowUpActionKind.RECALLED and fuel-followup.service.recallFollowUp.

-- AlterEnum
ALTER TYPE "FuelFollowUpActionKind" ADD VALUE 'RECALLED';
