-- The uploaded fleet Excel itself, kept in S3 (lib/uploads): where it is, its
-- size, type and checksum. Nullable: reset rows have no file, and the two rows
-- written before this (13 Nov 2026) predate it.
SET lock_timeout = '5s';

ALTER TABLE "fleet_list_versions" ADD COLUMN IF NOT EXISTS "file_key"    TEXT;
ALTER TABLE "fleet_list_versions" ADD COLUMN IF NOT EXISTS "file_size"   INTEGER;
ALTER TABLE "fleet_list_versions" ADD COLUMN IF NOT EXISTS "file_type"   TEXT;
ALTER TABLE "fleet_list_versions" ADD COLUMN IF NOT EXISTS "file_sha256" TEXT;
