SET lock_timeout = '5s';

-- Vehicle Support and Repair Workflow (docs/vehicle-support-repair-workflow-plan.md).
--
-- The repair job (repair_report_items) stays the single object. A Control
-- Room flag, the ControlTech queue, the remote/physical decision, the
-- assessment, the workshop booking, the ticket number, the damage class, the
-- completion and the Control Room's verification are all columns on it or
-- rows beside it. Additive: every existing row passes every new CHECK.

-- ── The job ────────────────────────────────────────────────────────────────

ALTER TABLE "repair_report_items"
    ADD COLUMN "fault_category"            TEXT,
    ADD COLUMN "suspected_fault"           TEXT,
    ADD COLUMN "queue"                     TEXT,
    ADD COLUMN "forwarded_at"              TIMESTAMP(3),
    ADD COLUMN "path"                      TEXT,
    ADD COLUMN "path_note"                 TEXT,
    ADD COLUMN "path_decided_by_id"        TEXT,
    ADD COLUMN "path_decided_at"           TIMESTAMP(3),
    ADD COLUMN "ticket_no"                 TEXT,
    ADD COLUMN "ticket_issued_at"          TIMESTAMP(3),
    ADD COLUMN "workshop_technician_id"    TEXT,
    ADD COLUMN "workshop_technician_name"  TEXT,
    ADD COLUMN "diagnosis"                 TEXT,
    ADD COLUMN "damage_class"              TEXT,
    ADD COLUMN "damage_note"               TEXT,
    ADD COLUMN "damage_classified_by_id"   TEXT,
    ADD COLUMN "damage_classified_at"      TIMESTAMP(3),
    ADD COLUMN "warranty_void"             BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "warranty_void_note"        TEXT,
    ADD COLUMN "warranty_void_components"  TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN "warranty_voided_by_id"     TEXT,
    ADD COLUMN "warranty_voided_at"        TIMESTAMP(3),
    ADD COLUMN "completed_at"              TIMESTAMP(3),
    ADD COLUMN "completed_by_id"           TEXT,
    ADD COLUMN "test_result"               TEXT,
    ADD COLUMN "test_note"                 TEXT,
    ADD COLUMN "verified_at"               TIMESTAMP(3),
    ADD COLUMN "verified_by_id"            TEXT,
    ADD COLUMN "verify_note"               TEXT,
    ADD COLUMN "void_reason"               TEXT,
    ADD COLUMN "preceded_by_id"            TEXT;

-- Postgres's own copy of the ticket rule: issued once, never reused.
CREATE UNIQUE INDEX "repair_report_items_ticket_no_key" ON "repair_report_items"("ticket_no");
CREATE SEQUENCE IF NOT EXISTS "repair_ticket_seq" START 1;

