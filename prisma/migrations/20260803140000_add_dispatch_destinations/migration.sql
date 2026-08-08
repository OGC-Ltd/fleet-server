-- Where dispatches actually go, and where they leave from.
--
-- The provider gives a destination NAME and nothing else. Both of these are
-- measured from the fleet's own telemetry by prisma/sync-destinations.ts, not
-- typed in and not geocoded — see the model docs in schema.prisma.

-- The yard every round trip starts and ends at.
ALTER TABLE "organisations" ADD COLUMN "hub_lat" DOUBLE PRECISION;
ALTER TABLE "organisations" ADD COLUMN "hub_lng" DOUBLE PRECISION;

CREATE TABLE "dispatch_destinations" (
    "id"                   TEXT NOT NULL,
    "organisation_id"      TEXT NOT NULL,
    "name"                 TEXT NOT NULL,
    "lat"                  DOUBLE PRECISION NOT NULL,
    "lng"                  DOUBLE PRECISION NOT NULL,
    "samples"              INTEGER NOT NULL,
    "spread_m"             INTEGER NOT NULL,
    "distance_from_hub_m"  INTEGER NOT NULL,
    "computed_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_destinations_pkey" PRIMARY KEY ("id")
);

-- One point per destination name per organisation. Also the lookup the fleet
-- snapshot does for every open dispatch.
CREATE UNIQUE INDEX "dispatch_destinations_organisation_id_name_key"
    ON "dispatch_destinations"("organisation_id", "name");

ALTER TABLE "dispatch_destinations" ADD CONSTRAINT "dispatch_destinations_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
