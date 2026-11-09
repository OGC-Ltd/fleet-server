SET lock_timeout = '5s';

-- Driver conduct (v47): harsh cornering opens a case, the follow-up records who
-- gave the feedback apart from who recorded it, and a logged incident remembers
-- when it was shared. Additive only.
ALTER TABLE "driver_conduct_cases" ADD COLUMN "corner" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "driver_conduct_cases" ADD COLUMN "feedback_by" TEXT NOT NULL DEFAULT '';
ALTER TABLE "operator_incidents" ADD COLUMN "shared_at" TIMESTAMP(3);
