-- Controltech EA operational alerts (dispatch/driver governance), delivered by
-- webhook and backfilled by sync:alerts. Keyed by the provider's own alert id
-- so a webhook redelivery is idempotent.
CREATE TABLE "provider_alerts" (
    "id"              TEXT NOT NULL,
    "external_id"     TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_id"      TEXT,
    "type"            TEXT NOT NULL,
    "severity"        TEXT NOT NULL,
    "message"         TEXT NOT NULL,
    "related_id"      TEXT,
    "plate"           TEXT,
    "acknowledged"    BOOLEAN NOT NULL DEFAULT false,
    "created_at"      TIMESTAMP(3) NOT NULL,
    "received_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source"          TEXT NOT NULL DEFAULT 'webhook',
    "raw"             JSONB,

    CONSTRAINT "provider_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_alerts_external_id_key" ON "provider_alerts"("external_id");
CREATE INDEX "provider_alerts_organisation_id_created_at_idx" ON "provider_alerts"("organisation_id", "created_at");
CREATE INDEX "provider_alerts_vehicle_id_created_at_idx" ON "provider_alerts"("vehicle_id", "created_at");

ALTER TABLE "provider_alerts" ADD CONSTRAINT "provider_alerts_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_alerts" ADD CONSTRAINT "provider_alerts_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
