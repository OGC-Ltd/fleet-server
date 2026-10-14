# Navigation Connect: driver app, service account, trip flow

Status: ON HOLD since 2026-10-14, at the operator's request: shelved for
implementation in the near future. Nothing in this document is built. Phase 0
has not been run. The Navigation Connect API is enabled on the Google Cloud
project, and none of the other cloud setup has been done. Before picking this
up again, check the Google docs: the API was pre-GA when this was written.

## What this does, and what it can't do

Navigation Connect gives the server a live position, an ETA, remaining
distance and time, and (Enterprise SKU) the remaining road route. It gets these
from the **driver's phone while the driver navigates in Google Maps for Android
or Waze**. They are not taken from the Wialon tracker. A trip covers one
destination. Google issues a token for the trip, our own verified Android app
hands that token to Google Maps, and Google then sends updates to our Google
Cloud project.

What follows from that:

- **The phone needs an app.** A link sent by SMS or WhatsApp can't start a
  trip. Google Maps checks which app launched it (`EXTRA_REFERRER_NAME`), and
  that app has to be one Google has verified.
- **The phone is not the truck.** The phone's position goes alongside the
  Wialon fix and never replaces it. If the two are more than about 500 m apart,
  the driver isn't in the unit, and the UI should say so.
- **When Google stops reporting, the tracker takes over.** If a trip ends in
  `FAILED`, `CLIENT_ERROR` or `SUSPENDED`, there are no more updates. The panel
  then falls back to the Wialon position and the straight-line distance left.
- **These platforms are not supported:** iOS Google Maps, Android Auto,
  CarPlay, browsers, and Incognito mode in Maps.
- **Version limits:** reporting the remaining route needs Google Maps for
  Android 26.27 or later, or Waze 5.20 or later.
- **It's pre-GA.** Usage is free during Preview, the API can change without
  notice, and Google publishes no country list for Kenya or Tanzania. Phase 0
  answers that question before anything else gets built.

## Phase 0: prove it works here (about 1 day, before any code)

1. Pick one driver who has an Android phone and current Google Maps.
2. Create a trip by hand with `curl` and the service account (see below).
3. Launch it from a throwaway debug build of the app in Phase 2. Watch the trip
   reach `ENROUTE`, then check that GetTrip returns a position and ETA on a real
   road in Kenya.

If the trip stays at `NEW`, or Google refuses the region, stop here. The
Routes API alternative (Wialon position, road route, ETA, no phone needed) is
still available.

## 1. Google Cloud setup (one project: the one where the API is enabled)

Order matters. Each step depends on the one before it.

| # | Step | Detail |
|---|---|---|
| 1 | Billing on | Required even during Preview. |
| 2 | Enable APIs | **Navigation Connect API** (done) and **Cloud Pub/Sub API**. |
| 3 | Service account | `gcloud --project=$P iam service-accounts create navigationconnect` |
| 4 | Roles on it | `roles/navigationconnect.admin` and `roles/iam.serviceAccountTokenCreator`. The server only needs `navigationconnect.viewer` for reads, but CreateTrip needs admin, so it gets admin. |
| 5 | Pub/Sub topic | The name must be exactly **`navigation_connect_trip_notifications`**. Any other name and Google won't publish to it. |
| 6 | Let Google publish | On that topic only, grant `roles/pubsub.publisher` to `geo-navigation-connect-pubsub@system.gserviceaccount.com`. |
| 7 | Subscription | A **pull** subscription called `fleet-server-navconnect`, with 7-day retention and the ack deadline at 60 s. Grant the service account `roles/pubsub.subscriber` on it. |
| 8 | Credentials on the box | See below. |
| 9 | Verify the app | Maps Platform → Keys & Credentials → **Start verification**, using the Android package name. Google requires the app to be **published**, and approval takes a few days. Ask Google first whether a Play internal-testing track is enough. |

**Credentials.** The box runs on AWS (af-south-1), so there are no Google
default credentials from the instance metadata. There are two options:

