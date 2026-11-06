SET lock_timeout = '5s';

-- Feedback on dashcam alarms: a verdict and a note per entry, shared across
-- the organisation (operator, 7 Nov 2026). One new table, nothing altered.

-- CreateTable
CREATE TABLE "dashcam_alarm_feedback" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "alarm_id" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "plate" TEXT NOT NULL DEFAULT '',
    "alarm_at" TIMESTAMP(3),
    "verdict" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "author_id" TEXT,
    "author_name" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashcam_alarm_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dashcam_alarm_feedback_organisation_id_alarm_id_idx" ON "dashcam_alarm_feedback"("organisation_id", "alarm_id");

-- AddForeignKey
ALTER TABLE "dashcam_alarm_feedback" ADD CONSTRAINT "dashcam_alarm_feedback_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
