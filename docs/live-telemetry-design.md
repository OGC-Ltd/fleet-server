# Live Vehicle Telemetry — Design Specification

## 1. What We're Building

A real-time vehicle intelligence layer on top of the existing fleet-server REST API. It covers:

| Capability | Description |
|---|---|
| **Live feed** | Engine on/off, speed (km/h), fuel used, remaining fuel — streamed per vehicle |
| **Route tracking** | Named trip legs (e.g. Garissa Depot → Nairobi CBD Warehouse), live position along route |
| **Geofencing** | Per-vehicle allowed zones; violation detection and alerting |
| **Cargo & weighment** | Cargo type, declared weight, load sensor readings per trip |

All metrics are anchored to a `Vehicle` → `VehicleAssignment` → `User (driver)` chain that already exists in the schema.

---

## 2. Where Does the Data Come From?

### 2a. What the Excel Sheet Already Contains (Batch / Historical)

The Excel reports produced by the GPS/FLS vendor (Galileosky, Teltonika, Cartrack, etc.) are **periodic exports** of the same raw telemetry the device sends live. The columns you've seen map directly to existing schema fields:

| Excel Column | Schema Field | Table |
|---|---|---|
| Trip start/end timestamps | `began_at`, `ended_at` | `trip` |
| Start / end location string | `initial_location`, `final_location` | `trip`, `engine_hour_session` |
| Distance km | `mileage_km` | `trip` |
| Avg / max speed km/h | `avg_speed_kmh`, `max_speed_kmh` | `trip` |
| Fuel consumed ml | `consumed_ml`, `consumed_by_fls_ml` | `trip` |
| Fuel level at start / end | `initial_fuel_level_ml`, `final_fuel_level_ml` | `trip`, `fuel_filling` |
| Engine hours | `engine_hours_seconds` | `engine_hour_session` |
| Idle time | `idling_seconds` | `engine_hour_session` |
| Fuel theft drop | `stolen_ml` | `fuel_theft` |

**Conclusion:** The Excel data is a **flattened trip-level summary**. It tells you what happened over a journey but not second-by-second. It is suitable for backfilling history but cannot power a live dashboard.

### 2b. Live Data — The Device Protocol

Every GPS/FLS hardware unit (identified in our schema as `vehicle.device_id`) can be configured to **push telemetry packets** to a server endpoint at a configurable interval (typically every 30 s while moving, every 5 min while parked). The packet format depends on the vendor but always contains a superset of the Excel columns plus:

- **Exact lat/lng** (the Excel uses human-readable strings like "Garissa Depot")
- **Engine status** (digital I/O pin state: 0 = off, 1 = on)
- **Instant speed** (from GPS Doppler or CAN bus)
- **Instant fuel level** (from FLS sensor voltage → calibrated ml)
- **Cargo weight** (from load cell / axle sensor — if fitted)
- **DTC codes** (optional CAN bus diagnostics)

The device pushes over TCP (binary Galileosky/FMXXXX protocol), HTTP/S POST (REST), or MQTT. The vendor platform can be configured to forward each packet to **your webhook URL** — this is the standard integration pattern and does not require direct SIM/device access.

---

## 3. Schema Additions Required

### 3a. Raw Telemetry Ping (`vehicle_telemetry`)

Every packet from the device creates one row. This is a **write-heavy, read-light** table — ideal for time-series partitioning in Postgres.

