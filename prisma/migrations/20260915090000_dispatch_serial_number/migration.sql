-- The gate's own document number for a run.
--
-- Additive and nullable: nothing writes it yet. The provider's /sales payload
-- carries no such field (see webhooks/raifactorysuite-events' SaleEvent), so
-- this exists so a value has somewhere to land the day one is sent, rather
-- than the UI falling back to the internal UUID — which is not a number
-- anybody at a gate can check a truck against.
ALTER TABLE "dispatches" ADD COLUMN "serial_number" TEXT;
