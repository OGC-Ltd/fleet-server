-- Record successful sign-ins separately from refresh-token rotations, and
-- retain the most recent known authenticated session for the user roster.
SET lock_timeout = '5s';

ALTER TABLE "users" ADD COLUMN "last_login_at" TIMESTAMP(3);

-- Existing session rows prove the account has logged in. They do not
-- distinguish a login from a refresh, so this is the best available historic
-- last-authenticated-session timestamp; exact logins are tracked from here on.
UPDATE "users" AS u
SET "last_login_at" = sessions."last_issued_at"
FROM (
    SELECT "user_id", MAX("issued_at") AS "last_issued_at"
    FROM "auth_sessions"
    GROUP BY "user_id"
) AS sessions
WHERE sessions."user_id" = u."id";

CREATE TABLE "user_login_events" (
    "id"          TEXT NOT NULL,
    "user_id"     TEXT NOT NULL,
    "logged_in_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_login_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_login_events_logged_in_at_idx"
    ON "user_login_events"("logged_in_at");
CREATE INDEX "user_login_events_user_id_logged_in_at_idx"
    ON "user_login_events"("user_id", "logged_in_at");

ALTER TABLE "user_login_events"
    ADD CONSTRAINT "user_login_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Manager is read-only on the user directory. The API applies the manager's
-- current shared-group scope to both the roster and login report.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."slug" = 'user:read'
WHERE r."slug" = 'manager'
  AND r."organisation_id" IS NOT NULL
ON CONFLICT DO NOTHING;
