SET lock_timeout = '5s';

-- Driver conduct follow-up cases and the incidents operators log by hand, kept
-- on the server instead of in each browser (operator, 2 Nov 2026: the Reports
-- count differed from machine to machine). Two new tables, nothing altered.

-- CreateTable
CREATE TABLE "driver_conduct_cases" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "case_key" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "unit_key" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "group_name" TEXT,
    "driver" TEXT NOT NULL DEFAULT '',
    "accel" INTEGER NOT NULL DEFAULT 0,
    "brake" INTEGER NOT NULL DEFAULT 0,
    "seatbelt" INTEGER NOT NULL DEFAULT 0,
    "phone" INTEGER NOT NULL DEFAULT 0,
    "covered" INTEGER NOT NULL DEFAULT 0,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "action" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "acted_by" TEXT NOT NULL DEFAULT '',
    "acted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_conduct_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_incidents" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "other" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL,
    "vehicle_id" TEXT,
    "plate" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'Online',
    "details" TEXT NOT NULL DEFAULT '',
    "logged_by" TEXT NOT NULL DEFAULT '',
    "logged_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "driver_conduct_cases_organisation_id_status_idx" ON "driver_conduct_cases"("organisation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "driver_conduct_cases_organisation_id_case_key_key" ON "driver_conduct_cases"("organisation_id", "case_key");

-- CreateIndex
CREATE INDEX "operator_incidents_organisation_id_at_idx" ON "operator_incidents"("organisation_id", "at");

-- AddForeignKey
ALTER TABLE "driver_conduct_cases" ADD CONSTRAINT "driver_conduct_cases_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_incidents" ADD CONSTRAINT "operator_incidents_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

