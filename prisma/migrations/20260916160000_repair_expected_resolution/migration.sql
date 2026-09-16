-- When the technician expects the unit back in service — the "fix date".
--
-- A THIRD MIGRATION RATHER THAN AN EDIT to 20260916120000 or ...140000, for
-- the reason ...140000 states at length: Prisma checksums applied migrations,
-- so a rewritten file is safe only if you are right about every database in
-- existence, and a new file is always safe. Both predecessors ARE applied on
-- the shared RDS (verified by `prisma migrate status`, 2026-09-16) — which is
-- the opposite of what ...140000's header guessed, and the reason that rule
-- exists rather than being re-argued each time.
--
-- APPLY BEFORE the code that names `expected_resolution_at` deploys. A column
-- the client believes in and Postgres lacks breaks every write to the table,
-- because the generated client builds its RETURNING list from the schema.

-- ── 1. The column ────────────────────────────────────────────────────────────
--
-- DATE, not TIMESTAMP. The answer has day granularity — a technician says "the
-- 25th", and no part of this feature is better for pretending to know the hour.
-- A timestamp would also hand the value to a timezone: midnight on the 25th
-- read back through a client that localises first is the 24th for anyone west
-- of UTC, which is how a date field starts lying by one day. DATE has no such
-- conversion to get wrong.
--
-- NULLABLE, because it only means anything for one outcome. See the CHECK.

ALTER TABLE "repair_report_items"
    ADD COLUMN "expected_resolution_at" DATE;

-- ── 2. Required when a part is on order ──────────────────────────────────────
--
-- Same shape as the spare-part rule directly above it in this table, and for
-- the same reason. 'needs_spare' is the outcome that hands the job to somebody
-- else and then waits; a wait with no stated end cannot be chased, so
-- "outsourced" and "outsourced three weeks ago" look identical on the Repairs
-- tab. The fix date is what makes the second one visible.
--
-- ## NOT VALID, then VALIDATE — and why it is two statements
--
-- A plain ADD CONSTRAINT checks every row already in the table and fails the
-- migration if one of them violates it. The obvious repair for that is to
-- UPDATE the offenders into compliance first, and an earlier draft of this
-- file did exactly that: it rewrote any dateless 'needs_spare' row to
-- 'cannot_fix' and appended an explanatory note.
--
-- That is REWRITING SOMEBODY'S REPAIR REPORT to make a schema change go
-- through, and it is the wrong trade at any row count. A technician's recorded
-- finding is a statement about a vehicle that somebody may act on; a migration
-- has no standing to overrule it because a column was added later.
--
-- So instead:
--
--   NOT VALID   attaches the rule to every future INSERT and UPDATE without
--               examining a single existing row. It cannot fail, it takes no
--               lengthy lock, and it destroys nothing.
--
--   VALIDATE    then checks the existing rows as a separate, non-blocking
--               scan. On a clean table it succeeds and the constraint ends up
--               indistinguishable from one added the plain way.
--
-- If VALIDATE fails, it fails LOUDLY and the whole migration rolls back —
-- Prisma wraps each file in a transaction. That is the correct outcome: it
-- means real rows predate the rule, and what to do with them is a decision for
-- the person who owns that data, not for this file. Nothing has been lost and
-- the table is exactly as it was.
--
-- What this deliberately does NOT constrain:
--
--   * The other two outcomes. They MAY carry a date — a technician mid-repair
--     who knows the job runs to Thursday is telling the truth, and rejecting
--     it would be the constraint inventing a rule nobody asked for. The
--     dashboard only offers the field for 'needs_spare'; this is the floor,
--     not the UI.
--
--   * How far out it is. "Not in the past" and "not five years out" are real
--     rules and they live in zod (repairs.schema.ts), not here: a CHECK that
--     compares to now() is not immutable, which makes the table's validity a
--     function of the clock and breaks a dump/restore of rows that were
--     perfectly legal when written.

ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_expected_resolution_check"
    CHECK ("outcome" <> 'needs_spare' OR "expected_resolution_at" IS NOT NULL)
    NOT VALID;

ALTER TABLE "repair_report_items"
    VALIDATE CONSTRAINT "repair_report_items_expected_resolution_check";

-- ── 3. The overdue scan ──────────────────────────────────────────────────────
--
-- "What has gone quiet" — the Repairs tab sorts open jobs by this. PARTIAL, so
-- it covers only the rows that question is ever asked about: resolved jobs are
-- history and nothing chases them, and a job with no date cannot be overdue.

CREATE INDEX "repair_report_items_expected_resolution_idx"
    ON "repair_report_items"("organisation_id", "expected_resolution_at")
    WHERE "resolved_at" IS NULL AND "expected_resolution_at" IS NOT NULL;
