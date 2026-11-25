SET lock_timeout = '5s';

-- Each FactorySuite pump fuelling, kept as read (planner/fuel-issues.ts), so a
-- day's issued fuel stays on record. One new table, nothing altered. The
-- server fills it on its own after this is applied: the first reconcile pass
-- reads back to the start of FactorySuite's data, then every pass re-reads the
-- last few days, and a fuel.issue.* webhook asks for a pass at once.

-- CreateTable
CREATE TABLE IF NOT EXISTS "factorysuite_fuel_issues" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "factory_code" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "machine" TEXT NOT NULL,
    "request_id" TEXT,
    "siv" TEXT,
    "litres" DOUBLE PRECISION,
    "fueling_start" TEXT,
    "fueling_end" TEXT,
    "completed" BOOLEAN,
    "row" JSONB NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gone_at" TIMESTAMP(3),

    CONSTRAINT "factorysuite_fuel_issues_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "factorysuite_fuel_issues_organisation_id_fkey" FOREIGN KEY ("organisation_id")
        REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "factorysuite_fuel_issues_factory_code_issue_id_key" ON "factorysuite_fuel_issues"("factory_code", "issue_id");
CREATE INDEX IF NOT EXISTS "factorysuite_fuel_issues_organisation_id_day_idx" ON "factorysuite_fuel_issues"("organisation_id", "day");
CREATE INDEX IF NOT EXISTS "factorysuite_fuel_issues_factory_code_day_idx" ON "factorysuite_fuel_issues"("factory_code", "day");