```sql
-- Add to prisma/schema.prisma

model VehicleTelemetry {
  id              String   @id @default(cuid())
  vehicleId       String   @map("vehicle_id")
  deviceId        String   @map("device_id")          -- denormalised for fast ingest (no join)
  capturedAt      DateTime @map("captured_at")         -- timestamp from the device (NOT server time)
  receivedAt      DateTime @default(now()) @map("received_at")  -- server receipt time

  -- Position
  lat             Float?
  lng             Float?
  altitudeM       Float?   @map("altitude_m")
  headingDeg      Float?   @map("heading_deg")         -- 0-360 compass bearing
  accuracyM       Float?   @map("accuracy_m")

  -- Motion
  speedKmh        Float?   @map("speed_kmh")           -- instant GPS speed
  engineOn        Boolean  @default(false) @map("engine_on")  -- digital I/O pin

  -- Fuel
  fuelLevelMl     Int?     @map("fuel_level_ml")       -- calibrated FLS reading
  fuelUsedMl      Int?     @map("fuel_used_ml")        -- delta from previous ping

  -- Cargo (if load sensor fitted)
  cargoWeightKg   Float?   @map("cargo_weight_kg")

  -- Raw packet (stored for reprocessing / audit)
  rawPayload      Json?    @map("raw_payload")

  vehicle         Vehicle  @relation(fields: [vehicleId], references: [id])

  @@index([vehicleId, capturedAt])   -- primary query pattern
  @@index([deviceId, capturedAt])    -- ingest path (resolves deviceId → vehicle before insert)
  @@index([capturedAt])              -- Postgres range partition key
  @@map("vehicle_telemetry")
}
```

### 3b. Named Route / Waypoints (`route`, `route_waypoint`)

Defines the expected path (Garissa Depot → Nairobi CBD Warehouse) for a vehicle on a particular trip.

```sql
model Route {
  id              String   @id @default(cuid())
  organisationId  String   @map("organisation_id")
  name            String                             -- "Garissa Depot → NBI CBD Warehouse"
  originName      String   @map("origin_name")
  originLat       Float    @map("origin_lat")
  originLng       Float    @map("origin_lng")
  destinationName String   @map("destination_name")
  destinationLat  Float    @map("destination_lat")
  destinationLng  Float    @map("destination_lng")
  distanceKm      Float?   @map("distance_km")      -- expected / approved distance
  createdAt       DateTime @default(now()) @map("created_at")

  organisation    Organisation    @relation(...)
  waypoints       RouteWaypoint[]
  trips           Trip[]          -- FK added to Trip (optional; trip may be ad-hoc)

  @@index([organisationId])
  @@map("route")
}

model RouteWaypoint {
  id        String  @id @default(cuid())
  routeId   String  @map("route_id")
  sequence  Int                            -- ordering along the route
  name      String?                        -- "Thika Bypass Interchange"
  lat       Float
  lng       Float
  radiusM   Int     @default(200) @map("radius_m")  -- tolerance for "arrived at waypoint"

  route     Route   @relation(...)

  @@index([routeId, sequence])
  @@map("route_waypoint")
}
```

**Existing Trip model** gets one nullable FK added:

```diff
model Trip {
  ...
+ routeId  String?  @map("route_id")
+ route    Route?   @relation(...)
  ...
}
```

### 3c. Geofences (`geofence`, `geofence_violation`)

```sql
model Geofence {
  id             String   @id @default(cuid())
  organisationId String   @map("organisation_id")
  name           String                          -- "Nairobi CBD Delivery Zone"
  type           GeofenceType                    -- CIRCLE | POLYGON
  -- Circle: centre + radius
  centerLat      Float?   @map("center_lat")
  centerLng      Float?   @map("center_lng")
  radiusM        Int?     @map("radius_m")
  -- Polygon: GeoJSON coordinates array stored as Json
  polygonCoords  Json?    @map("polygon_coords")
  isAllowlist    Boolean  @default(true) @map("is_allowlist") -- true=must stay inside, false=must stay outside
  createdAt      DateTime @default(now()) @map("created_at")

  organisation   Organisation       @relation(...)
  vehicles       VehicleGeofence[]  -- which vehicles this fence applies to
  violations     GeofenceViolation[]

  @@index([organisationId])
  @@map("geofence")
}

enum GeofenceType { CIRCLE POLYGON }

model VehicleGeofence {
  vehicleId  String @map("vehicle_id")
  geofenceId String @map("geofence_id")

  vehicle    Vehicle  @relation(...)
  geofence   Geofence @relation(...)

  @@id([vehicleId, geofenceId])
  @@map("vehicle_geofence")
}

model GeofenceViolation {
  id          String   @id @default(cuid())
  vehicleId   String   @map("vehicle_id")
  geofenceId  String   @map("geofence_id")
  driverId    String?  @map("driver_id")
  occurredAt  DateTime @map("occurred_at")    -- time the crossing happened
  resolvedAt  DateTime? @map("resolved_at")   -- when vehicle returned / acknowledged
  lat         Float
  lng         Float
  speedKmh    Float?   @map("speed_kmh")

  vehicle     Vehicle  @relation(...)
  geofence    Geofence @relation(...)
  driver      User?    @relation(...)

  @@index([vehicleId, occurredAt])
  @@index([geofenceId, occurredAt])
  @@map("geofence_violation")
}
```

