SET lock_timeout = '5s';

-- The rest of RaiFactorySuite's machine register row: its own registration
-- number, the machine name as sent, and the standard rate's unit of measure
-- ("Ltrs/Hr", "Kms/Ltr"). Additive and nullable; written by the machine sync.
ALTER TABLE "vehicles"
  ADD COLUMN "machine_name"                TEXT,
  ADD COLUMN "machine_registration_number" TEXT,
  ADD COLUMN "rated_consumption_unit"      TEXT;
