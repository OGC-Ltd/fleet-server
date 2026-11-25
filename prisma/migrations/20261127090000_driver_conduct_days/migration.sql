SET lock_timeout = '5s';

-- Driver Conduct a fleet day at a time (operator, 2026-11-25): built each night
-- from notifications and dashcam_alarms, so a month's report adds days up.
-- Two new tables, nothing altered. A month's days are cleared on the 5th of
-- the next month by the job that builds them.

-- CreateTable
CREATE TABLE "driver_conduct_days" (
    "organisation_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "vehicle_key" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "plate" TEXT NOT NULL DEFAULT '',
    "accel" INTEGER NOT NULL DEFAULT 0,
    "brake" INTEGER NOT NULL DEFAULT 0,
    "seatbelt" INTEGER NOT NULL DEFAULT 0,
    "phone" INTEGER NOT NULL DEFAULT 0,
    "covered" INTEGER NOT NULL DEFAULT 0,
    "times" JSONB NOT NULL,

    CONSTRAINT "driver_conduct_days_pkey" PRIMARY KEY ("organisation_id","day","vehicle_key")
);

-- CreateTable
CREATE TABLE "driver_conduct_built_days" (
    "organisation_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "built_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "captured" BOOLEAN NOT NULL DEFAULT false,
    "capture_at" TIMESTAMP(3),
    "untyped" INTEGER NOT NULL DEFAULT 0,
    "harsh" INTEGER NOT NULL DEFAULT 0,
    "alarms" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "driver_conduct_built_days_pkey" PRIMARY KEY ("organisation_id","day")
);

-- AddForeignKey
ALTER TABLE "driver_conduct_days" ADD CONSTRAINT "driver_conduct_days_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_conduct_built_days" ADD CONSTRAINT "driver_conduct_built_days_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
