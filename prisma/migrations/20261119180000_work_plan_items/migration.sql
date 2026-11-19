-- FactorySuite work plan lines, one row per plan line (keyed by FactorySuite's
-- line id), kept current by the work plan watch
-- (src/modules/planner/work-plan-watch.ts). Operator 2026-11-19: "if an item
-- was drafted and awaiting approval we should update it based on the new
-- changes either accepted or rejected no point of having duplicates records";
-- "let it be dynamic but ensure that we don't get a duplicated on the plan
-- line". So each row is updated in place, and a machine can be on any number
-- of plans.
--
-- New table only: no lock on anything existing.

SET lock_timeout = '5s';

CREATE TABLE "factorysuite_work_plan_items" (
    "id"                TEXT NOT NULL,
    "organisation_id"   TEXT NOT NULL,
    "factory_code"      TEXT NOT NULL,
    "day"               TEXT NOT NULL,
    "machine"           TEXT NOT NULL,
    "shift_no"          INTEGER,
    "plan_id"           TEXT NOT NULL,
    "plan_code"         TEXT NOT NULL,
    "department"        TEXT,
    "status"            TEXT NOT NULL,
    "line_id"           TEXT NOT NULL,
    "task_id"           TEXT,
    "line"              JSONB NOT NULL,
    "reviewed_by"       TEXT,
    "reviewed_at"       TEXT,
    "previous_status"   TEXT,
    "status_changed_at" TIMESTAMP(3),
    "last_edits"        JSONB,
    "edited_at"         TIMESTAMP(3),
    "first_seen_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "factorysuite_work_plan_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "factorysuite_work_plan_items_organisation_id_fkey" FOREIGN KEY ("organisation_id")
        REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "factorysuite_work_plan_items_organisation_id_day_idx" ON "factorysuite_work_plan_items"("organisation_id", "day");
CREATE UNIQUE INDEX "factorysuite_work_plan_items_factory_code_line_id_key" ON "factorysuite_work_plan_items"("factory_code", "line_id");
CREATE INDEX "factorysuite_work_plan_items_factory_code_day_idx" ON "factorysuite_work_plan_items"("factory_code", "day");
