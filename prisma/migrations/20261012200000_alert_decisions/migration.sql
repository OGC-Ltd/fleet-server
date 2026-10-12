SET lock_timeout = '5s';

-- The Alerts page (operator, 2026-10-12): fuel and overspeeding alerts from
-- every organisation in one place, escalated or de-escalated there.
--
-- Additive only. The new speeding_incidents columns are nullable with no
-- default, so adding them rewrites nothing; NULL reads as "not decided yet".

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('FUEL', 'SPEEDING');

-- CreateEnum
CREATE TYPE "AlertOutcome" AS ENUM ('ESCALATED', 'DEESCALATED');

-- AlterTable
ALTER TABLE "speeding_incidents" ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "review_status" "AlertOutcome",
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by_id" TEXT;

-- CreateTable
CREATE TABLE "alert_decisions" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "alert_id" TEXT NOT NULL,
    "outcome" "AlertOutcome" NOT NULL,
    "reason" TEXT,
    "note" TEXT NOT NULL,
    "actor_id" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_decisions_kind_alert_id_at_idx" ON "alert_decisions"("kind", "alert_id", "at");

-- CreateIndex
CREATE INDEX "alert_decisions_organisation_id_at_idx" ON "alert_decisions"("organisation_id", "at");

-- AddForeignKey
ALTER TABLE "speeding_incidents" ADD CONSTRAINT "speeding_incidents_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_decisions" ADD CONSTRAINT "alert_decisions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_decisions" ADD CONSTRAINT "alert_decisions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
