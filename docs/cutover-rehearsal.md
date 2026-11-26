# Rehearsing the cutover and the fallback on a clone of the box

The cutover's automatic undo, `fleet-deploy back-to-pm2`, `fleet-fallback all`, `pm2 resurrect` after a reboot, and copying `.cache` back have never run against the real project. The 2026-11-03 rehearsals used project `fleet-rehearsal` with the server only. This runbook runs all of them on a **clone of the production box**, against a **copy of the database**, with **no outside credentials**. Nothing it does reaches production data or customers.

Budget: about 2 hours, plus 15–30 minutes for the database copy. Cost: one extra instance and one `db.t4g.small` for those hours.

## The one danger

A clone made from a snapshot of the box boots exactly like the box: `pm2-ubuntu.service` starts `server` with the live `.env`. That is a **second production poller** writing to the production database and calling Wialon on the live account, which is what happened on 2026-09-02. So the clone starts with **no way out**: a security group with no outbound rules and no instance role. It is only connected once its env files point at the copy.

Two more rules:

- Never run `fleet-secrets render` or `import` on the clone, and delete the SSM marker first (step 3). Once it gets a role, `fleet-app` can read the production secrets in SSM, and a render would point the clone back at production.
- The clone never gets the Elastic IP or a DNS name, and GitHub's deploy secrets keep pointing at the real box.

## Setup

1. **Database copy.** In CloudShell (af-south-1), from the production folder:

   ```bash
   bash preview-db-cloudshell.sh create
   ```

   Note the endpoint that `status` prints. The copy has the same logins and the same security group rules as production, so only instances in the box's security group can reach it.

2. **Clone the box.**
   - EC2 → the box's root volume → Create snapshot. Then create an image from the snapshot.
   - Launch the image with the same instance type and subnet, **no IAM instance profile**, and a new security group `fleet-rehearsal-quarantine`:
     - inbound: 22 from your own address only;
     - outbound: **none**. Delete the default allow-all rule.
   - pm2 starts, fails to reach anything, and keeps retrying. That is expected.

3. **Neutralise it, still quarantined.** SSH in with `keys/ustawi.pem` to the clone's address.

   ```bash
   sudo systemctl disable --now pm2-ubuntu
   export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH; pm2 kill
   sudo systemctl disable --now certbot.timer
   sudo rm -f /etc/fleet/secrets-from-ssm
   ```

   Then edit **both** `~/prod/fleet-server/.env` (pm2) and `/etc/fleet/server.env` (containers, root 600), the same way in each:

   | Setting | Rehearsal value |
   | --- | --- |
   | `DATABASE_URL`, `DIRECT_URL` | Host swapped for the copy's endpoint. Everything else unchanged (user, password, `?sslmode…&uselibpqcompat…`). |
   | `REDIS_URL` | The production ElastiCache URL with `/15` on the end: logical database 15. BullMQ queues, caches and rate limits stay apart from production's database 0. Flush db 15 when done. |
   | `WIALON_TOKEN`, `RAIFACTORYSUITE_API_KEY`, Control Tech, `VSS_*` credentials, `OPENAI_API_KEY`, DeepSeek, Google, OpenWeather keys, `MAILTRAP_*`, `VAPID_*`, the webhook secret | Deleted. If the app refuses to boot without one, use an obviously fake value such as `rehearsal-not-a-key`. |
   | Every `*_ENABLED` switch | `false`, **except** `POLL_ENABLED=true`. Without credentials the poller only logs auth errors, and it is what takes the leader lock, which this rehearsal tests. |

   Check that both files agree, apart from what each one needs:

   ```bash
   sudo fleet-secrets status
   ```

4. **Connect it.**
   - Attach the instance profile `fleet-app`, for ECR pulls.
   - Swap the security group `fleet-rehearsal-quarantine` for the box's own. Its outbound rules reach the database copy, ElastiCache and the internet.
   - Check from the clone that the hosts in `DATABASE_URL` and `DIRECT_URL` are the copy. Do not continue until they are:

     ```bash
     grep -E '^(DATABASE_URL|DIRECT_URL)=' ~/prod/fleet-server/.env | sed -E 's#://[^@]*@#://***@#'
     ```

