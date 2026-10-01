SET lock_timeout = '5s';

-- RaiFactorySuite's machine register (`GET /machines`) for Mufindi Paper Mills:
-- what each KASULU unit is (Backhoe, Concrete Mixer, …) and the operator's
-- stated fuel consumption, L/h or km/L. Additive and nullable; written only by
-- prisma/sync-factorysuite-machines.ts.
ALTER TABLE "vehicles"
  ADD COLUMN "machine_id"              TEXT,
  ADD COLUMN "equipment_type"          TEXT,
  ADD COLUMN "equipment_category"      TEXT,
  ADD COLUMN "equipment_reference"     TEXT,
  ADD COLUMN "make_model"              TEXT,
  ADD COLUMN "contractor"              TEXT,
  ADD COLUMN "fuel_type"               TEXT,
  ADD COLUMN "rated_consumption"       DOUBLE PRECISION,
  ADD COLUMN "rated_consumption_basis" "ConsumptionBasis",
  ADD COLUMN "fuel_sensor_fitted"      BOOLEAN,
  ADD COLUMN "machine_synced_at"       TIMESTAMP(3);

CREATE UNIQUE INDEX "vehicles_machine_id_key" ON "vehicles"("machine_id");
