SET lock_timeout = '5s';

-- Planner (operator, 11 Nov 2026): a truck's delivery sheet for a day, its
-- customers with their own geofences, and what happened at each stop. Three
-- new tables and two new permissions; nothing existing is altered.

CREATE TABLE "planner_customers" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "customer_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "geofence_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "planner_customers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "planner_customers_organisation_id_customer_code_key" ON "planner_customers"("organisation_id", "customer_code");
ALTER TABLE "planner_customers" ADD CONSTRAINT "planner_customers_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "delivery_plans" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "plate" TEXT NOT NULL,
    "driver_name" TEXT NOT NULL DEFAULT '',
    "driver_user_id" TEXT,
    "plan_date" DATE NOT NULL,
    "sheet_at" TIMESTAMP(3),
    "gate_pass" TEXT NOT NULL DEFAULT '',
    "till_no" TEXT NOT NULL DEFAULT '',
    "source_file" TEXT NOT NULL DEFAULT '',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "delivery_plans_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "delivery_plans_organisation_id_plan_date_idx" ON "delivery_plans"("organisation_id", "plan_date");
CREATE INDEX "delivery_plans_vehicle_id_plan_date_idx" ON "delivery_plans"("vehicle_id", "plan_date");
ALTER TABLE "delivery_plans" ADD CONSTRAINT "delivery_plans_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "delivery_plan_stops" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "rep" TEXT NOT NULL DEFAULT '',
    "customer_id" TEXT NOT NULL,
    "invoice_no" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(14,2),
    "tonnage" DECIMAL(10,3),
    "outcome" TEXT,
    "remarks" TEXT NOT NULL DEFAULT '',
    "outcome_by" TEXT,
    "outcome_at" TIMESTAMP(3),
    CONSTRAINT "delivery_plan_stops_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "delivery_plan_stops_plan_id_sequence_key" ON "delivery_plan_stops"("plan_id", "sequence");
CREATE INDEX "delivery_plan_stops_customer_id_idx" ON "delivery_plan_stops"("customer_id");
ALTER TABLE "delivery_plan_stops" ADD CONSTRAINT "delivery_plan_stops_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "delivery_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_plan_stops" ADD CONSTRAINT "delivery_plan_stops_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "planner_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Permissions: read with the Logbook's roles; write for the roles that run
-- dispatch and supervise it.
INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''), 'View delivery plans', 'planner:read', 'planner', 'read'),
       ('perm_' || replace(gen_random_uuid()::text, '-', ''), 'Upload delivery plans and mark stops', 'planner:write', 'planner', 'write')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
  FROM "role_permissions" rp
  JOIN "permissions" lp ON lp."id" = rp."permission_id" AND lp."slug" = 'logbook:read'
  JOIN "permissions" p  ON p."slug" = 'planner:read'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" = 'planner:write'
 WHERE r."slug" IN ('director', 'admin', 'hos', 'manager', 'fleet_manager',
                    'logistics_manager', 'dispatcher', 'supervisor')
ON CONFLICT DO NOTHING;