5. **Code under test.** CI only builds images; it never deploys to the clone.
   - From the operator PC, push the commit under test into the clone's checkout, and build it the way `build-test-deploy.yml` does: `npm install`, `prisma generate`, `npm run build`, then `git rev-parse HEAD > dist/.built-commit`. The pm2 fallback is then that commit.
   - Install the box scripts and the compose files from that commit, as each file's "Install" note says. `fleet-fallback` is new.
   - Note that commit's image tag, `<sha>`.

## The rehearsal

Run these in order. Record the result and the API gap for each.

| # | Do | Expect |
| --- | --- | --- |
| 1 | `sudo -u ubuntu pm2 start server report-worker` (pm2 serving, as on the live box today), then `sudo fleet-deploy check <sha>` | `READY`. The `INFO` drift line lists no keys. |
| 2 | `sudo fleet-deploy cutover <sha>` | `CUTOVER DONE`, gap in seconds. The server log says `Leader lock held`. `mode` = containers. |
| 3 | **Double writer.** `sudo -u ubuntu pm2 start server` | The pm2 server logs `Leader lock is held by another fleet-server` (naming the container), exits after 90 s, and pm2 keeps restarting it. The containers are unaffected. `fleet-deploy mode` says BOTH. Then `pm2 stop server`. |
| 4 | **Deploy and lock handover.** `sudo fleet-deploy up <sha2>` (any other image), then `rollback` | Each new server takes the lock within seconds of the old one stopping. |
| 5 | **Report deleted while on containers.** Delete one saved report through the app, or remove one folder under the volume's `reports/`. Note its key. | Gone from the volume. |
| 6 | **Secret drift.** Add `REHEARSAL_MARK=1` to `/etc/fleet/server.env`, then `sudo fleet-deploy up <sha>` | Containers restart with it. pm2's `.env` doesn't have it yet. |
| 7 | **Stale fallback gate.** `echo deadbeef \| sudo tee ~ubuntu/prod/fleet-server/dist/.built-commit`, then `sudo fleet-deploy back-to-pm2` | Refuses, naming both commits. **Nothing stops.** Then put the right commit back in that file. |
| 8 | `sudo fleet-deploy back-to-pm2` | `.env` gains `REHEARSAL_MARK`, a `.env.bak-*` appears, and the `DATABASE_URL` query string is unchanged. The report deleted in 5 is gone from `~/prod/fleet-server/.cache` and kept under `/var/backups/fleet-cache/*-out-of-volume`. pm2 serves, and its log says `Leader lock held`. |
| 9 | **Cutover's own undo.** Set `JWT_SECRET=short` in `/etc/fleet/server.env` (fails the app's env check at boot, not `check`), then `sudo fleet-deploy cutover <sha>` | Containers fail health, `cutover failed: back to pm2`, pm2 serves again. Then restore `JWT_SECRET`. |
| 10 | `sudo fleet-deploy cutover <sha>`, then `sudo reboot` | After boot: containers up, pm2 **not** started, `mode` = containers. |
| 11 | **Phase 3.** `sudo fleet-web up <web-sha>`, then `sudo fleet-web switch` | `SWITCHED`. |
| 12 | **Phase 4.** `sudo fleet-edge check <sha> <web-sha>`, then `sudo fleet-edge switch` | `READY`, then `SWITCHED`. HTTPS answers through `--resolve` to 127.0.0.1. |
| 13 | **Order guards.** `sudo fleet-deploy back-to-pm2` and `sudo fleet-web back` | Both refuse while the edge serves. Nothing stops. |
| 14 | `sudo fleet-fallback all` | Edge → host nginx, site → static files, API → pm2, in that order. `status` shows host / static / pm2. |
| 15 | `sudo fleet-fallback all` again | Each layer is skipped. Nothing changes. |

Anything other than the expected result is a finding to fix before the live cutover. Write down the API gap of steps 2, 4, 8 and 14 for the cutover notice.

## Afterwards

1. Terminate the clone and deregister its image. Delete the snapshot.
2. `bash preview-db-cloudshell.sh delete`
3. Flush ElastiCache database 15. From the real box, with its `REDIS_URL`:

   ```bash
   redis-cli -u "<REDIS_URL with /15>" --tls FLUSHDB
   ```

   Check twice that the URL ends in `/15` before pressing Enter.
4. Note the results and the gaps in `docs/containerization-plan.md`.
