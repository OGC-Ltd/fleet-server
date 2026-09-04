-- When a password was last set, and how many times.
--
-- Nothing recorded this before, so neither an administrator nor the account
-- holder could answer "when did this last change". Two columns rather than an
-- audit table: the question is when and how many, not from where — and a table
-- would carry a retention decision that this does not.
--
-- The default of 0 is honest for existing rows. Backfilling
-- password_changed_at from created_at would invent a fact: for the 551 synced
-- driver accounts with a NULL password_hash, no password has ever been set.

ALTER TABLE "users" ADD COLUMN "password_changed_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "password_change_count" INTEGER NOT NULL DEFAULT 0;
