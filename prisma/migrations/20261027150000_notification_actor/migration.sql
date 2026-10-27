-- Who took the action a feed line reports, when a person did. Their own feed
-- reads it as already read, and the push and mail leave them out.
-- Nullable and unindexed: a metadata-only ADD COLUMN, no rewrite.
ALTER TABLE "notifications" ADD COLUMN "actor_id" TEXT;
