-- CreateTable
CREATE TABLE "simulation_states" (
    "device_id" TEXT NOT NULL,
    "organisation_id" TEXT,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "simulation_states_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "simulation_meta" (
    "id" TEXT NOT NULL,
    "last_tick_at" TIMESTAMP(3) NOT NULL,
    "sim_day_key" TEXT,

    CONSTRAINT "simulation_meta_pkey" PRIMARY KEY ("id")
);
