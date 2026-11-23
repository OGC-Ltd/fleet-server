SET lock_timeout = '5s';

-- A Control Tech run's driver now stays on the truck after the yard signs it
-- back in, until the truck's next dispatch (operator, 2026-11-23: "capture the
-- driver returned but do not unlink the vehicle from that driver until the
-- next dispatch"). The sign-in is kept here; `unassigned_at` becomes the next
-- run's start. See src/modules/vehicles/run-assignment.ts.
ALTER TABLE "vehicle_assignments" ADD COLUMN "returned_at" TIMESTAMP(3);

-- 1. The sign-in of every run already returned, from the dispatch log.
UPDATE "vehicle_assignments" a
SET    "returned_at" = d."actual_return_at"
FROM   "dispatches" d
WHERE  d."actual_return_at" IS NOT NULL
  AND  a."notes" = CASE WHEN d."kind"::text = 'SALES' THEN 'controltech:sale:' ELSE 'controltech:dispatch:' END || d."external_id";

-- 2. A cancelled run never took the truck.
UPDATE "vehicle_assignments" a
SET    "unassigned_at" = a."assigned_at"
FROM   "dispatches" d
WHERE  d."status" = 'CANCELLED'
  AND  a."notes" = CASE WHEN d."kind"::text = 'SALES' THEN 'controltech:sale:' ELSE 'controltech:dispatch:' END || d."external_id";

-- 3. Runs left open (no sign-in ever came) let go at the truck's next live run.
--    Until now readers ignored them 48 h after they began; that cut-off goes.
UPDATE "vehicle_assignments" a
SET    "unassigned_at" = n."next_at"
FROM (
  SELECT o."id",
         LEAST(
           (SELECT min(d."dispatched_at") FROM "dispatches" d
             WHERE d."vehicle_id" = o."vehicle_id" AND d."dispatched_at" > o."assigned_at" AND d."status" <> 'CANCELLED'),
           (SELECT min(b."assigned_at") FROM "vehicle_assignments" b
             WHERE b."vehicle_id" = o."vehicle_id" AND b."notes" LIKE 'controltech:%' AND b."assigned_at" > o."assigned_at"
               AND (b."unassigned_at" IS NULL OR b."unassigned_at" > b."assigned_at"))
         ) AS "next_at"
  FROM "vehicle_assignments" o
  WHERE o."notes" LIKE 'controltech:%' AND o."unassigned_at" IS NULL
) n
WHERE a."id" = n."id" AND n."next_at" IS NOT NULL;

-- 4. Each truck's LAST run, closed at its sign-in with nothing since: its
--    driver is back on the truck. Earlier runs keep their sign-in close, so
--    past duty and scorecards read as they did.
UPDATE "vehicle_assignments" a
SET    "unassigned_at" = NULL
WHERE  a."notes" LIKE 'controltech:%'
  AND  a."returned_at" IS NOT NULL
  AND  a."unassigned_at" = a."returned_at"
  AND  NOT EXISTS (SELECT 1 FROM "dispatches" d
                    WHERE d."vehicle_id" = a."vehicle_id" AND d."dispatched_at" > a."assigned_at" AND d."status" <> 'CANCELLED')
  AND  NOT EXISTS (SELECT 1 FROM "vehicle_assignments" b
                    WHERE b."vehicle_id" = a."vehicle_id" AND b."notes" LIKE 'controltech:%' AND b."assigned_at" > a."assigned_at"
                      AND (b."unassigned_at" IS NULL OR b."unassigned_at" > b."assigned_at"));
