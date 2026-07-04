-- CreateTable
CREATE TABLE "vehicle_garage_visits" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "garage_name" TEXT NOT NULL,
    "garage_lat" DOUBLE PRECISION NOT NULL,
    "garage_lng" DOUBLE PRECISION NOT NULL,
    "entered_at" TIMESTAMP(3) NOT NULL,
    "exited_at" TIMESTAMP(3) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "odometer_km" DOUBLE PRECISION NOT NULL,
    "severity_score" DOUBLE PRECISION NOT NULL,
    "items_fixed" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_garage_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_garage_visits_vehicle_id_entered_at_idx" ON "vehicle_garage_visits"("vehicle_id", "entered_at");

-- AddForeignKey
ALTER TABLE "vehicle_garage_visits" ADD CONSTRAINT "vehicle_garage_visits_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
