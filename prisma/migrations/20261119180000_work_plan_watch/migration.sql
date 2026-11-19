-- Watch FactorySuite's work plans for changes (operator, 2026-11-19: "we need
-- to ensure that we monitor any changes happening on the workplan from factory
-- suite"). FactorySuite sends no event when a plan is created, edited or
-- cancelled, so the watch keeps its last read of every plan and records what
-- differs on the next one. See src/modules/planner/work-plan-watch.ts.
--
--   factorysuite_work_plans         the last read of each plan, lines and all (raw)
--   factorysuite_work_plan_changes  one row per change found, newest last
--
-- New tables only: no lock on anything existing.

SET lock_timeout = '5s';

CREATE TABLE "factorysuite_work_plans" (
    "id"              TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "factory_code"    TEXT NOT NULL,
    "plan_code"       TEXT NOT NULL,
    "department"      TEXT,
    "day"             TEXT NOT NULL,
    "status"          TEXT NOT NULL,
    "raw"             JSONB NOT NULL,
    "first_seen_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gone_at"         TIMESTAMP(3),

    CONSTRAINT "factorysuite_work_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "factorysuite_work_plans_organisation_id_fkey" FOREIGN KEY ("organisation_id")
        REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "factorysuite_work_plans_factory_code_day_idx" ON "factorysuite_work_plans"("factory_code", "day");

CREATE TABLE "factorysuite_work_plan_changes" (
    "id"              TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "factory_code"    TEXT NOT NULL,
    "plan_id"         TEXT NOT NULL,
    "plan_code"       TEXT NOT NULL,
    "department"      TEXT,
    "day"             TEXT NOT NULL,
    "kind"            TEXT NOT NULL,
    "line_id"         TEXT,
    "task_id"         TEXT,
    "machine"         TEXT,
    "shift_no"        INTEGER,
    "field"           TEXT,
    "from_value"      TEXT,
    "to_value"        TEXT,
    "source"          TEXT NOT NULL,
    "event"           TEXT,
    "detected_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "factorysuite_work_plan_changes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "factorysuite_work_plan_changes_organisation_id_fkey" FOREIGN KEY ("organisation_id")
        REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "factorysuite_work_plan_changes_organisation_id_day_idx" ON "factorysuite_work_plan_changes"("organisation_id", "day");
CREATE INDEX "factorysuite_work_plan_changes_plan_id_idx" ON "factorysuite_work_plan_changes"("plan_id");
