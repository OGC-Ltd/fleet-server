-- Durable Live Feed history. Replaces the 60-item in-memory ring buffer in
-- lib/sse.ts, which was global across organisations and lost on every restart.
CREATE TABLE "notifications" (
    "id"              TEXT NOT NULL,
    "feed_id"         TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "vehicle_id"      TEXT,
    "source"          TEXT NOT NULL,
    "alert_type"      TEXT,
    "severity"        TEXT NOT NULL,
    "text"            TEXT NOT NULL,
    "plate"           TEXT,
    "occurred_at"     TIMESTAMP(3) NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- Idempotency: a webhook redelivery or a reconcile pass that re-surfaces the
-- same alert must update one row, not append a duplicate to the feed.
CREATE UNIQUE INDEX "notifications_feed_id_key" ON "notifications"("feed_id");

-- Org-scoped history endpoint, newest first.
CREATE INDEX "notifications_organisation_id_occurred_at_idx" ON "notifications"("organisation_id", "occurred_at");

-- The retention sweep scans by age ACROSS organisations, so it needs its own
-- index; the composite above cannot serve an org-less range scan.
CREATE INDEX "notifications_occurred_at_idx" ON "notifications"("occurred_at");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
