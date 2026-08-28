-- Ground truth, and the evidence a label has to be read against.
--
-- Two halves of one problem. `FuelEventLabel` records what a human decided an
-- event actually was; the new columns on `fuel_thefts` record what the detector
-- measured before deciding. Neither is much use alone -- a label with no
-- evidence cannot be argued with, and evidence with no label cannot be scored.
--
-- ## The evidence columns
--
-- DropEvidence has been computed for every drain since the classifier was
-- written and thrown away every time. Only the cause slugs survived, and
-- `implied_lph` -- the figure the whole burn rule turns on -- existed solely as
-- text inside a notification sentence. That made backtesting impossible and
-- made a labelled event impossible to explain to the person labelling it.
--
-- All nullable, no defaults: catalogue-only, and null on the ~2,500 existing
-- rows because the values must NOT be back-computed. The telemetry a drain was
-- judged on may have changed since -- the adjudication sweep re-reads it -- so a
-- figure derived today would describe a different fall from the one the verdict
-- was about, while looking exactly like a contemporaneous measurement.
--
-- `fall_seconds` also fixes DriverIncident.minutes, which reports
-- `detected_at - began_at`: the PROVIDER's window, which is the quantity
-- PLATEAU_TOLERANCE exists to reject and is typically several times the
-- measured fall.
--
-- ## The label table
--
-- Its own table rather than columns on the event. A label is an opinion with an
-- author and a date, two reviewers may legitimately disagree, and the event rows
-- are rewritten by the adjudication sweep -- a label living on one would be at
-- the mercy of a re-judge.
--
-- The unique key is (event, type, reviewer), so a reviewer correcting themselves
-- updates while two reviewers each keep their answer.
--
-- NO foreign key, deliberately. `event_id` addresses `fuel_thefts` or
-- `fuel_fillings` depending on `event_type`, and Postgres cannot express "FK
-- only when the discriminator says so" -- an FK to fuel_thefts would reject
-- every FILLING label, since a filling's id is not in that table. NOT VALID
-- would not save it either: that skips checking EXISTING rows and still
-- enforces new ones.
--
-- The alternative, a pair of nullable FK columns, buys referential integrity at
-- the cost of every reader having to coalesce two columns and every writer
-- having to keep them exclusive. The discriminated pair is honest about what it
-- is, and the import CLI resolves the id against the right table before writing.

CREATE TYPE "FuelEventLabelValue" AS ENUM ('THEFT', 'NOT_THEFT', 'UNSURE');

ALTER TABLE "fuel_thefts"
  ADD COLUMN "fall_seconds"      INTEGER,
  ADD COLUMN "measured_drop_ml"  INTEGER,
  ADD COLUMN "engine_seconds"    INTEGER,
  ADD COLUMN "engine_evidence"   DOUBLE PRECISION,
  ADD COLUMN "step_fraction"     DOUBLE PRECISION,
  ADD COLUMN "implied_lph"       DOUBLE PRECISION,
  ADD COLUMN "fall_distance_km"  DOUBLE PRECISION;

CREATE TABLE "fuel_event_labels" (
  "id"          TEXT NOT NULL,
  "event_id"    TEXT NOT NULL,
  "event_type"  "FuelEventType" NOT NULL,
  "label"       "FuelEventLabelValue" NOT NULL,
  "labelled_by" TEXT NOT NULL,
  "labelled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"        TEXT,

  CONSTRAINT "fuel_event_labels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fuel_event_labels_event_id_event_type_labelled_by_key"
  ON "fuel_event_labels" ("event_id", "event_type", "labelled_by");

CREATE INDEX "fuel_event_labels_event_type_label_idx"
  ON "fuel_event_labels" ("event_type", "label");
