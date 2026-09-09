-- Sales dispatches: the /sales lifecycle at Naitiri, alongside the original
-- cane /dispatches, in one table with a discriminator.
--
-- Existing rows are all cane dispatches, so the default backfills them without
-- a rewrite of the data — the column is NOT NULL with a default, which Postgres
-- adds as a catalogue-only change on 11+.
CREATE TYPE "DispatchKind" AS ENUM ('CANE', 'SALES');

ALTER TABLE "dispatches"
  ADD COLUMN "kind"                "DispatchKind" NOT NULL DEFAULT 'CANE',
  ADD COLUMN "tonnage_t"           DOUBLE PRECISION,
  ADD COLUMN "sign_out_photo_url"  TEXT,
  ADD COLUMN "return_photo_url"    TEXT;

-- "What is open right now for this org, of this kind" — the tooltip and the
-- sales feed both ask it, and without `kind` leading, a fleet that is mostly
-- cane makes the sales query scan the cane rows to discard them.
CREATE INDEX "dispatches_organisation_id_kind_dispatched_at_idx"
  ON "dispatches" ("organisation_id", "kind", "dispatched_at");