### 3d. Cargo (`cargo_manifest`)

Attached to a Trip. Weight can come from a load-cell sensor (pushed in the telemetry packet) or entered manually by the dispatcher.

```sql
model CargoManifest {
  id              String   @id @default(cuid())
  tripId          String   @unique @map("trip_id")   -- one manifest per trip
  description     String?                             -- "Maize flour 50 kg bags"
  cargoType       String?  @map("cargo_type")         -- BULK | PACKAGED | LIVESTOCK | HAZMAT
  declaredWeightKg Float?  @map("declared_weight_kg") -- from waybill
  -- Sensor readings (from load cell at departure and arrival)
  departureWeightKg Float? @map("departure_weight_kg")
  arrivalWeightKg   Float? @map("arrival_weight_kg")
  notes           String?
  recordedAt      DateTime @default(now()) @map("recorded_at")

  trip            Trip     @relation(...)

  @@index([tripId])
  @@map("cargo_manifest")
}
```

---

## 4. Live Feed Architecture

### 4a. Ingest Endpoint (Device → Server)

The vendor platform forwards device packets to:

```
POST /api/v1/ingest/telemetry
Authorization: Bearer <device-shared-secret>
```

This is a **separate, public-facing endpoint** that bypasses the user-auth middleware and uses a static API key validated in a dedicated `ingest` middleware. It is rate-limited with the existing `ingestLimiter` (500 req/min).

```
Ingest Handler Logic:
  1. Validate API key header
  2. Parse vendor payload → normalise to our schema fields
  3. Look up vehicle by device_id (cache in Redis for 1 min — biggest perf win)
  4. Resolve current driver via VehicleAssignment WHERE unassigned_at IS NULL
  5. Insert VehicleTelemetry row
  6. Run geofence check (see §4c)
  7. Emit to WebSocket/SSE channel for that vehicle
  8. Return 204
```

Steps 6–7 can be moved to a background job (BullMQ) to keep the HTTP response under 50 ms.

### 4b. Live Feed to Dashboard (Server → Browser)

Two viable options:

| Option | When to Use |
|---|---|
| **Server-Sent Events (SSE)** | Dashboard is read-only, simpler to implement, works through load balancers without upgrade |
| **WebSocket** | Bidirectional needed (e.g. driver acknowledgements, commands) |

Recommended starting point: **SSE**, upgrade to WebSocket when bidirectional features are needed.

```
GET /api/v1/organisations/:orgId/vehicles/:vehicleId/live
Accept: text/event-stream
Authorization: Bearer <user-jwt>
```

The server holds the connection open and pushes events:

```
event: telemetry
data: {"speedKmh":67.3,"engineOn":true,"fuelLevelMl":180000,"lat":-1.286,"lng":37.32,"capturedAt":"2026-06-29T08:04:11Z"}

event: geofence_violation
data: {"geofenceId":"g123","name":"Nairobi CBD Zone","occurredAt":"..."}

event: heartbeat
data: {}
```

### 4c. Geofence Evaluation