- **Workload Identity Federation (recommended).** Add an AWS provider to a
  workload identity pool, so the EC2 instance role can impersonate
  `navigationconnect@`. No key file sits on disk, and nothing needs rotating.
- **Service-account JSON key (faster).** Put it at
  `~/prod/secrets/navconnect.json` with `chmod 600`. Remember that
  `.env.example` is committed with live secrets in it, so the key goes in
  neither `.env.example` nor `.env`. Only the path goes there:
  `NAVCONNECT_CREDENTIALS=/home/ubuntu/prod/secrets/navconnect.json`.

New environment variables: `NAVCONNECT_ENABLED` (off by default),
`NAVCONNECT_PROJECT_ID`, `NAVCONNECT_CREDENTIALS`,
`NAVCONNECT_SUBSCRIPTION`, `NAVCONNECT_ANDROID_APP_ID`. In development they
need setting in both `.env` and `.env.example`.

## 2. Driver app (Android only)

**Stack: native Kotlin with Jetpack Compose, one activity.** The launch is a
native `Intent` with two extras, `EXTRA_REFERRER_NAME` and a `PendingIntent`
under the key `"pendingIntent"`. Expo or React Native would need a custom
native module just to do that, and the app has no other screens that would
justify a cross-platform toolkit. A sensible package name is
`co.ke.raioperations.driver`. It's permanent once Google has verified it.

Screens:

1. **Pair.** Enter the 6-digit code shown to the dispatcher. Drivers have no
   email or password: they're synced from FactorySuite with `email` and
   `passwordHash` both NULL. The current login can't serve them, and there's no
   SMS provider to send OTPs.
2. **My trip.** Shows the unit, the destination and the dispatcher's note, with
   a **Start navigation** button and a Maps / Waze choice. If nothing is
   assigned, it says **No trip assigned**.
3. **Returned from Maps.** The `PendingIntent` lands here. It shows the trip
   state, plus **Resume** if the trip is `SUSPENDED` with distance left, or
   **Arrived**.

What happens when the driver taps **Start navigation**:

```kotlin
val url = "https://www.google.com/maps/dir/?api=1" +
  "&destination=$lat,$lng&dir_action=navigate&action_token=${Uri.encode(token)}"
// Waze: https://waze.com/ul?ll=$lat,$lng&navigate=yes&external_trip_token=$token
val i = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
  setPackage("com.google.android.apps.maps")            // or "com.waze"
  putExtra(Intent.EXTRA_REFERRER_NAME, "android-app://$packageName")
  putExtra("pendingIntent", PendingIntent.getActivity(ctx, 0,
    Intent(ctx, TripActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
}
startActivity(i)
```

The destination is always `lat,lng`. Waze takes the first search result for an
address string, and dispatch destinations are freehand names such as "OPAPO".

**How the trip reaches the phone.** The app fetches it when it opens. A
Firebase Cloud Messaging data message wakes the app when a trip is assigned.
FCM uses the same Google project. If FCM is left out, the driver opens the app
when the dispatcher calls them.

**Distribution.** Publish to Google Play (the developer account costs USD 25
once). Verification needs it published, and it also handles updates. The app
needs no location permission of its own, because Google Maps does the
tracking.

## 3. Server: `src/modules/navigation`

### Data

