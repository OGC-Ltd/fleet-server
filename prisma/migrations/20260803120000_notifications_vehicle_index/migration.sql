-- Per-vehicle notification history.
--
-- Clicking a unit on the map now filters the Live Feed to that unit, which
-- means the history endpoint is asked
--
--   SELECT ... FROM notifications
--    WHERE organisation_id = $1 AND vehicle_id = $2
--    ORDER BY occurred_at DESC LIMIT $3
--
-- The existing (organisation_id, occurred_at) index cannot satisfy the
-- vehicle_id predicate, so this becomes an org-wide range scan with a filter.
-- One vehicle is 1/224th of Kasulu's feed and roughly 1/598th of Sukari's, so
-- filling a 50-row page means walking tens of thousands of rows — and the
-- deeper the page, the worse it gets.
--
-- IF NOT EXISTS so re-running against a database where the index was built
-- out-of-band (see the telemetry_moving_partial_index migration's note on
-- CREATE INDEX CONCURRENTLY) is a no-op rather than an error.
CREATE INDEX IF NOT EXISTS "notifications_organisation_id_vehicle_id_occurred_at_idx"
  ON "notifications" ("organisation_id", "vehicle_id", "occurred_at");
