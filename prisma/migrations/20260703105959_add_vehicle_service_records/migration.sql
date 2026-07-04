-- CreateTable
CREATE TABLE "vehicle_service_records" (
    "id" TEXT NOT NULL,
    "vehicle_id" TEXT NOT NULL,
    "serviced_at" TIMESTAMP(3) NOT NULL,
    "odometer_km" DOUBLE PRECISION NOT NULL,
    "previous_service_odo_km" DOUBLE PRECISION,
    "next_service_odo_km" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_service_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_service_records_vehicle_id_serviced_at_idx" ON "vehicle_service_records"("vehicle_id", "serviced_at");

-- AddForeignKey
ALTER TABLE "vehicle_service_records" ADD CONSTRAINT "vehicle_service_records_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
