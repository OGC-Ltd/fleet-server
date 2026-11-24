SET lock_timeout = '5s';

-- Dashcam alarms saved each night from VSS, which keeps them about two weeks
-- (operator, 2026-11-24). Numbers only: no clips or photos. Two new tables,
-- nothing altered.

-- CreateTable
CREATE TABLE "dashcam_alarms" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_id" TEXT,
    "plate" TEXT NOT NULL DEFAULT '',
    "device_id" TEXT NOT NULL DEFAULT '',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "code" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL DEFAULT '',
    "group" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "speed_kmh" INTEGER,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "typed_at" TIMESTAMP(3),

    CONSTRAINT "dashcam_alarms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashcam_capture_days" (
    "organisation_id" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "alarms" INTEGER NOT NULL DEFAULT 0,
    "untyped" INTEGER NOT NULL DEFAULT 0,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dashcam_capture_days_pkey" PRIMARY KEY ("organisation_id","day")
);

-- CreateIndex
CREATE INDEX "dashcam_alarms_organisation_id_occurred_at_idx" ON "dashcam_alarms"("organisation_id", "occurred_at");

-- CreateIndex
CREATE INDEX "dashcam_alarms_vehicle_id_occurred_at_idx" ON "dashcam_alarms"("vehicle_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "dashcam_alarms" ADD CONSTRAINT "dashcam_alarms_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashcam_capture_days" ADD CONSTRAINT "dashcam_capture_days_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
