# Dashcam alarms: archive to S3, and control what the platform shows

Status: guide, nothing built yet (7 Nov 2026).
Scope: fleet-server `modules/dashcam`, `providers/vss`; new-ui `api/vssAlarms.js`,
`DashcamIncidentsScreen.jsx`.

---

## 1. How it works today

```
browser ──/api/v1/vss/alarms──▶ dashcam.service.getAlarms ──§3.24 findRecords──▶ VSS
                                   │  (90 s cache, 7 days max, in memory)
                                   └─ fileLink(): sha1(vss url) → in-memory map
browser ──/api/v1/vss/file?k=──▶ dashcam.routes /file ──fetchVssFile (Range)──▶ VSS file server
```

| Piece | Where | What it means for archiving |
| --- | --- | --- |
| Alarm search | `findEvidence()` in `dashcam.service.ts` | Run on demand when someone opens the page. Rate-limited hard by VSS (10129), so searches are paced 10 s apart, one per org. |
| Alarm details | `alarmDetails()` | Type, time, GPS, speed from §3.25. Kept in memory only. |
| File links | `fileLink()` / `fileFor()` | The VSS URL (it carries a VSS token) stays in process memory under a sha1 key. **A restart forgets every key**; the page re-reads to get new ones. |
| File serving | `GET /vss/file` | Streams from VSS with the browser's Range passed through. Content type is sniffed from the first bytes (VSS says `octet-stream`). |
| Window | `MAX_DAYS = 7` | Nothing older than 7 days can be shown, and once VSS drops a file it is gone for us too. |
| What is shown | Everything with evidence | All codes, all severities, all channels. Severity comes from the fixed table in `vss-events.ts`; filtering is only the client's chips. |
| Persisted | `dashcam_alarm_feedback` only | No alarm, file or media row exists in our database. |

Volume to plan for (measured 27 Oct): Sukari alone had **433 alarms in one day**
(88 critical, 149 warning, 196 info). 7 organisations have paired cameras
(~510 devices). Each alarm carries 0–n files (one per channel, video and/or photo).
Clip size has **not been measured**; do that first (section 7, step 0).

---

## 2. Target design

```
                    ┌──────────── report-worker / BullMQ "dashcam" queue ───────────┐
VSS §3.24 search ◀──┤ dashcam:discover (every 2 min per org, the ONLY searcher)       │
                    │   → upsert DashcamAlarm + DashcamMedia (state = pending)       │
VSS file server ◀───┤ dashcam:archive (per media, concurrency 2–3)                   │
                    │   → stream VSS → S3 multipart Upload (no disk)                 │
                    │   → state = stored | retry | missing                           │
                    └─────────────────────────────────────────────────────────────────┘
                                         │
browser ─/vss/alarms─▶ read DashcamAlarm rows (policy applied) ── fast, survives restarts, > 7 days
browser ─/vss/file?k=▶ stored? 302 to presigned S3 GET (5 min) : proxy VSS as today (+ tee to S3)
```

Three changes of principle:

1. **The database becomes the source of the alarms list.** VSS is searched by one
   background job per org, not by page visits. This also takes load off the VSS
   rate limit: today every org's viewers share a 90 s cache; afterwards nobody's
   visit triggers a VSS search at all.
2. **Files are copied to S3 once, on discovery**, not only when someone plays
   them. "As we stream them" is covered twice: the archiver streams each file
   VSS → S3 without touching disk, and a clip someone plays before the archiver
   reaches it is teed into S3 from the same stream (section 4.3).
3. **What is shown is decided on the server by a per-organisation policy**
   (section 5), never only by client chips.

---

## 3. AWS setup (one time, in the console)

Region: **af-south-1**, same as the box and RDS. No cross-region transfer, and
the data stays in the region the POPIA plan assumes.

| Item | Value |
| --- | --- |
| Bucket | `raitrack-dashcam-<env>` (e.g. `raitrack-dashcam-prod`), af-south-1 |
| Block Public Access | All four ON |
| Object ownership | Bucket owner enforced (ACLs off) |
| Encryption | SSE-S3 (default). SSE-KMS only if an auditor asks; it adds per-request KMS cost. |
| Versioning | Off (objects are write-once; versioning only doubles storage on re-uploads) |
| CORS | Only needed if the browser `fetch()`es S3 directly (see 4.4). Allow `GET, HEAD` from `https://logistics.raioperations.com`, expose `Content-Range, Content-Length, ETag`. |
| Lifecycle | See 3.1 |