Run after every ingest ping for each vehicle. Algorithm depends on fence type:

- **CIRCLE:** `distance(ping.lat, ping.lng, fence.center_lat, fence.center_lng) > fence.radius_m`
- **POLYGON:** point-in-polygon test against `fence.polygon_coords` (use PostGIS `ST_Contains` or a JS library like `@turf/boolean-point-in-polygon`)

If violation detected:
1. Insert `GeofenceViolation` row
2. Emit `geofence_violation` SSE event to any connected dashboard clients
3. Optionally trigger SMS/email alert via a webhook (future)

---

## 5. API Endpoints to Add

### Ingest (device-to-server)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/ingest/telemetry` | Receive raw device packet |

### Live Feed

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/organisations/:orgId/vehicles/:vehicleId/live` | SSE stream for one vehicle |
| `GET` | `/api/v1/organisations/:orgId/vehicles/:vehicleId/telemetry` | Paginated historical pings (cursor) |
| `GET` | `/api/v1/organisations/:orgId/vehicles/:vehicleId/telemetry/latest` | Last known position + state |

### Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/organisations/:orgId/routes` | List routes |
| `POST` | `/api/v1/organisations/:orgId/routes` | Create named route |
| `GET` | `/api/v1/organisations/:orgId/routes/:routeId` | Get route + waypoints |
| `DELETE` | `/api/v1/organisations/:orgId/routes/:routeId` | Delete route |

### Geofences

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/organisations/:orgId/geofences` | List geofences |
| `POST` | `/api/v1/organisations/:orgId/geofences` | Create geofence |
| `PUT` | `/api/v1/organisations/:orgId/geofences/:geofenceId` | Update |
| `DELETE` | `/api/v1/organisations/:orgId/geofences/:geofenceId` | Delete |
| `POST` | `/api/v1/organisations/:orgId/geofences/:geofenceId/vehicles` | Assign vehicle to fence |
| `GET` | `/api/v1/organisations/:orgId/geofences/:geofenceId/violations` | Violation history |

### Cargo

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/organisations/:orgId/trips/:tripId/cargo` | Attach cargo manifest |
| `GET` | `/api/v1/organisations/:orgId/trips/:tripId/cargo` | Get manifest |
| `PATCH` | `/api/v1/organisations/:orgId/trips/:tripId/cargo` | Update weights (arrival reading) |

---

## 6. What the Existing Excel Data Can Be Used For

The Excel exports are a goldmine for **initial data load and baseline analytics**. Here's what you can do without a live feed:

| Goal | How to Use the Excel |
|---|---|
| Seed historical trips | Map each row to `Trip` + `EngineHourSession` |
| Identify high-fuel-consumption vehicles | Already in `avg_consumption_by_fls`, `consumed_ml` |
| Find theft events | Rows flagged as theft map to `FuelTheft` |
| Build the route catalogue | Extract unique `initial_location` + `final_location` pairs → seed `Route` rows |
| Establish geofence baselines | Cluster location strings to find where vehicles commonly operate → define fences |
| Baseline cargo weight | If the Excel has `cargo_type` or tonnage columns, seed `CargoManifest` |

**Import strategy:** Build a one-time Node.js script (`scripts/import-excel.ts`) that:
1. Reads the XLSX using `exceljs` or `xlsx`
2. Maps each row to the appropriate Prisma models
3. Upserts using `deviceId` + `began_at` as the deduplication key

---

## 7. Data Flow Diagram

```
GPS/FLS Device
  │  (every 30 s while moving)
  │  TCP/HTTP/MQTT packet
  ▼
Vendor Platform (Galileosky Hub / Teltonika Codec / Cartrack API)
  │  Webhook forward
  │  POST /api/v1/ingest/telemetry
  ▼
fleet-server Ingest Handler
  ├── Resolve device_id → vehicle (Redis cache, 60 s TTL)
  ├── Resolve vehicle → current driver (VehicleAssignment)
  ├── INSERT vehicle_telemetry
  ├── Geofence evaluation
  │     ├── No violation → continue
  │     └── Violation → INSERT geofence_violation + SSE emit
  └── SSE broadcast to connected clients
        └── GET /live (dashboard, mobile app)

Excel / FTP Report (batch, nightly)
  └── import-excel.ts script
        └── Upsert Trip, EngineHourSession, FuelFilling, FuelTheft
```

