-- Migration: add push_subscriptions table
-- Created: 2026-06-30

CREATE TABLE "push_subscriptions" (
    "id"              TEXT         NOT NULL,
    "organisation_id" TEXT,
    "user_id"         TEXT,
    "endpoint"        TEXT         NOT NULL,
    "p256dh"          TEXT         NOT NULL,
    "auth"            TEXT         NOT NULL,
    "user_agent"      TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- Unique index on endpoint (natural key)
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- Lookup indexes
CREATE INDEX "push_subscriptions_organisation_id_idx" ON "push_subscriptions"("organisation_id");
CREATE INDEX "push_subscriptions_user_id_idx"         ON "push_subscriptions"("user_id");

-- Foreign keys
ALTER TABLE "push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
