# af-south-1 deployment

How the Cape Town box serves fleet-server and dash, and what differs from the
us-east-1 box it replaces. Written against the machine as deployed on
2026-09-02; every command here was run on it.

## Shape

One origin serves both halves. nginx holds the Vite build as static files and
hands two prefixes to node on `:3000`:

```
browser ──▶ nginx :80  ┬─ /assets/   → build/assets  (immutable, 1y)
                       ├─ /api/      → 127.0.0.1:3000  (REST + SSE)
                       ├─ /webhook/  → 127.0.0.1:3000  (full URI preserved)
                       └─ /*         → index.html      (SPA fallback)
```

This is why dash needs no API host compiled into it. `services/api.js` resolves
an empty `VITE_API_URL` to same-origin, so a relative `/api/…` call follows
whatever hostname the browser already has and nothing needs rewriting when the
domain changes. **Do not set `VITE_API_URL` for this deployment.**

The serving config is committed at `deploy/nginx/fleet.conf` — it previously
existed only on the box. The `/api/` block carries the settings the live feed
depends on: `proxy_buffering off` so events are not held back, an empty
`Connection` header to keep the upstream socket open, and a 3600 s read timeout
so an idle SSE stream is not dropped. `/webhook/` deliberately has no trailing
path on its `proxy_pass`, so the `/webhook/rai` URI registered with Controltech
arrives unchanged.

## What differs from the old box

Four things cost real time during the move. None is exotic, and all four fail
in ways that look like something else.

**nginx includes `conf.d`, not `sites-enabled`.** The us-east-1 box keeps its
server block inline in `nginx.conf`; this is a stock build that includes
`/etc/nginx/conf.d/*.conf` and shipped a `default.conf` which would otherwise
claim port 80. That file is renamed `default.conf.disabled`.

**`/home/ubuntu` must be `751`.** It ships as `750`, so the `nginx` worker
cannot traverse it to reach `prod/dash/build`. The `o+x` bit grants traversal
without making the home directory readable — the old box is `751` for the same
reason. Presents as a 403 that reads like a config error.

**node is nvm-only and absent from the non-login PATH.** Any non-interactive
`ssh <box> <command>` must `. "$HOME/.nvm/nvm.sh"` first, or node, npm and pm2
are all "command not found". `deploy.yml` handles this by exporting the nvm bin
directory explicitly; that path is version-pinned, so it has to move whenever
the box's node does.

**`uselibpqcompat=true` is Prisma-only.** libpq rejects it outright, so any
`psql`, `pg_dump` or `pg_restore` against `DATABASE_URL` needs it stripped while
Prisma keeps it:

```sh
PSQL_URL=$(echo "$DIRECT_URL" | sed -e 's/uselibpqcompat=true&//' -e 's/[?&]uselibpqcompat=true//')
```

## Redis is ElastiCache now, not a local server

`src/lib/redis.ts` opens two logical databases — db 0 for the notification
cache, db 1 for BullMQ — deliberately kept apart so cache eviction can never
destroy queued jobs. That requires a **cluster-mode-disabled** replication
group; cluster mode and serverless both expose only db 0.

Encryption in transit is on and an AUTH token is required, so the scheme is
`rediss://` with an empty username:

```
REDIS_URL='rediss://:<AUTH_TOKEN>@<primary-endpoint>:6379'
```

Use the **primary** endpoint only. The reader endpoint is read-only, and both
logical databases are written on every publish — that failure would not appear
at connect time, only under traffic.

`maxmemory-policy` must stay `volatile-lru`. BullMQ logs
`IMPORTANT! Eviction policy is volatile-lru. It should be "noeviction"` on
every connection; that warning does not know about the db 0 / db 1 split. Under
`noeviction` a full cache starts failing *writes*, including the notification
cache, which is designed to be disposable. Under `volatile-lru` only keys
carrying a TTL are evictable and BullMQ's scheduler and meta keys carry none.
`CONFIG` is disabled on ElastiCache, so read the policy from `INFO memory`.

## Deploying

Same push-into-worktree model as before — the box holds no GitHub credentials,
by design, and cannot pull:

```sh
GIT_SSH_COMMAND='ssh -i keys/ustawi.pem' \
  git push ubuntu@<box>:/home/ubuntu/prod/fleet-server main:main
# then on the box, under nvm:
npm ci && npm run build && pm2 restart server
```

dash is the same but builds to `build/` and needs no restart — nginx serves the
new files immediately. It needs `VITE_GOOGLE_MAPS_API_KEY` present at **build**
time, because the key is compiled into the bundle rather than read at runtime.
The production key lives only in `~/prod/dash/.env` on the boxes and is not the
one in the dash repo's own `.env`. If the map dies after a domain change it is
the referrer restriction in the Google Cloud console, not the key.

### CI

`deploy.yml` takes the host from repository secrets, so pointing it at this box
is a **secrets change, not a code change**:

| Secret | Set to |
| --- | --- |
| `EC2_HOST` | the af-south-1 public DNS |
| `EC2_SSH_KEY` | the private key that reaches it |
| `EC2_HOST_KEY` | output of `ssh-keyscan <new-host>` |

The af-south-1 security group must also admit the GitHub runner. `NODE_VERSION`
and the two nvm PATH exports in the workflow are pinned to the box's node and
move with it.

## Checking it works

`/health` is mounted at the **root**, not under `/api`, so nginx sends it to the
SPA fallback and it is reachable only on `:3000`. Use `sim-clock` for an
unauthenticated check through nginx:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/api/v1/sim-clock
redis-cli -h <primary-endpoint> --tls -a "$AUTH_TOKEN" INFO keyspace
```

Both databases appearing in `INFO keyspace` is the clearest single signal that
the Redis wiring is right: db 0 is the cache, db 1 is `bull:*`.

`/api/v1/bootstrap` answering `503 No organisation configured` means the app has
reached the database and found it empty — a working stack against empty data,
not a fault.

Every live count reading zero (`ALL UNITS`, `ONLINE`, `IDLING`) is expected
whenever `POLL_ENABLED=false`: nothing writes live positions, so
`vehicles/snapshot` returns null coordinates and the fleet reads OFFLINE. The
app's own AI-insight log states it as `connectionKnown:false, online:null,
connectionUnknown:<n>`. Exactly one deployment may have `POLL_ENABLED` and
`RAIFACTORYSUITE_POLL_ENABLED` true — two pollers writing at once produce
conflicting positions and duplicate trips.
