SET lock_timeout = '5s';

-- Gate log acknowledgements (operator, 2026-11-26: "a decision section for
-- them to either acknowledge it truly left or got into the premises, by that
-- it will update the rows column acknowledged"). One row per gate event: the
-- latest decision on it. The event is a live-feed line (its feedId), kept in
-- the notifications store, so this table only points at it by id and keeps
-- what the row needs to be read without it.
--
--   CONFIRMED  it did leave / it did come in
--   DISPUTED   it did not; the note says why
--
-- A new table and one permission row; nothing existing is altered.

CREATE TABLE "gate_acknowledgements" (
  "id"              TEXT         NOT NULL,
  "organisation_id" TEXT         NOT NULL,
  "event_id"        TEXT         NOT NULL,
  "alert_type"      TEXT         NOT NULL,
  "vehicle_id"      TEXT,
  "plate"           TEXT,
  "event_at"        TIMESTAMP(3) NOT NULL,
  "outcome"         TEXT         NOT NULL,
  "note"            TEXT,
  "decided_by_id"   TEXT,
  "decided_by_name" TEXT         NOT NULL,
  "decided_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gate_acknowledgements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gate_acknowledgements_outcome_check" CHECK ("outcome" IN ('CONFIRMED', 'DISPUTED')),
  CONSTRAINT "gate_acknowledgements_organisation_id_fkey" FOREIGN KEY ("organisation_id")
    REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "gate_acknowledgements_decided_by_id_fkey" FOREIGN KEY ("decided_by_id")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "gate_acknowledgements_organisation_id_event_id_key"
  ON "gate_acknowledgements" ("organisation_id", "event_id");

-- The right to decide. It must be in the table before the grant below.
INSERT INTO "permissions" ("id", "name", "slug", "resource", "action")
VALUES ('perm_' || replace(gen_random_uuid()::text, '-', ''), 'Acknowledge a Gate log event: it left, or it came in', 'gate_log:acknowledge', 'gate_log', 'acknowledge')
ON CONFLICT ("slug") DO NOTHING;
