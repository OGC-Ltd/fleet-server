-- A deleted fuel alert opens a follow-up that another account must accept and
-- then escalate (confirmed theft) or de-escalate. See FuelTheftFollowUp.
-- Every alert also carries its review outcome, for analytics. See
-- FuelTheft.reviewStatus.

Loaded Prisma config from prisma.config.ts.

-- CreateEnum
CREATE TYPE "FuelAlertReview" AS ENUM ('DISMISSED', 'UNDER_REVIEW', 'CONFIRMED_THEFT', 'NOT_THEFT');

-- CreateEnum
CREATE TYPE "FuelFollowUpStatus" AS ENUM ('OPEN', 'ACCEPTED', 'ESCALATED', 'DEESCALATED');

-- CreateEnum
CREATE TYPE "FuelFollowUpActionKind" AS ENUM ('OPENED', 'ACCEPTED', 'NOTE', 'ESCALATED', 'DEESCALATED');

-- AlterTable
ALTER TABLE "fuel_thefts" ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "review_status" "FuelAlertReview",
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by_id" TEXT;

-- CreateTable
CREATE TABLE "fuel_theft_followups" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "theft_id" TEXT NOT NULL,
    "status" "FuelFollowUpStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissed_by_id" TEXT,
    "accepted_by_id" TEXT,
    "accepted_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "incident_snapshot" JSONB,

    CONSTRAINT "fuel_theft_followups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_theft_followup_actions" (
    "id" TEXT NOT NULL,
    "follow_up_id" TEXT NOT NULL,
    "kind" "FuelFollowUpActionKind" NOT NULL,
    "actor_id" TEXT,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fuel_theft_followup_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fuel_theft_followups_theft_id_key" ON "fuel_theft_followups"("theft_id");

-- CreateIndex
CREATE INDEX "fuel_theft_followups_organisation_id_status_opened_at_idx" ON "fuel_theft_followups"("organisation_id", "status", "opened_at");

-- CreateIndex
CREATE INDEX "fuel_theft_followup_actions_follow_up_id_at_idx" ON "fuel_theft_followup_actions"("follow_up_id", "at");

-- CreateIndex
CREATE INDEX "fuel_thefts_review_status_began_at_idx" ON "fuel_thefts"("review_status", "began_at");

-- AddForeignKey
ALTER TABLE "fuel_thefts" ADD CONSTRAINT "fuel_thefts_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft_followups" ADD CONSTRAINT "fuel_theft_followups_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft_followups" ADD CONSTRAINT "fuel_theft_followups_theft_id_fkey" FOREIGN KEY ("theft_id") REFERENCES "fuel_thefts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft_followups" ADD CONSTRAINT "fuel_theft_followups_dismissed_by_id_fkey" FOREIGN KEY ("dismissed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft_followups" ADD CONSTRAINT "fuel_theft_followups_accepted_by_id_fkey" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft_followup_actions" ADD CONSTRAINT "fuel_theft_followup_actions_follow_up_id_fkey" FOREIGN KEY ("follow_up_id") REFERENCES "fuel_theft_followups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_theft_followup_actions" ADD CONSTRAINT "fuel_theft_followup_actions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Case rights ────────────────────────────────────────────────────────────
-- `fuel_theft:triage`: accept a follow-up and escalate or de-escalate it.
-- Granted here rather than by `npm run seed:rbac`, because that script either
-- reconciles every role to the matrix (undoing hand-tuned roles) or, with
-- --preserve, adds nothing to roles that already exist. This touches only the
-- one permission and the six roles the operator named. The platform
-- administrator holds it through its wildcard.
INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''),
        'Take on and decide fuel alert follow-ups', 'fuel_theft:triage', 'fuel_theft', 'triage')
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."slug" = 'fuel_theft:triage'
 WHERE r."slug" IN ('admin', 'manager', 'fleet_manager', 'director', 'head_of_security', 'technician')
ON CONFLICT DO NOTHING;

-- ── Backfill ───────────────────────────────────────────────────────────────
-- Alerts deleted before this existed get their follow-up too, opened at the
-- moment they were deleted, so none of them escapes review.
INSERT INTO "fuel_theft_followups" ("id", "organisation_id", "theft_id", "status", "opened_at", "dismissed_by_id", "incident_snapshot")
SELECT 'fu_' || replace(gen_random_uuid()::text, '-', ''), v."organisation_id", t."id", 'OPEN', t."dismissed_at", t."dismissed_by_id",
       to_jsonb(t) || jsonb_build_object('plate', v."registration_plate", 'snapshotNote', 'taken at migration, not at deletion')
  FROM "fuel_thefts" t
  JOIN "vehicles" v ON v."id" = t."vehicle_id"
 WHERE t."dismissed_at" IS NOT NULL
ON CONFLICT ("theft_id") DO NOTHING;

INSERT INTO "fuel_theft_followup_actions" ("id", "follow_up_id", "kind", "actor_id", "at")
SELECT 'fa_' || replace(gen_random_uuid()::text, '-', ''), f."id", 'OPENED', f."dismissed_by_id", f."opened_at"
  FROM "fuel_theft_followups" f
 WHERE NOT EXISTS (SELECT 1 FROM "fuel_theft_followup_actions" a WHERE a."follow_up_id" = f."id");

UPDATE "fuel_thefts"
   SET "review_status" = 'DISMISSED', "reviewed_at" = "dismissed_at", "reviewed_by_id" = "dismissed_by_id"
 WHERE "dismissed_at" IS NOT NULL AND "review_status" IS NULL;
