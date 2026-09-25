-- Which provider factory wrote each weighbridge ticket. The feed grew Kabras
-- and Nzoia (West Kenya) beside Ndhiwa (Sukari) around 2026-09-17, and every
-- ticket had been filed under Sukari. See Weighment.factoryCode.

-- AlterTable
ALTER TABLE "weighments" ADD COLUMN "factory_code" TEXT;
