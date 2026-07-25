-- Controltech EA driver registry columns (2026-07-26):
--   external_id — the provider's driver UUID, stable upsert key for sync:drivers
--   duty_status — provider duty state (ON_DUTY / OFF_DUTY / TERMINATED)
--   driver_type — provider driver class (TRACTOR / TRUCK / COMPANY_VEHICLE)
-- email becomes nullable: the provider holds no email addresses and synced
-- drivers do not log in. Postgres allows multiple NULLs under a unique index,
-- so existing logins are unaffected.
ALTER TABLE "users"
  ADD COLUMN "external_id" TEXT,
  ADD COLUMN "duty_status" TEXT,
  ADD COLUMN "driver_type" TEXT,
  ALTER COLUMN "email" DROP NOT NULL;

CREATE UNIQUE INDEX "users_external_id_key" ON "users"("external_id");
