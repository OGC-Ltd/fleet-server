-- Controltech EA vehicle registry columns (2026-07-25 live cutover):
--   external_id — the provider's vehicle UUID, stable upsert key for sync:vehicles
--   status      — registry status as reported by the provider
--   is_active   — false when decommissioned/dropped upstream; excluded from the live fleet
ALTER TABLE "vehicles"
  ADD COLUMN "external_id" TEXT,
  ADD COLUMN "status" TEXT,
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX "vehicles_external_id_key" ON "vehicles"("external_id");
