-- The stage of a repair, and the rename that makes room for it.
--
-- A SECOND MIGRATION RATHER THAN AN EDIT TO 20260916120000. That one has not
-- shipped to the shared RDS yet, so editing it in place was tempting and would
-- have left a tidier history. It is refused for one reason: Prisma checksums
-- applied migrations, and a developer who applied the first one locally would
-- meet a hard failure on their next `migrate dev` with no obvious cause. A
-- second file is always safe; a rewritten one is safe only if you are right
-- about every database in existence.
--
-- APPLY AFTER 20260916120000_repair_item_stage's predecessor and BEFORE the
-- code that names `stage` deploys. Same rule as always.

-- ── 1. 'fixed' becomes 'fixing' ──────────────────────────────────────────────
--
-- Filing a report is not the end of the work, it is the start of it. The old
-- vocabulary said a technician "fixed" a unit at the moment they described
-- their trip, and then the job sat open for a fortnight waiting on a part. The
-- outcome now records what the technician DID on the day; `stage`, below,
-- records where the job actually is.
--
-- The UPDATE is for tidiness, not necessity: on an RDS that has not seen the
-- first migration there are no rows to move. It is here so this file is
-- correct on a database that HAS.

ALTER TABLE "repair_report_items"
    DROP CONSTRAINT "repair_report_items_outcome_check";

UPDATE "repair_report_items" SET "outcome" = 'fixing' WHERE "outcome" = 'fixed';

ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_outcome_check"
    CHECK ("outcome" IN ('fixing', 'needs_spare', 'cannot_fix'));

-- ── 2. The stage ─────────────────────────────────────────────────────────────
--
-- THREE COLUMNS FOR ONE CONCEPT, and each earns its place:
--
--   stage             where the job is now. The only one anything queries.
--   stage_changed_at  when it last moved. Sorting and "stuck for 3 weeks"
--                     without parsing JSON.
--   stage_history     how it got here: [{ stage, at, by, note? }].
--
-- The history is JSONB and not a table. A table would be the right answer if
-- anything ever had to JOIN against a past stage — nothing does. What reads it
-- is one detail panel drawing one tracking line for one item, which is exactly
-- the shape `repair_reports.email_detail` already uses next door. A stage
-- ladder without dates is a row of pills, not a tracking line, so the history
-- is what makes the feature the feature.

ALTER TABLE "repair_report_items"
    ADD COLUMN "stage"            TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN "stage_changed_at" TIMESTAMP(3),
    ADD COLUMN "stage_history"    JSONB;

-- Rows filed before this migration, placed where they would have landed had
-- the column always existed. `resolved_at` wins over the outcome: a job that
-- was signed off is finished whatever the technician first reported.
UPDATE "repair_report_items" SET
    "stage" = CASE
        WHEN "resolved_at" IS NOT NULL THEN 'fixed'
        WHEN "outcome" = 'fixing'      THEN 'fixing'
        WHEN "outcome" = 'cannot_fix'  THEN 'failed'
        ELSE 'pending'
    END,
    "stage_changed_at" = COALESCE("resolved_at", "created_at");

ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_stage_check"
    CHECK ("stage" IN ('pending', 'spare_outsourced', 'fixing', 'fixed', 'failed'));

-- The one rule tying the stage to the sign-off, in both directions.
--
-- OPEN ⇒ NOT 'fixed'. "Fixed" is a claim that somebody has to stand behind, so
-- it is reachable only through the resolve route, which demands an account of
-- what was done. No status button can assert it.
--
-- CLOSED ⇒ 'fixed' OR 'failed'. A signed-off job cannot still be pending.
--
-- Note what this deliberately ALLOWS: open AND 'failed'. That is the
-- `cannot_fix` seed — this technician could not fix it today, and that is not
-- the end of the unit's story. The job stays outstanding for somebody with
-- more kit, and the ladder can climb back out of 'failed'.
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_stage_resolution_check"
    CHECK (("resolved_at" IS     NULL AND "stage" <> 'fixed')
        OR ("resolved_at" IS NOT NULL AND "stage" IN ('fixed', 'failed')));

-- "What is stuck, and where" — the Repairs tab's stage filter.
CREATE INDEX "repair_report_items_organisation_id_stage_idx"
    ON "repair_report_items"("organisation_id", "stage");
