-- Where a run STARTED. The provider records only a destination, so the origin
-- was previously assumed to be the owning org's yard — wrong for a unit that
-- loads at another organisation's factory, which is the normal case for sales.
--
-- Nullable with no default: rows written before this existed genuinely do not
-- know their origin, and backfilling them with a guess would be worse than the
-- blank. Readers fall back to the org yard exactly as they did.
ALTER TABLE "dispatches" ADD COLUMN "factory_code" TEXT;
