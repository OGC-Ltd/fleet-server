-- Repair reports: what a technician did to the faulty units on a given trip.
--
-- Two tables, because the batch and the job have different lifetimes. One
-- report is filed and emailed once; its items are signed off one at a time,
-- days apart, as spares arrive. Folding them into one table would copy the
-- reporter, the timestamp and the email status onto every line, and then
-- "was this report emailed?" has N answers instead of one.
--
-- Strings with CHECK constraints rather than Postgres enums, matching
-- sensor_fault_episodes.kind/severity/source. An enum here would need an
-- ALTER TYPE the first time somebody wants a fourth outcome, and ALTER TYPE
-- is the kind of thing that goes wrong at 6am.
--
-- APPLY THIS BEFORE THE CODE THAT NAMES IT DEPLOYS. Both tables are new, so
-- the blast radius of getting it wrong is this feature alone rather than
-- every write in the system — but the order is the order, and the next person
-- reading this runbook must not learn an exception.

CREATE TABLE "repair_reports" (
    "id"              TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "reported_by_id"  TEXT NOT NULL,
    "reported_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note"            TEXT,
    "email_status"    TEXT NOT NULL DEFAULT 'pending',
    "email_sent_at"   TIMESTAMP(3),
    "email_detail"    JSONB,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repair_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repair_reports_organisation_id_reported_at_idx"
    ON "repair_reports"("organisation_id", "reported_at");
CREATE INDEX "repair_reports_reported_by_id_reported_at_idx"
    ON "repair_reports"("reported_by_id", "reported_at");

ALTER TABLE "repair_reports"
    ADD CONSTRAINT "repair_reports_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "repair_reports"
    ADD CONSTRAINT "repair_reports_reported_by_id_fkey"
    FOREIGN KEY ("reported_by_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "repair_report_items" (
    "id"               TEXT NOT NULL,
    "report_id"        TEXT NOT NULL,
    "organisation_id"  TEXT NOT NULL,
    "target_kind"      TEXT NOT NULL,
    "vehicle_id"       TEXT NOT NULL,
    "fault_episode_id" TEXT,
    "fault_kind"       TEXT,
    "outcome"          TEXT NOT NULL,
    "spare_part"       TEXT,
    "problem_note"     TEXT,
    "resolved_at"      TIMESTAMP(3),
    "resolved_by_id"   TEXT,
    "fix_note"         TEXT,
    "recommendation"   TEXT,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repair_report_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "repair_report_items_report_id_idx"
    ON "repair_report_items"("report_id");
CREATE INDEX "repair_report_items_organisation_id_resolved_at_idx"
    ON "repair_report_items"("organisation_id", "resolved_at");
CREATE INDEX "repair_report_items_vehicle_id_created_at_idx"
    ON "repair_report_items"("vehicle_id", "created_at");

ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_report_id_fkey"
    FOREIGN KEY ("report_id") REFERENCES "repair_reports"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_resolved_by_id_fkey"
    FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_fault_episode_id_fkey"
    FOREIGN KEY ("fault_episode_id") REFERENCES "sensor_fault_episodes"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The rules the UI also enforces, restated where they cannot be bypassed. Zod
-- guards the API so a person gets a field-named 400; these guard the database
-- against the next caller, including a backfill script written in a hurry.
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_target_kind_check"
    CHECK ("target_kind" IN ('probe', 'fault'));
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_outcome_check"
    CHECK ("outcome" IN ('fixed', 'needs_spare', 'cannot_fix'));
-- "Needs a spare part" with no part named is a request nobody can action.
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_spare_part_check"
    CHECK ("outcome" <> 'needs_spare'
           OR ("spare_part" IS NOT NULL AND length(btrim("spare_part")) > 0));
-- A fault item must name its episode; a probe item must not pretend to have
-- one, because probe health is computed and there is no episode to name.
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_target_pairing_check"
    CHECK (("target_kind" = 'fault' AND "fault_episode_id" IS NOT NULL)
        OR ("target_kind" = 'probe' AND "fault_episode_id" IS NULL));

-- One OPEN job per target.
--
-- Two technicians reporting the same dead probe on the same morning is the
-- normal failure here, not an exotic one, and it doubles the spare-part order
-- downstream. PARTIAL, so a unit repaired five times over a year keeps five
-- closed rows — it is only the outstanding work that must be unique.
--
-- NOTE: Prisma cannot express a partial unique index, so this exists only in
-- this file. A `db pull` will not see it and a diff may offer to drop it.
CREATE UNIQUE INDEX "repair_report_items_open_target_uniq"
    ON "repair_report_items"("vehicle_id", "target_kind", COALESCE("fault_episode_id", ''))
    WHERE "resolved_at" IS NULL;