---

## 8. New Prisma Schema Fields on Existing Models

These are **additive** — no breaking changes to existing tables:

```diff
model Trip {
+  routeId         String?          @map("route_id")
+  route           Route?           @relation(...)
+  cargoManifest   CargoManifest?
}

model Vehicle {
+  telemetry       VehicleTelemetry[]
+  geofences       VehicleGeofence[]
+  geofenceViolations GeofenceViolation[]
}
```

---

## 9. Implementation Order (Recommended Phases)

### Phase 1 — Schema + Ingest (2–3 days)
1. Add `VehicleTelemetry`, `Route`, `RouteWaypoint`, `Geofence`, `VehicleGeofence`, `GeofenceViolation`, `CargoManifest` to `schema.prisma`
2. Run `prisma migrate dev`
3. Build `POST /api/v1/ingest/telemetry` — store raw pings (no geofence logic yet)
4. Test with a simulated device payload (Postman / curl)

### Phase 2 — Live Feed (1–2 days)
1. Implement SSE endpoint `GET /live` using Node.js `res.write` + `keep-alive`
2. Wire ingest handler to broadcast after insert
3. Add Redis pub/sub if you later need multi-instance support (one process writes, all broadcast)

### Phase 3 — Geofencing (2 days)
1. CRUD endpoints for `Geofence` + `VehicleGeofence`
2. Post-ingest geofence evaluation function
3. Violation recording + SSE event type

### Phase 4 — Routes + Cargo (1–2 days)
1. CRUD for `Route` + `RouteWaypoint`
2. `routeId` FK on `Trip` (link at trip creation time)
3. `CargoManifest` CRUD attached to trip
4. Optional: waypoint progress tracking (which waypoint is the vehicle nearest to?)

### Phase 5 — Excel Backfill (1 day)
1. `scripts/import-excel.ts` using `exceljs`
2. Map Excel columns → Prisma upserts
3. Run once per historical export

---

## 10. Key Technology Decisions

| Decision | Choice | Reason |
|---|---|---|
| Live push protocol | SSE (upgrade to WS later) | Simpler, load-balancer friendly, sufficient for read-only dashboards |
| Geofence geometry | PostGIS `ST_Contains` OR `@turf/boolean-point-in-polygon` | PostGIS is more powerful; Turf is zero-infra and works on Supabase without extension setup |
| Telemetry storage | Postgres (partitioned by `captured_at` month) | Already on Supabase; add `pg_partman` extension when volume exceeds ~10 M rows |
| Device auth | Static API key per device/org in request header | Simpler than JWT for embedded hardware; rotate keys via admin API |
| Ingest caching | Redis (vehicle lookup by `device_id`) | One DB lookup per device every 60 s instead of every ping |
| Excel import | `exceljs` npm package | Handles `.xlsx` natively, streams large files |

---

## 11. Vendor Integration Notes

Most GPS vendors offer a **"data forwarding"** or **"3rd party platform"** setting in their admin panel:

- **Galileosky Hub** → Settings → Data forwarding → HTTP POST → your URL
- **Teltonika (FMXXXX)** → Codec 8/8E → configure server IP + port or use their Cloud connector
- **Cartrack / MiX Telematics** → REST API pull (your server polls their endpoint every N seconds)
- **Generic NMEA GPS** → Direct TCP server on your infra (more complex; avoid unless required)

If the organisation already has a vendor platform, the **webhook push approach** is fastest to integrate and requires no changes to the device firmware or SIM configuration.
