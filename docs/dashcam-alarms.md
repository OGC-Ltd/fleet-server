# Dashcam alarms (Control Tech VSS)

The backend for the dashboard's **Alarms** tab: each dashcam alarm (harsh
turn, no seat belt, fatigue, rollover…) with its clip and snapshot.

## Routes

| Route | Answer |
|---|---|
| `GET /api/v1/vss/cameras?org=<orgId>` | `{ cameras: n }`: how many of the org's vehicles (in the caller's scope) have a VSS device. 0 hides the tab. |
| `GET /api/v1/vss/alarms?org=<orgId>&since=<ISO>` | `{ incidents: [...], cameras, from, to, partial? }`: alarms with evidence, newest first (max 7 days back). |
| `GET /api/v1/vss/file?org=<orgId>&k=<key>[&download=1]` | The clip or snapshot, streamed. `Range` is passed through (206), so video can seek. |

The organisation comes as `?org=` because that is the dashboard's contract
(new-ui `src/api/vssAlarms.js`). `orgFromQuery` puts it in `req.params.orgId`,
so the **standard checks** apply:
- `authenticate`, `requireOrgAccess` and `requirePermission('vehicle:read')`
- the caller's vehicle scope (`req.authz.vehicleIds`) limits which vehicles' cameras and alarms they see.

## Files

**New:**
- `src/modules/dashcam/dashcam.routes.ts`: the three routes, including file streaming.
- `src/modules/dashcam/dashcam.service.ts`: vehicles to devices, the evidence search, alarm details, private file links, caching.
- `src/modules/dashcam/vss-match.ts`: device ↔ vehicle matching, shared with the live camera.
- `src/modules/dashcam/vss-events.ts`: the 186 alarm codes (name, group, severity) and the inbox categories.

**Changed:**
- `src/providers/vss/index.ts`:
  - one paced queue for every VSS request (≥ 2 s apart)
  - 90 s back-off after 10129 "Requests too frequent"
  - `vssCall`, `fetchVssFile` and `isVssFileUrl`
- `src/modules/camera/camera.service.ts`: uses the shared matching. The live camera now also finds "SUKARI - KDR 430Q" for plate "KDR 430Q".
- `src/config/env.ts`: `VSS_TIMEZONE` (optional, default `Africa/Nairobi`), the zone VSS writes its times in.
- `src/app.ts`: mounts the routes at `/api/v1/vss`.

No new settings are required: it uses the existing `VSS_BASE_URL`,
`VSS_USERNAME` and `VSS_PASSWORD`. No database changes.

## What the live VSS (v2.8) requires

These were found against production on 23 Oct 2026. The same rules run in
`vss.php` on cPanel.

1. **Search:** `/vss/record/findRecords.action` (§3.24) with every device of the org in `deviceIdList`. It returns one row per **file**; rows are grouped by `alarmGuid`.
2. **Rate limit:** a second §3.24 page 2 s after the first was refused (10129). The module handles it like this:
   - pages of 2,000, with ≥ 10 s between searches and ≥ 2 s between any calls
   - one search per org at a time, with answers reused for 90 s
   - back off after a 10129, and keep the pages already received if a later one is refused
   - if VSS is busy and an older answer exists, serve it with `stale: true`
3. **Alarm type:** §3.24 rows carry `alarmType: null`. Type, time, GPS (`"lng,lat"`) and speed come from `/vss/alarm/getAlarmByIds.action` (§3.25). They're kept in memory, and at most 300 are looked up per visit (newest first).
4. **Matching:** VSS names devices `"SUKARI - KDR 430Q"`. The registration after the prefix is matched only when it looks like one, so a bare `"FT 13"` never is.
5. **Files:**
   - **Host:** the VSS host on another port (e.g. `:9988`). Links carry a VSS token, so they're kept server-side and the browser only gets `/api/v1/vss/file?k=…`.
   - **Content type:** VSS labels everything `application/octet-stream`, so the real type is read from the first bytes.
   - **416:** VSS answers 416 to a range past the end of a small file, so the file is asked for again without the range.
   - **Clips:** H.264 MP4, with the index at the end.

## Limits

State (caches, pacing, file keys) is in memory in one process:
- **After a restart,** clip links listed before it answer 404 until the dashboard re-reads the alarms, which it does every 2 minutes.
- **With two instances,** each would pace VSS on its own.
