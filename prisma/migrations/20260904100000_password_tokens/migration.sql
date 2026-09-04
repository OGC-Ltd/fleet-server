-- Password-setting links: invites and resets.
--
-- One table for both. The lifecycle is identical — single-use, hashed at rest,
-- expiring, revocable, consumed in the same transaction that writes the new
-- password hash — and they differ only in TTL and in what the email says.
-- Splitting them would have duplicated the consumption path, which is the half
-- that has to be exactly right.
--
-- Shaped after auth_sessions on purpose: the raw token is handed to a person
-- and only its sha256 is stored, so reading this table yields no working links.

CREATE TYPE "PasswordTokenPurpose" AS ENUM ('INVITE', 'RESET');

CREATE TABLE "password_tokens" (
    "id"                   TEXT NOT NULL,
    "user_id"              TEXT NOT NULL,
    "purpose"              "PasswordTokenPurpose" NOT NULL,
    "token_hash"           TEXT NOT NULL,
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"           TIMESTAMP(3) NOT NULL,
    "consumed_at"          TIMESTAMP(3),
    "revoked_at"           TIMESTAMP(3),
    "revoked_reason"       TEXT,
    "created_by"           TEXT,
    "requested_ip"         TEXT,
    "requested_user_agent" TEXT,

    CONSTRAINT "password_tokens_pkey" PRIMARY KEY ("id")
);

-- The lookup is by hash and nothing else, so it must be unique and indexed:
-- one indexed read decides whether a link is real.
CREATE UNIQUE INDEX "password_tokens_token_hash_key" ON "password_tokens"("token_hash");

-- Finding a user's live token, which is what minting a replacement revokes.
CREATE INDEX "password_tokens_user_id_purpose_consumed_at_idx"
    ON "password_tokens"("user_id", "purpose", "consumed_at");

-- For the expiry sweep, when one is written.
CREATE INDEX "password_tokens_expires_at_idx" ON "password_tokens"("expires_at");

-- CASCADE on the subject: a deleted user's pending links must die with them,
-- or a link outlives the account it was for.
ALTER TABLE "password_tokens"
    ADD CONSTRAINT "password_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL on the granter: an admin leaving must not delete the invitations
-- they issued, and "who invited this person" is history, not a dependency.
ALTER TABLE "password_tokens"
    ADD CONSTRAINT "password_tokens_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
