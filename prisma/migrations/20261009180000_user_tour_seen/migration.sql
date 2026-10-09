SET lock_timeout = '5s';

-- The first-time tour version each person has been shown (new-ui
-- lib/productTour), so it is shown once per account rather than once per
-- browser. Additive and nullable: no rewrite, NULL reads as "never shown".
ALTER TABLE "users" ADD COLUMN "tour_seen_version" INTEGER;