CREATE INDEX "repair_report_items_organisation_id_queue_idx"
    ON "repair_report_items"("organisation_id", "queue") WHERE "resolved_at" IS NULL;

ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_workshop_technician_id_fkey"
    FOREIGN KEY ("workshop_technician_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_preceded_by_id_fkey"
    FOREIGN KEY ("preceded_by_id") REFERENCES "repair_report_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 'flagged': the Control Room raised it; nobody has been out yet.
ALTER TABLE "repair_report_items" DROP CONSTRAINT "repair_report_items_outcome_check";
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_outcome_check"
    CHECK ("outcome" IN ('fixing', 'needs_spare', 'cannot_fix', 'audit', 'flagged'));

-- 'unit': a fault flagged on the unit itself by category (engine, brakes,
-- tracker, ...). Neither a probe (computed health) nor a fault episode.
ALTER TABLE "repair_report_items" DROP CONSTRAINT "repair_report_items_target_kind_check";
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_target_kind_check"
    CHECK ("target_kind" IN ('probe', 'fault', 'unit'));
ALTER TABLE "repair_report_items" DROP CONSTRAINT "repair_report_items_target_pairing_check";
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_target_pairing_check"
    CHECK (("target_kind" = 'fault' AND "fault_episode_id" IS NOT NULL)
        OR ("target_kind" IN ('probe', 'unit') AND "fault_episode_id" IS NULL));

ALTER TABLE "repair_report_items" DROP CONSTRAINT "repair_report_items_stage_check";
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_stage_check"
    CHECK ("stage" IN ('pending', 'forwarded', 'remote_fix', 'awaiting_assessment', 'booked',
                       'towing', 'field_inspection', 'in_workshop', 'spare_outsourced', 'fixing',
                       'completed', 'fixed', 'failed', 'void'));

-- A voided job is closed, like a signed-off one.
ALTER TABLE "repair_report_items" DROP CONSTRAINT "repair_report_items_stage_resolution_check";
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_stage_resolution_check"
    CHECK (("resolved_at" IS     NULL AND "stage" NOT IN ('fixed', 'void'))
        OR ("resolved_at" IS NOT NULL AND "stage" IN ('fixed', 'failed', 'void')));

ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_fault_category_check"
    CHECK ("fault_category" IS NULL OR "fault_category" IN (
        'fuel_probe', 'tracker', 'sensor',
        'engine', 'transmission', 'brakes', 'suspension_steering', 'tyres',
        'electrical', 'hydraulics', 'body', 'other'));
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_flag_check"
    CHECK ("outcome" <> 'flagged'
        OR ("fault_category" IS NOT NULL AND "suspected_fault" IS NOT NULL
            AND length(btrim("suspected_fault")) > 0));
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_queue_check"
    CHECK ("queue" IS NULL OR "queue" IN ('controltech', 'workshop'));
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_path_check"
    CHECK ("path" IS NULL OR "path" IN ('remote', 'physical'));
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_damage_class_check"
    CHECK ("damage_class" IS NULL OR "damage_class" IN ('genuine', 'suspected_malicious'));
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_damage_note_check"
    CHECK ("damage_class" IS DISTINCT FROM 'suspected_malicious'
        OR ("damage_note" IS NOT NULL AND length(btrim("damage_note")) > 0));
-- A warranty is voided only for suspected malicious damage, and always with a note.
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_warranty_void_check"
    CHECK (NOT "warranty_void"
        OR ("damage_class" = 'suspected_malicious'
            AND "warranty_void_note" IS NOT NULL AND length(btrim("warranty_void_note")) > 0));
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_test_result_check"
    CHECK ("test_result" IS NULL OR "test_result" IN ('pass', 'fail'));
-- Rule 8: a workflow job reaches 'fixed' only through the Control Room's verification.
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_verified_fixed_check"
    CHECK ("outcome" <> 'flagged' OR "stage" <> 'fixed' OR "verified_at" IS NOT NULL);

-- Old jobs pick the right checklist.
UPDATE "repair_report_items" SET "fault_category" = 'fuel_probe'
 WHERE "fault_category" IS NULL AND ("target_kind" = 'probe' OR "fault_kind" = 'fuel_probe_dead');
UPDATE "repair_report_items" SET "fault_category" = 'sensor'
 WHERE "fault_category" IS NULL AND "target_kind" = 'fault';

-- One open job per target, and for a 'unit' flag the category is part of the
-- target: an open brake job and an open engine job on one truck, never two
-- brake jobs. Rebuilt with the same name; the old key is a prefix of the new.
DROP INDEX "repair_report_items_open_target_uniq";
CREATE UNIQUE INDEX "repair_report_items_open_target_uniq"
    ON "repair_report_items"("vehicle_id", "target_kind", COALESCE("fault_episode_id", ''),
        (CASE WHEN "target_kind" = 'unit' THEN COALESCE("fault_category", '') ELSE '' END))
    WHERE "resolved_at" IS NULL;

-- ── The checklist becomes data ─────────────────────────────────────────────
-- Components per fault category live in repairs.workflow.schema.ts (zod). The
-- five probe components stay valid.
ALTER TABLE "repair_inspections" DROP CONSTRAINT "repair_inspections_component_check";

-- ── Spare parts by source ──────────────────────────────────────────────────
ALTER TABLE "repair_spare_parts"
    ADD COLUMN "source"         TEXT NOT NULL DEFAULT 'controltech',
    ADD COLUMN "requested_at"   TIMESTAMP(3),
    ADD COLUMN "issued_by_id"   TEXT,
    ADD COLUMN "issued_by_name" TEXT,
    ADD COLUMN "issued_at"      TIMESTAMP(3),
    ADD COLUMN "fs_store"       TEXT,
    ADD COLUMN "fs_item_code"   TEXT,
    ADD COLUMN "fs_issue_id"    TEXT,
    ADD COLUMN "order_ref"      TEXT;
ALTER TABLE "repair_spare_parts"
    ADD CONSTRAINT "repair_spare_parts_source_check"
    CHECK ("source" IN ('inventory', 'controltech'));
ALTER TABLE "repair_spare_parts" DROP CONSTRAINT "repair_spare_parts_status_check";
ALTER TABLE "repair_spare_parts"
    ADD CONSTRAINT "repair_spare_parts_status_check"
    CHECK ("status" IN ('requested', 'ordered', 'received', 'issued', 'fitted', 'cancelled'));

-- ── Assessments ────────────────────────────────────────────────────────────
CREATE TABLE "repair_assessments" (
    "id"                  TEXT NOT NULL,
    "organisation_id"     TEXT NOT NULL,
    "repair_item_id"      TEXT NOT NULL,
    "roadworthy"          BOOLEAN NOT NULL,
    "intervention"        TEXT NOT NULL,
    "reason"              TEXT,
    "intervention_detail" JSONB,
    "assessed_by_id"      TEXT,
    "assessed_by_name"    TEXT,
    "assessed_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "repair_assessments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repair_assessments_intervention_check"
        CHECK ("intervention" IN ('workshop', 'tow', 'field_inspection')),
    -- An immobile unit is always assessed with a reason, and only a roadworthy
    -- one is driven to the workshop.
    CONSTRAINT "repair_assessments_reason_check"
        CHECK ("roadworthy" OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0)),
    CONSTRAINT "repair_assessments_roadworthy_check"
        CHECK ("roadworthy" = ("intervention" = 'workshop'))
);
CREATE INDEX "repair_assessments_repair_item_id_idx" ON "repair_assessments"("repair_item_id");
ALTER TABLE "repair_assessments" ADD CONSTRAINT "repair_assessments_repair_item_id_fkey"
    FOREIGN KEY ("repair_item_id") REFERENCES "repair_report_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Workshops and bookings ─────────────────────────────────────────────────
