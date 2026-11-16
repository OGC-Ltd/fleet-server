# Parallel run: the container beside pm2, on the same box

The container server answers a share of real users' API calls while pm2 keeps doing everything else. This is how it earns trust before the cutover, without a second instance or an AWS load balancer. Nothing here stops pm2. Turning the split off (`weight 0`) is one nginx reload.

## What runs where

| | pm2 (`server`, `report-worker`) | Parallel container (`fleet-parallel-server-1`, :3002) |
| --- | --- | --- |
| Wialon poller, leader lock | yes | no (`POLL_ENABLED=false`) |
| Scheduled jobs: reconciler, retention and rollups, fuel sync and adjudication, parked falls, FUEL RATE digest, trips, Wialon registry, unit insight and AI brief sweeps | yes | no (`SCHEDULED_JOBS_ENABLED=false`) |
| Report builds | yes (report-worker) | queues them for pm2's worker, and serves the results from the same folder |
| Mail and push on the shared queue | takes jobs | takes jobs (each job once, whoever is free) |
| Live map | from its own poller | from the database pm2 writes (`FOLLOW_DB`) |
| `/webhook/` | all of it | none |
| `/api/` | `100 − weight` % of clients | `weight` % of clients |

`SCHEDULED_JOBS_ENABLED=false` is one switch, on purpose. Turning the jobs off one by one is not safe on a shared Redis: several of them clear their schedule at boot when switched off. `FUEL_RATE_ALERTS` set to anything other than `digest` removes the live daily digest's schedule, so pm2 would silently stop sending it. The switch starts none of them and does not touch Redis. `fleet-parallel up` refuses an image that predates it.

The AI brief: without the sweep, the container writes a brief only when one of its own users asks for it and the stored brief is over 10 minutes old. That is the only extra OpenAI cost, and only for organisations whose users are split across the two servers.

## Known differences while split

- **Alerts raised by pm2's poller** reach the container's users through the database follower. They arrive a few seconds later, and readings the follower does not carry are missing: engine temperature and oil level show empty.
- **Toasts** for unauthorised stops go out from whichever server announces the stop first, to that server's users only.
- **In-memory caches** (permissions, incident reviews) are per server. One browser stays on one server. nginx hashes the `fleet_did` cookie that the API sets on every token refresh, so the split is per browser, not per office. On 2026-11-16, one office behind one address sent 97% of `/api`; an address hash would have moved that whole office at once. A browser that has not refreshed a token since 16 Sep has no cookie and is placed by its address until its next refresh. A change made by someone on the other server can take up to that cache's expiry to show.
- **Memory**: about 1–1.5 GB more on a 3.8 GB box. `up` refuses below 1.2 GB available. Watch `status`.
- **Database connections**: the container's pool is 8, on top of pm2's.

## Setup (once)

From the operator PC, in the box's checkout or with `scp`:

```bash
sudo install -o root -g root -m 755 deploy/box/fleet-parallel /usr/local/sbin/fleet-parallel
sudo install -o root -g root -m 644 docker-compose.parallel.yml /etc/fleet/compose/
sudo install -o root -g root -m 755 deploy/box/fleet-deploy deploy/box/fleet-edge deploy/box/fleet-fallback /usr/local/sbin/
```

`/etc/fleet/server.env` must be current (`sudo fleet-secrets status`). The container's env is written from it on every `up`.

## Steps

1. Push the commit with `SCHEDULED_JOBS_ENABLED` to main. pm2 deploys it, and CI builds its image.
2. `sudo fleet-parallel up <sha>`: pulls, writes `/etc/fleet/parallel.env`, starts the container, and checks it is healthy and logged that the jobs are off. Nginx sends it nothing yet.
3. Smoke-test it directly over an SSH tunnel to `127.0.0.1:3002` (`ssh -L 3002:127.0.0.1:3002`).
4. `sudo fleet-parallel weight 10`. Leave it for a day or more. Check `status`, `docker logs fleet-parallel-server-1`, and users' reports.
5. Raise it in steps: 25, then 50, then 90.
6. Each push to main moves the container to the same commit as pm2 (deploy.yml, "keep the parallel container on this commit"). If that fails, the deploy still succeeds with a warning.
7. **The cutover**, when you decide: `sudo fleet-parallel down`, then `sudo fleet-deploy cutover <sha>`. Cutover refuses while the parallel container runs.

## Getting out

- `sudo fleet-parallel weight 0`: pm2 serves all of `/api` again. One reload, no restart.
- `sudo fleet-parallel down`: weight 0, then the container is removed, along with its env file and the nginx upstream.
- `sudo fleet-fallback all` also sets the weight to 0 first.
- **Automatic**: when the container fails three requests, nginx sends its clients to pm2 for 30 s, then tries it again. A request that never reached the container is retried on pm2 straight away. A POST that the container received and then failed is not retried.
- A container that is not healthy after `up` (including CI's) is set to weight 0 by `fleet-parallel` itself.

## Files on the box

| File | What |
| --- | --- |
| `/etc/fleet/parallel.env` | The container's env (root 600), rewritten by `up` and removed by `down`. |
| `/etc/fleet/parallel.deployed` | The commit the container runs. Its presence blocks `fleet-deploy cutover` and `fleet-edge switch`. |
| `/etc/nginx/conf.d/fleet-api-split.conf` | Upstream `fleet_api_split` and the current weight. |
| `/etc/nginx/fleet/locations.conf` | Its `/api/` `proxy_pass` names that upstream while the weight is above 0. |
| `/etc/fleet/parallel.*.bak` | The last copies of both nginx files before a change. |
| `/var/lib/fleet-parallel/cache` | The container's own caches, owned by `ubuntu`. Kept by `down`. |
| pm2's `.cache/reports` and `.cache/investigations` | Shared with pm2, mounted into the container. |