**Credentials: an EC2 instance role, not keys in `.env`.** fleet-server's dev
loads `.env.example`, which is committed with live secrets; AWS keys must never
go there. Attach a role to the box with exactly:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:AbortMultipartUpload", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::raitrack-dashcam-prod/dashcam/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::raitrack-dashcam-prod",
      "Condition": { "StringLike": { "s3:prefix": "dashcam/*" } } }
  ]
}
```

The AWS SDK picks the role up from the instance metadata with no config. Check
on the box with `curl -s http://169.254.169.254/latest/meta-data/iam/info`
(IMDSv2 needs a token first) before writing code that depends on it. If the
containers plan goes ahead, the role still works from inside Docker as long as
the IMDS hop limit is 2.

### 3.1 Retention (decision needed)

Suggested starting point, to confirm with operations and legal:

| Age | Storage class | Why |
| --- | --- | --- |
| 0–30 days | S3 Standard | Review happens in the first days |
| 30–90 days | Standard-IA | Rarely opened, still instant |
| 90–365 days | Glacier Instant Retrieval | Disputes, insurance claims |
| > 365 days | Expire | Unless the alarm is on legal hold (see 5.3) |

Info-severity alarms can expire much earlier (e.g. 30 days) with a second
lifecycle rule on a tag `sev=info`, set at upload. Objects under 128 KB (photos)
are billed as 128 KB in IA/Glacier IR, so keep photos in Standard or tag them to
skip the transitions.

Lifecycle rules handle deletion in S3; the database rows must follow, so the
cleanup job (section 6) marks `DashcamMedia.state = expired` for anything older
than the bucket's rule.

---

## 4. Server build

### 4.1 Schema (one migration, `SET lock_timeout = '5s'` first)

```prisma
model DashcamAlarm {
  id             String    @id               // VSS alarm guid
  organisationId String    @map("organisation_id")
  vehicleId      String    @map("vehicle_id")
  deviceId       String    @map("device_id")
  plate          String    @default("")
  code           Int
  category       String                      // braking | speeding | driver | collision | geofence | other
  severity       String                      // critical | warning | info (from vss-events, before policy)
  occurredAt     DateTime? @map("occurred_at")
  lat            Float?
  lng            Float?
  speed          Int?
  hiddenAt       DateTime? @map("hidden_at") // per-alarm moderation (5.3)
  hiddenBy       String?   @map("hidden_by")
  hiddenReason   String    @default("") @map("hidden_reason")
  legalHold      Boolean   @default(false) @map("legal_hold")
  discoveredAt   DateTime  @default(now()) @map("discovered_at")
  media          DashcamMedia[]

  @@index([organisationId, occurredAt(sort: Desc)])
  @@index([vehicleId, occurredAt(sort: Desc)])
  @@map("dashcam_alarms")
}

model DashcamMedia {
  id          String    @id @default(cuid())
  alarmId     String    @map("alarm_id")
  kind        String                         // video | photo
  channel     Int
  label       String                         // "Road camera", "In cabin"
  fileType    Int       @map("file_type")    // VSS fileType 1–4
  vssUrlHash  String    @map("vss_url_hash") // sha1(vss url): the same key /vss/file uses today
  vssUrl      String    @map("vss_url")      // carries a VSS token; never sent to a browser
  state       String    @default("pending")  // pending | uploading | stored | missing | failed | expired
  attempts    Int       @default(0)
  nextTryAt   DateTime? @map("next_try_at")
  lastError   String    @default("") @map("last_error")
  s3Key       String?   @map("s3_key")
  bytes       BigInt?
  contentType String?   @map("content_type")
  storedAt    DateTime? @map("stored_at")
  alarm       DashcamAlarm @relation(fields: [alarmId], references: [id], onDelete: Cascade)

  @@unique([alarmId, vssUrlHash])
  @@index([state, nextTryAt])
  @@map("dashcam_media")
}
```

Keeping `vssUrlHash` as the key means the browser's `/api/v1/vss/file?k=<sha1>`
links keep their exact shape, so **new-ui needs no change for archiving**
(`vssAlarms.js` only accepts URLs starting with `/api/v1/vss/file?`). The
difference is that the key now resolves from the database, so links survive
restarts and are no longer limited to 9 days.

### 4.2 Discovery job (`src/lib/queues/dashcam.ts`)

Same shape as `lib/queues/trips.ts`: a BullMQ repeatable, off without
`REDIS_URL`, and behind its own flag.

- `DASHCAM_ARCHIVE_ENABLED` **default `false`**. (Every other queue flag defaults
  to `true`, which once made a non-live box call Wialon. Do not repeat that.)
