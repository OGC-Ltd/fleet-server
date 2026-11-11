SET lock_timeout = '5s';

-- The Deliveries report's day list and typed orders move out of the browser
-- into Postgres (operator, 11 Nov 2026), read through Redis; the Planner's
-- "Mark for today" becomes a column on the stop. All new or nullable, so
-- nothing existing changes.

CREATE TABLE IF NOT EXISTS "delivery_days" (
  "organisation_id" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "vehicles" JSONB NOT NULL DEFAULT '[]',
  "updated_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "delivery_days_pkey" PRIMARY KEY ("organisation_id", "day"),
  CONSTRAINT "delivery_days_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "delivery_orders" (
  "organisation_id" TEXT NOT NULL,
  "plate" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "updated_by" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "delivery_orders_pkey" PRIMARY KEY ("organisation_id", "plate"),
  CONSTRAINT "delivery_orders_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "delivery_plan_stops" ADD COLUMN IF NOT EXISTS "due_day" TEXT;