CREATE TABLE "workshops" (
    "id"              TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "name"            TEXT NOT NULL,
    -- Booked vehicles a day (operator, 2026-10-20: "3 is for vehicles per day").
    "daily_capacity"  INTEGER NOT NULL DEFAULT 3,
    "location"        TEXT,
    "is_active"       BOOLEAN NOT NULL DEFAULT true,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workshops_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workshops_daily_capacity_check" CHECK ("daily_capacity" >= 0)
);
CREATE INDEX "workshops_organisation_id_idx" ON "workshops"("organisation_id");
ALTER TABLE "workshops" ADD CONSTRAINT "workshops_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "workshop_bookings" (
    "id"              TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "workshop_id"     TEXT NOT NULL,
    "repair_item_id"  TEXT NOT NULL,
    "booking_date"    DATE NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'booked',
    "booked_by_id"    TEXT,
    "booked_by_name"  TEXT,
    "booked_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrived_at"      TIMESTAMP(3),
    "cancel_reason"   TEXT,
    "cancelled_at"    TIMESTAMP(3),
    CONSTRAINT "workshop_bookings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workshop_bookings_status_check"
        CHECK ("status" IN ('booked', 'arrived', 'cancelled', 'no_show'))
);
-- The cap's count, per workshop per day.
CREATE INDEX "workshop_bookings_workshop_id_booking_date_idx" ON "workshop_bookings"("workshop_id", "booking_date");
CREATE INDEX "workshop_bookings_repair_item_id_idx" ON "workshop_bookings"("repair_item_id");
-- One live booking per job. Prisma cannot express this partial index.
CREATE UNIQUE INDEX "workshop_bookings_live_job_uniq"
    ON "workshop_bookings"("repair_item_id") WHERE "status" IN ('booked', 'arrived');
ALTER TABLE "workshop_bookings" ADD CONSTRAINT "workshop_bookings_workshop_id_fkey"
    FOREIGN KEY ("workshop_id") REFERENCES "workshops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workshop_bookings" ADD CONSTRAINT "workshop_bookings_repair_item_id_fkey"
    FOREIGN KEY ("repair_item_id") REFERENCES "repair_report_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Security investigations ────────────────────────────────────────────────