- Every 2 minutes, for each org with paired cameras: run the existing
  `findEvidence()` + `alarmDetails()` from `dashcam.service.ts` over a window of
  the last 30 minutes (overlap is free: the guid is the primary key). Keep
  `searchPaced()`; the worker and the web process must not both search, so once
  this job is on, `getAlarms()` stops calling VSS (4.5).
- Upsert alarms; insert media with `ON CONFLICT DO NOTHING` on
  `(alarmId, vssUrlHash)`; enqueue one `dashcam:archive` job per new media,
  **only when the policy says archive** (5.1).
- Backfill once on first start: the last 7 days (VSS's own limit), paged as today.

Run it in the **report-worker** pm2 app, not the web server: large uploads on the
t3.medium should not compete with API requests.

### 4.3 Archive job

```ts
import { S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'

const s3 = new S3Client({ region: env.DASHCAM_S3_REGION })   // role credentials from IMDS

async function archive(m: DashcamMedia & { alarm: DashcamAlarm }) {
  const up = await fetchVssFile(m.vssUrl)                    // no Range: the whole file
  if (up.statusCode === 404 || up.statusCode === 416) return retryLater(m, 'not on VSS yet')
  if ((up.statusCode ?? 500) >= 400) return retryLater(m, `VSS ${up.statusCode}`)
  const first = await peek(up)                               // sniff the type as /vss/file does today
  const contentType = sniff(first, up.headers['content-type'])
  const key = s3KeyFor(m, contentType)
  await new Upload({
    client: s3,
    params: { Bucket: env.DASHCAM_S3_BUCKET, Key: key, Body: up, ContentType: contentType,
              Tagging: `org=${m.alarm.organisationId}&sev=${m.alarm.severity}` },
    queueSize: 2, partSize: 8 * 1024 * 1024,                 // ~16 MB RAM per upload
  }).done()
  await markStored(m, key, contentType)
}
```

- Key layout: `dashcam/{orgId}/{yyyy}/{mm}/{dd}/{alarmGuid}/{channel}-{kind}-{n}.{mp4|jpg}`.
  Org first, so a whole organisation can be exported or deleted by prefix.
- Lift the content sniffing out of `dashcam.routes.ts` into a shared helper so the
  route and the archiver agree.
- Concurrency 2–3. VSS's file server has not shown a rate limit, but it has not
  been tested under load either; start low and watch.
- Retries: VSS answers 404 while a device has not uploaded the clip yet (normal for
  minutes to hours after the alarm). Back off 5 min → 15 → 1 h → 6 h; after 48 h
  mark `missing`. A VSS token refused (the URL's token expired) means re-reading
  the alarm through §3.24 for a fresh URL, not retrying the old one.
- **Tee while streaming:** in `GET /vss/file`, when the browser asks for the whole
  file (no Range, or `bytes=0-`) and the media is not yet stored, pipe the same
  VSS stream into an `Upload` as well as the response (a `PassThrough` each). If
  the browser disconnects early, abort the upload and leave the job to the
  archiver. Range requests (seeking) are never teed.

### 4.4 Serving from S3

In `GET /vss/file`, after the existing checks (signed in, org access,
`vehicle:read`, vehicle in scope, **and the render policy**, 5.2):

- `state = stored` → `302` to a presigned `GetObject` URL, 5-minute expiry, with
  `ResponseContentDisposition` set when `download=1`. S3 serves Range itself, so
  seeking works, and the video bytes no longer pass through the box.
- otherwise → proxy VSS exactly as today (with the tee above).

Two things to check in the browser when this lands:
- `<video>` and `<img>` follow the redirect without CORS. `lib/mediaDiagnose`
  `fetch()`es the file route for two bytes when a clip fails; a `fetch` that
  follows a redirect to S3 **does** need the bucket CORS rule in section 3.
- The redirect target is a different origin: add the bucket host
  (`raitrack-dashcam-prod.s3.af-south-1.amazonaws.com`) to `media-src` and
  `img-src` if a Content-Security-Policy is ever set.

If keeping all traffic on our domain matters more than box bandwidth, stream
from S3 instead (`GetObject` with the Range passed through). Same route, no
client change, no CORS. The presigned redirect is recommended because the box
is a t3.medium and video is the heaviest thing it would ever serve.

### 4.5 `GET /vss/alarms` from the database

With the archiver on, `getAlarms()` reads `dashcam_alarms` + `dashcam_media`
for the org, the caller's vehicle scope and the period, applies the policy, and
returns the **same JSON** as today. Benefits: no VSS wait (Sukari's search took
11 s), no `partial`/`stale` answers, and the 7-day cap can be lifted to whatever
retention allows. Keep the current VSS path behind the flag as the fallback while
the flag is off.

Add to each media item (optional for the client): `archived: true|false`.

### 4.6 New env keys

| Key | Default | Notes |
| --- | --- | --- |
| `DASHCAM_ARCHIVE_ENABLED` | `false` | Starts discovery + archive jobs |
| `DASHCAM_S3_BUCKET` | `''` | Empty = archiving off even if the flag is on |
| `DASHCAM_S3_REGION` | `af-south-1` | |
| `DASHCAM_PRESIGN_SECONDS` | `300` | |

Packages: `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`.

---

## 5. Controlling what the platform shows

Today the server returns every alarm that has evidence. That is why the map rail
count is large (Sukari: 237 warning + critical a day), and why in-cabin footage
of drivers is visible to anyone with `vehicle:read`.

### 5.1 Per-organisation policy

One row per org, edited in Settings by an admin:

```prisma
model DashcamPolicy {
  organisationId  String   @id @map("organisation_id")
  /// Alarms below this are not listed (still archived if `archive` says so).
  minSeverity     String   @default("info") @map("min_severity")  // info | warning | critical
  /// Per-code overrides: { "<code>": { "show": false, "archive": false, "severity": "critical" } }
  codes           Json     @default("{}")
  /// Categories switched off entirely (e.g. ["geofence"]).
  hiddenCategories String[] @default([]) @map("hidden_categories")
  /// Alarms with no clip or photo: list or not.
  showWithoutMedia Boolean @default(false) @map("show_without_media")
  /// Channels by label pattern that need dashcam:cabin to view, e.g. ["in cabin", "driver"].
  restrictedChannels String[] @default(["in cabin", "driver"]) @map("restricted_channels")
  /// Hide alarms whose latest feedback verdict is false_alarm.
  hideFalseAlarms Boolean  @default(false) @map("hide_false_alarms")
  /// Days to keep archived files (feeds the cleanup job; S3 lifecycle is the backstop).
  retentionDays   Int      @default(365) @map("retention_days")
  updatedAt       DateTime @updatedAt @map("updated_at")
  updatedBy       String?  @map("updated_by")
  @@map("dashcam_policies")
}
```

Rules, in order, for each alarm:

1. Code override `show: false` → not listed.
2. Category in `hiddenCategories` → not listed.
3. Severity (override, else `vss-events.ts`) below `minSeverity` → not listed.
4. No media and `showWithoutMedia` off → not listed.
5. `hiddenAt` set (5.3) → listed only to `dashcam:moderate`, marked hidden.
6. `hideFalseAlarms` and the newest feedback is `false_alarm` → not listed.

`archive` is decided separately (code override, else "archive if listed"), so an
org can, for example, list info alarms for a week but never pay to store them.

Put the rules in one pure function, `policyVerdict(alarm, policy, viewer)` →
`{ list, archive, severity, channels }`, unit-tested like `vss-match.ts`, and
call it from **both** `/vss/alarms` and `/vss/file`. A file link to an alarm the
policy hides must 404, or hiding is only cosmetic.

The rail badge (`useVssBadge`) reads `/vss/alarms`, so it follows the policy for
free.

### 5.2 Permissions

| Permission | Grants | Default roles |
| --- | --- | --- |
| `vehicle:read` (existing) | List alarms and road-facing media for units in scope | as today |
| `dashcam:cabin` (new) | Play/download channels matched by `restrictedChannels` | admin, safety lead |
| `dashcam:moderate` (new) | Hide/unhide an alarm, set legal hold, see hidden alarms | admin |
| `dashcam:configure` (new) | Edit the org's `DashcamPolicy` | admin |

Without `dashcam:cabin` the media item is still listed with
`restricted: true` and no `url`, so the page can say "In-cabin footage needs
permission" instead of looking broken. Remember the authz cache: `/me` serves old
permissions for up to 5 minutes after a grant migration.

### 5.3 Per-alarm moderation

On the alarm (beside Feedback): **Hide** with a reason, **Unhide**, **Legal hold**.
Hidden alarms drop out of everyone's list and badge; legal hold stops the cleanup
job and the S3 expiry (apply an S3 object tag `hold=1` and exclude it in the
lifecycle filter, or copy to a `hold/` prefix with no expiry rule). Every change
is written to the existing audit log with who, when and why.

### 5.4 new-ui changes

- `api/vssAlarms.js`: accept media with `restricted: true` and no `url` (today
  the filter drops anything whose URL is not `/api/v1/vss/file?`).
- `DashcamIncidentsScreen.jsx`: restricted-channel placeholder; Hide / Legal
  hold buttons for `dashcam:moderate`; an "Archived" mark on the media tabs.
- Settings › Dashcam: severity floor, category switches, a searchable code list
  (from `vss-events.ts`, served by a new `GET /vss/codes`) with Show / Archive /
  Severity per code, restricted channels, retention days.

---

## 6. Operating it

- **Cleanup job** (daily): media past `retentionDays` and not on hold →
  `DeleteObject`, `state = expired`. The S3 lifecycle rule is the safety net if
  this job stops.
- **Health:** count of `pending` older than 1 h, `failed`, and bytes stored per
  org per day, logged once a day; alert if pending grows for 3 days running.
- **Org deletion / data request:** delete prefix `dashcam/{orgId}/` and the rows.
- **Cost watch:** S3 Storage Lens (free tier) or a monthly `bytes` sum from
  `dashcam_media`. Prices for af-south-1 are higher than us-east-1; check the
  S3 pricing page for the current figures rather than estimating from memory.

---

## 7. Build order

| Step | What | Visible change | Can ship alone |
| --- | --- | --- | --- |
| 0 | **Measure:** one day of Sukari media sizes (HEAD each VSS file, sum `Content-Length`), split by kind and channel | none | yes |
| 1 | Bucket, role, lifecycle (section 3) | none | yes |
| 2 | Schema + discovery job + archive job, flag off; turn on for one org (Sukari) | none; files appear in S3 | yes |
| 3 | `/vss/file` serves stored files from S3; tee on full reads | clips load from S3; links survive restarts | yes |
| 4 | `/vss/alarms` from the database; lift the 7-day cap | faster page, older alarms | yes |
| 5 | `DashcamPolicy` + `policyVerdict` + permissions, with defaults that match today (show everything) | none until edited | yes |
| 6 | Settings › Dashcam and moderation buttons in new-ui | admins control the list | yes |
| 7 | Cleanup job, health log, all orgs | — | yes |

Steps 2–4 change nothing for users if they go wrong: with the flag off the
service is exactly today's.

## 8. Decisions for the operator

1. Retention: 365 days for warning/critical and 30 for info, or something else?
2. Archive info alarms at all? (They are ~45% of Sukari's volume.)
3. Who may see in-cabin footage (`dashcam:cabin`)?
4. Serve clips by presigned redirect (recommended, lighter box) or proxy from S3
   (all traffic on our domain)?

## 9. Cost (af-south-1 rates from the AWS price list API, 7 Nov 2026)

| Item | Rate |
| --- | --- |
| S3 Standard | $0.0274 / GB-month (first 50 TB) |
| Standard-IA | $0.0149 / GB-month, $0.01 / GB retrieved |
| Glacier Instant Retrieval | $0.005 / GB-month, $0.03 / GB retrieved |
| PUT / LIST | $0.006 / 1,000 |
| GET | $0.004 / 10,000 |
| Out to the internet (S3 or EC2) | $0.154 / GB (first 10 TB) |
| VSS → box in, box → S3 same region | free |

**Volume assumption (not measured):** Sukari 433 alarms/day on 101 cameras ≈ 4.3
per camera; ×513 paired cameras ≈ 2,200 alarms/day. Evidence per alarm is a guess
until step 0: 4 MB (low), 10 MB (mid), 30 MB (high).

| Scenario | Ingest / month | Steady state after 12 months, lifecycle 3.1 | Same, info kept 30 days | All in Standard, no lifecycle |
| --- | --- | --- | --- | --- |
| Low (4 MB) | 264 GB | ~$27 / month | ~$18 | ~$84 |
| Mid (10 MB) | 660 GB | ~$68 / month | ~$45 | ~$210 |
| High (30 MB) | 1,980 GB | ~$203 / month | ~$135 | ~$630 |

Month one is about a quarter of these figures; storage grows each month until the
retention period is reached, then stays flat. Requests (multipart PUTs, lifecycle
transitions) add roughly $5–10 / month. Viewing clips costs $0.154 / GB whether
it is served by S3 or by the box, so presigned links move this cost, they do not
add it (~$20 / month if a fifth of mid-size alarms are watched once).
Use an S3 gateway VPC endpoint (free) so uploads never go through a NAT.
