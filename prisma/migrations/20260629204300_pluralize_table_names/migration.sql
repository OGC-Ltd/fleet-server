-- Migration: pluralize_table_names
-- Renames all singular table names to their plural form.
--
-- DOWN (rollback)
-- ALTER TABLE organisations        RENAME TO organisation;
-- ALTER TABLE roles                RENAME TO role;
-- ALTER TABLE permissions          RENAME TO permission;
-- ALTER TABLE role_permissions     RENAME TO role_permission;
-- ALTER TABLE users                RENAME TO user;
-- ALTER TABLE user_roles           RENAME TO user_role;
-- ALTER TABLE ingest_api_keys      RENAME TO ingest_api_key;
-- ALTER TABLE vehicle_groups       RENAME TO vehicle_group;
-- ALTER TABLE vehicles             RENAME TO vehicle;
-- ALTER TABLE vehicle_assignments  RENAME TO vehicle_assignment;
-- ALTER TABLE reporting_periods    RENAME TO reporting_period;
-- ALTER TABLE routes               RENAME TO route;
-- ALTER TABLE route_waypoints      RENAME TO route_waypoint;
-- ALTER TABLE geofences            RENAME TO geofence;
-- ALTER TABLE vehicle_geofences    RENAME TO vehicle_geofence;
-- ALTER TABLE geofence_violations  RENAME TO geofence_violation;
-- ALTER TABLE trips                RENAME TO trip;
-- ALTER TABLE engine_hour_sessions RENAME TO engine_hour_session;
-- ALTER TABLE fuel_fillings        RENAME TO fuel_filling;
-- ALTER TABLE fuel_thefts          RENAME TO fuel_theft;
-- ALTER TABLE vehicle_telemetries  RENAME TO vehicle_telemetry;
-- ALTER TABLE vehicle_telemetry_raws RENAME TO vehicle_telemetry_raw;
-- ALTER TABLE cargo_manifests      RENAME TO cargo_manifest;
-- ALTER TABLE vehicle_period_summaries RENAME TO vehicle_period_summary;

-- UP
ALTER TABLE "organisation"        RENAME TO "organisations";
ALTER TABLE "role"                RENAME TO "roles";
ALTER TABLE "permission"          RENAME TO "permissions";
ALTER TABLE "role_permission"     RENAME TO "role_permissions";
ALTER TABLE "user"                RENAME TO "users";
ALTER TABLE "user_role"           RENAME TO "user_roles";
ALTER TABLE "ingest_api_key"      RENAME TO "ingest_api_keys";
ALTER TABLE "vehicle_group"       RENAME TO "vehicle_groups";
ALTER TABLE "vehicle"             RENAME TO "vehicles";
ALTER TABLE "vehicle_assignment"  RENAME TO "vehicle_assignments";
ALTER TABLE "reporting_period"    RENAME TO "reporting_periods";
ALTER TABLE "route"               RENAME TO "routes";
ALTER TABLE "route_waypoint"      RENAME TO "route_waypoints";
ALTER TABLE "geofence"            RENAME TO "geofences";
ALTER TABLE "vehicle_geofence"    RENAME TO "vehicle_geofences";
ALTER TABLE "geofence_violation"  RENAME TO "geofence_violations";
ALTER TABLE "trip"                RENAME TO "trips";
ALTER TABLE "engine_hour_session" RENAME TO "engine_hour_sessions";
ALTER TABLE "fuel_filling"        RENAME TO "fuel_fillings";
ALTER TABLE "fuel_theft"          RENAME TO "fuel_thefts";
ALTER TABLE "vehicle_telemetry"   RENAME TO "vehicle_telemetries";
ALTER TABLE "vehicle_telemetry_raw" RENAME TO "vehicle_telemetry_raws";
ALTER TABLE "cargo_manifest"      RENAME TO "cargo_manifests";
ALTER TABLE "vehicle_period_summary" RENAME TO "vehicle_period_summaries";