```prisma
/// One Navigation Connect trip: one destination, one Google trip token.
model NavTrip {
  id              String    @id            // UUIDv4, also Google's tripId
  organisationId  String    @map("organisation_id")
  vehicleId       String    @map("vehicle_id")
  driverId        String    @map("driver_id")
  dispatchId      String?   @map("dispatch_id")      // when raised from a dispatch
  createdById     String    @map("created_by_id")    // the dispatcher
  destLabel       String    @map("dest_label")
  destLat         Float     @map("dest_lat")
  destLng         Float     @map("dest_lng")
  /// NEW | ENROUTE | ARRIVED | SUSPENDED | FAILED | CLIENT_ERROR | CANCELED,
  /// plus our own EXPIRED (token unused after 12 h).
  state           String
  tokenExpiresAt  DateTime  @map("token_expires_at")
  originLat       Float?    @map("origin_lat")
  originLng       Float?    @map("origin_lng")
  lastLat         Float?    @map("last_lat")
  lastLng         Float?    @map("last_lng")
  lastFixAt       DateTime? @map("last_fix_at")       // execution.location.sourceTime
  etaAt           DateTime? @map("eta_at")
  remainingM      Int?      @map("remaining_m")
  remainingS      Int?      @map("remaining_s")
  traveledM       Int?      @map("traveled_m")
  remainingRoute  Json?     @map("remaining_route")   // GeoJSON, Enterprise only
  startedAt       DateTime? @map("started_at")
  endedAt         DateTime? @map("ended_at")
  createdAt       DateTime  @default(now()) @map("created_at")
  @@index([vehicleId, createdAt])
  @@index([driverId, state])
  @@map("nav_trips")
}

/// A driver's paired phone. Holds a hash of the token, never the token itself.
model DriverDevice {
  id          String    @id @default(cuid())
  driverId    String    @map("driver_id")
  tokenHash   String    @unique @map("token_hash")
  fcmToken    String?   @map("fcm_token")
  label       String?                                  // "Tecno Spark 20"
  pairedById  String    @map("paired_by_id")
  pairedAt    DateTime  @default(now()) @map("paired_at")
  lastSeenAt  DateTime? @map("last_seen_at")
  revokedAt   DateTime? @map("revoked_at")
  @@map("driver_devices")
}
```

Pairing codes live in Redis for 10 minutes, keyed by code and pointing at the
driver ID, so they need no table. Migration first, then the deploy. The
`Dispatch` note on RETURNING applies here too.

### Endpoints

Dashboard side, under the existing auth and a new `navigation:manage`
permission:

| Method | Path | Does |
|---|---|---|
| POST | `/api/drivers/:id/pairing-code` | Issues a 6-digit code (Redis, 10 min). |
| DELETE | `/api/driver-devices/:id` | Revokes a phone. |
| POST | `/api/nav-trips` | `{vehicleId, driverId, destination: {lat,lng,label} \| {dispatchDestinationId}}`. Calls CreateTrip and sends the FCM nudge. |
| POST | `/api/nav-trips/:id/cancel` | Marks the trip CANCELED on our side (see open questions). |
| GET | `/api/vehicles/:id/nav-trip` | The unit's active trip, for the panel. |

Driver side, using a `Bearer` device token and a separate middleware. These
are not dashboard sessions:

| Method | Path | Does |
|---|---|---|
| POST | `/api/driver/pair` | `{code, label}` → `{deviceToken}`. Rate-limited per IP. |
| GET | `/api/driver/trip` | The driver's current NEW, ENROUTE or SUSPENDED trip, with token and destination. |
| POST | `/api/driver/fcm` | Registers or refreshes the FCM token. |

The trip token goes to the paired device and nowhere else. Google rejects a
token reused on a second trip with `CLIENT_ERROR`, so **Resume** after
`SUSPENDED` creates a new trip.

### Google client (`src/providers/navconnect`)

- `google-auth-library` mints the access token: a key file, or an external
  account config for WIF. It caches the token until 5 minutes before it
  expires.
- `createTrip(id)`: `POST https://navigationconnect.googleapis.com/v1/projects/{P}/trips?tripId={id}`
  with this body:
  `{androidAppId, config: {enablePubsub: true, enableRemainingRouteReporting: true}}`.
  The response gives `authToken.token` and `authToken.expireTime`, which is
  12 hours away.
- `getTrip(id)`: the fallback when Pub/Sub goes quiet. Call it with
  `routePolylineFormat=GEO_JSON`.
- Leave `enableHighFrequencyUpdates` off. The default rate is one update every
  60 seconds, which matches how often the map's unit positions move anyway.
  Five-second updates switch to Enterprise pricing at GA.

### Update ingest