-- Opened with a suspected-malicious classification. Never consulted by any
-- repair guard: the repair goes ahead regardless.
CREATE TABLE "security_investigations" (
    "id"              TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "repair_item_id"  TEXT NOT NULL,
    "vehicle_id"      TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'open',
    "opened_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by_id"    TEXT,
    "assigned_to_id"  TEXT,
    "findings"        TEXT,
    "closed_at"       TIMESTAMP(3),
    "closed_by_id"    TEXT,
    "history"         JSONB,
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "security_investigations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "security_investigations_status_check"
        CHECK ("status" IN ('open', 'investigating', 'closed_confirmed', 'closed_unfounded'))
);
CREATE UNIQUE INDEX "security_investigations_repair_item_id_key" ON "security_investigations"("repair_item_id");
CREATE INDEX "security_investigations_organisation_id_status_idx" ON "security_investigations"("organisation_id", "status");
ALTER TABLE "security_investigations" ADD CONSTRAINT "security_investigations_repair_item_id_fkey"
    FOREIGN KEY ("repair_item_id") REFERENCES "repair_report_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_investigations" ADD CONSTRAINT "security_investigations_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "security_investigations" ADD CONSTRAINT "security_investigations_assigned_to_id_fkey"
    FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Work log ───────────────────────────────────────────────────────────────
CREATE TABLE "repair_work_entries" (
    "id"              TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "repair_item_id"  TEXT NOT NULL,
    "at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id"           TEXT,
    "by_name"         TEXT,
    "kind"            TEXT NOT NULL,
    "text"            TEXT NOT NULL,
    "labour_minutes"  INTEGER,
    CONSTRAINT "repair_work_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repair_work_entries_kind_check" CHECK ("kind" IN ('diagnosis', 'repair', 'test', 'note')),
    CONSTRAINT "repair_work_entries_text_check" CHECK (length(btrim("text")) > 0),
    CONSTRAINT "repair_work_entries_labour_check" CHECK ("labour_minutes" IS NULL OR "labour_minutes" >= 0)
);
CREATE INDEX "repair_work_entries_repair_item_id_at_idx" ON "repair_work_entries"("repair_item_id", "at");
ALTER TABLE "repair_work_entries" ADD CONSTRAINT "repair_work_entries_repair_item_id_fkey"
    FOREIGN KEY ("repair_item_id") REFERENCES "repair_report_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Permissions ────────────────────────────────────────────────────────────
INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
SELECT 'perm_' || replace(gen_random_uuid()::text, '-', ''), v.name, v.slug, v.resource, v.action
  FROM (VALUES
    ('Flag a unit for repair',                              'repair:flag',          'repair', 'flag'),
    ('Assess whether a unit can reach the workshop',        'repair:assess',        'repair', 'assess'),
    ('Book a unit into the workshop and record its arrival','repair:book',          'repair', 'book'),
    ('Claim a job from the ControlTech queue',              'repair:claim',         'repair', 'claim'),
    ('Verify a completed repair, or void a job',            'repair:verify',        'repair', 'verify'),
    ('Issue a spare part from stores',                      'repair:parts_issue',   'repair', 'parts_issue'),
    ('Source a requested spare part',                       'repair:parts_source',  'repair', 'parts_source'),
    ('View security investigations',                        'security_case:read',   'security_case', 'read'),
    ('Update security investigations',                      'security_case:update', 'security_case', 'update')
  ) AS v(name, slug, resource, action)
ON CONFLICT ("slug") DO NOTHING;

-- The Control Room (operator, 2026-10-20: "supervisor, analyst, and operator")
-- flag and book; only the supervisor of the three assesses and verifies.
-- Every role holding ORG_EVERYTHING gets the lot.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" IN ('repair:read', 'repair:flag', 'repair:book')
 WHERE r."slug" IN ('supervisor', 'fleet_analyst', 'operator')
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" IN ('repair:assess', 'repair:verify')
 WHERE r."slug" = 'supervisor'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" IN ('repair:flag', 'repair:assess', 'repair:book', 'repair:verify',
                                       'repair:parts_issue', 'repair:parts_source')
 WHERE r."slug" IN ('admin', 'hos', 'manager', 'fleet_manager', 'director')
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" IN ('repair:claim', 'repair:parts_source')
 WHERE r."slug" = 'technician'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" IN ('security_case:read', 'security_case:update')
 WHERE r."slug" IN ('head_of_security', 'admin')
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" = 'security_case:read'
 WHERE r."slug" = 'asst_head_of_security'
ON CONFLICT DO NOTHING;
