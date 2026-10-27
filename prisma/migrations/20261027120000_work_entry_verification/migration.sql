-- The Control Room logs verification on a completed job's work log (operator, 2026-10-27).
SET lock_timeout = '5s';
ALTER TABLE "repair_work_entries" DROP CONSTRAINT "repair_work_entries_kind_check";
ALTER TABLE "repair_work_entries" ADD CONSTRAINT "repair_work_entries_kind_check"
    CHECK ("kind" IN ('diagnosis', 'repair', 'test', 'note', 'verification'));
