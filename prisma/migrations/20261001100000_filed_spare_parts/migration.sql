SET lock_timeout = '5s';

-- A part named when a job was filed with the outcome "Needs a spare part" is an order
-- (operator, 2026-10-01). New jobs get the RepairSparePart row at filing
-- (repairs.repository createReport); this backfills the OPEN jobs that name a
-- part and have no part rows yet, so their Spare parts column shows it.
-- Signed-off jobs are left alone: their overhaul can no longer change.
INSERT INTO "repair_spare_parts"
  ("id", "organisation_id", "repair_item_id", "name", "quantity", "expected_at",
   "status", "note", "ordered_by_id", "ordered_by_name", "ordered_at", "updated_at")
SELECT 'rsp_' || replace(gen_random_uuid()::text, '-', ''),
       i."organisation_id", i."id", i."spare_part", 1, i."expected_resolution_at",
       'ordered', 'Filed as: Needs a spare part', r."reported_by_id", u."full_name",
       i."created_at", now()
  FROM "repair_report_items" i
  JOIN "repair_reports" r ON r."id" = i."report_id"
  LEFT JOIN "users" u ON u."id" = r."reported_by_id"
 WHERE i."outcome" = 'needs_spare'
   AND i."spare_part" IS NOT NULL AND btrim(i."spare_part") <> ''
   AND i."resolved_at" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "repair_spare_parts" p WHERE p."repair_item_id" = i."id");
