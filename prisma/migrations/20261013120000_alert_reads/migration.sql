SET lock_timeout = '5s';

-- Read alerts (operator, 2026-10-13): "we need to see the alerts that have
-- been read, mark all read". Read is per person, as in a mailbox.
--
-- Additive only. users.alerts_read_at is nullable with no default, so adding
-- it rewrites nothing; NULL reads as "never marked all read".

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "alerts_read_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "alert_reads" (
    "user_id" TEXT NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "alert_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_reads_pkey" PRIMARY KEY ("user_id","kind","alert_id")
);

-- AddForeignKey
ALTER TABLE "alert_reads" ADD CONSTRAINT "alert_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