- A `@google-cloud/pubsub` **streaming pull** subscriber starts inside the
  fleet-server process when `NAVCONNECT_ENABLED` is set, so no public push
  endpoint has to sit behind LiteSpeed. It runs in the main app rather than the
  report worker because the main app owns the SSE streams.
- Each message carries the GeoJSON FeatureCollection. The subscriber looks up
  the `NavTrip` by trip ID, updates the row, and emits a `nav_trip` event
  through `lib/event-bus.ts` and `lib/sse.ts` **with `vehicleId` set**. This
  matters because `visibleTo` fails closed for scoped viewers. It acks the
  message after the database write. Duplicates are harmless, because the row
  is just the latest state.
- On `ENROUTE` it sets `startedAt` and the origin from the first fix. On
  `ARRIVED`, `FAILED`, `CLIENT_ERROR` or `CANCELED` it sets `endedAt`, and on
  `ARRIVED` it posts a Live Feed item ("KDE 585S arrived at OPAPO").
- A BullMQ repeat job runs every 5 minutes:
  - Any ENROUTE trip with no update for 3 minutes gets a GetTrip call.
  - Any `NEW` trip past `tokenExpiresAt` becomes `EXPIRED`.
  - Any ENROUTE trip with no update for an hour is treated as FAILED.

The full Pub/Sub message schema is not on Google's page. Phase 0 records one
real message into `tests/fixtures/navconnect/`, and the parser is written
against that.

## 4. Dashboard (new-ui)

On the tracked unit's panel, a **Navigation** block:

- With no trip: **Send route to driver**. Pick the driver (prefilled from the
  current `VehicleAssignment`). Pick the destination from three sources:
  1. a `DispatchDestination` point. Offer only points with `samples >= 3` and
     `spreadM <= 1000`, because a spread-out zone isn't a point.
  2. a geofence centre.
  3. a click on the map.
  If the driver has no paired phone, the block says so and offers
  **Pair phone**, which shows the code.
- With a trip: origin pin, destination pin, the remaining route line (from
  Google), ETA, km and time left, and the state in words. A second, faint
  marker shows the phone position whenever it is more than 500 m from the
  Wialon fix, with the note **Phone is away from the unit**.
- After FAILED, CLIENT_ERROR or SUSPENDED: **Navigation stopped**, and the
  block switches to the tracker position with the straight-line distance left.

The map work goes through `lib/mapEngine.js` (Leaflet). Panning uses
`map.setView`.

## 5. Phases

| Phase | Delivers | Verified by |
|---|---|---|
| 0 | Manual trip on one phone, one real Pub/Sub message saved | ENROUTE seen, ETA plausible on a Kenyan road |
| 1 | Cloud setup + `NavTrip`/`DriverDevice` migration + provider + ingest, flag off | Unit tests on the saved fixture; GetTrip from the box |
| 2 | Driver app (pair, trip, launch, return) on Play internal track; app verification submitted | Pair → start → ENROUTE end to end with one driver |
| 3 | new-ui Navigation block + send / pair flows | Dispatcher sends a route; panel shows ETA moving |
| 4 | Pilot with one org (Sukari or Menengai), 5 drivers, 2 weeks | Share of trips reaching ARRIVED vs FAILED/SUSPENDED |
| later | Auto-offer a trip when a FactorySuite dispatch arrives | Needs `Dispatch.driverName` (free text) resolved to a `User` first |

## Open questions to settle before Phase 2

1. **Phones.** How many drivers actually carry Android phones with Google Maps
   26.27 or later? Who pays for the data? This is the adoption limit, and
   nothing in the software changes it.
2. **Which Play developer account and package name.** Both are permanent once
   Google verifies them.
3. **Consent and privacy.** Google shows its own consent screen. Under the
   Kenya Data Protection Act, the drivers' employer still needs a notice, and
   location is collected **only during a trip**.
4. **Cancelling.** Can a trip be cancelled on Google's side? The API docs don't
   show a cancel call. Until they do, our cancel only stops us from displaying
   the trip, and the driver must exit Maps.
