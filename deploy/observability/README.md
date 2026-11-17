# Observability: OpenTelemetry, Jaeger, Prometheus, Loki, Grafana

Everything fleet-server and the box do, captured with OpenTelemetry, searchable
in Grafana, and kept in S3.

| Piece | What it captures or does | Kept | Reached at |
| --- | --- | --- | --- |
| fleet-server + report worker | OpenTelemetry SDK (`src/telemetry/`): a trace per request (route, client address, user, organisation), every SQL statement, every outside call (Wialon, OpenAI, FactorySuite, Google, S3, mail), a trace per poll-loop run and BullMQ job; request rates and latencies, event loop, heap, GC; every log line with its trace id, including one `request` line per request with the client address (`src/middleware/request-log.ts`) | — | sends OTLP to `otel-collector:4318` |
| nginx (host) | A JSON access log beside the usual one (`nginx/05-observability-log.conf`): every request that reached the box, the connecting address, X-Forwarded-For, status, timings, rate-limit verdict. Credential-looking query strings are blanked | — | `/var/log/nginx/access.json.log` |
| otel-collector | The one entry point (`otel-collector/config.yaml`): takes the app's OTLP; reads the nginx access and error logs and the box's auth log (SSH sign-ins, sudo); box CPU, memory, disk, network; each container's CPU and memory. Fans out to the stores below | — | — |
| Jaeger | Traces kept for searching: every request, and the share of background work the app records (poll runs, jobs, timers: 5 %, `FLEET_TRACE_BACKGROUND_RATIO`) | 48 h (`JAEGER_TTL`) | Grafana › Explore › Jaeger, or `ssh -L 16686:127.0.0.1:16686` |
| Prometheus | Metrics; the system checks in `prometheus/rules.yml` | 15 days, 1 GB cap | Grafana, or `ssh -L 9090:127.0.0.1:9090` |
| Loki | Logs: app lines, nginx requests, nginx errors, auth log | 14 days | Grafana › Explore › Loki, and the dashboards |
| S3 | **Every log line**, and every span the app records (every request; 5 % of background work), gzipped OTLP JSON | until a lifecycle rule says otherwise | `s3://ndoo-522505217087-af-south-1-an/ndoo/kumbukumbu/{logs,traces}/year=…/month=…/day=…/hour=…/` |
| Grafana | Dashboards **Fleet · Overview** and **Fleet · Visitors**, and Explore over all three stores | — | **https://logistics.raioperations.com/grafana/** (sign in as `admin`) |

Its own compose project (`observability`), outside fleet's release: CI never
deploys it. The collector joins fleet's `backend` network; nothing else does.
fleet runs the same with the stack down: the SDK drops what it cannot send.

## Disk

The images are ~1.6 GB and Jaeger keeps up to ~2–3 GB of traces, while
fleet's own deploys need 3 GiB free to pull an image. `fleet-observability up`
refuses to pull below 10 GiB free. The volume was grown from 20 to 30 GiB for
this on 2026-11-17 (17 GB free afterwards); the Fleet · Overview dashboard's
"Root disk used" panel and the BoxDiskLow rule (85 %) watch it.

## Set up (once, on the box)

```sh
# From a checkout of this repo (copied to the box):
sudo install -o root -g root -m 755 deploy/box/fleet-observability /usr/local/sbin/fleet-observability
sudo fleet-observability install deploy/observability   # files, data dirs, Grafana password, .env
sudo fleet-observability up                             # pull, validate every config, start
sudo fleet-observability nginx                          # JSON access log + /grafana/ (nginx -t, reload)
# fleet's compose file, so the server reads the optional /etc/fleet/observability.env:
sudo install -o root -g root -m 644 docker-compose.prod.yml /etc/fleet/compose/docker-compose.prod.yml
sudo fleet-observability app-on                         # writes /etc/fleet/observability.env
# The server sends from its next container start: the next deploy, or now:
sudo fleet-observability app-restart                    # same image, ~20 s API gap
sudo fleet-observability status
```

The setting lives in `/etc/fleet/observability.env`, not `server.env`:
fleet-deploy re-renders `server.env` from SSM on every deploy, which would drop
it. `docker-compose.prod.yml` loads the file when it exists (`required: false`);
absent, telemetry is off.

The image must be one with `src/telemetry/register.ts` (NODE_OPTIONS loads it);
on an older image `app-on` changes nothing.

Grafana's admin password: `sudo cat /opt/fleet-observability/secrets/grafana-admin-password`.
Change it after the first sign-in, and add people as Viewers under
Administration › Users rather than sharing the admin account.

Undo, in reverse: `app-off` + `app-restart`, `nginx-undo`, `down`.

## Writing to S3

The collector writes with the box's role (`fleet-app`, via the instance
metadata service), which may put objects under `ndoo/`; it needs nothing
else (it never lists or reads the bucket). Objects:

```
ndoo/kumbukumbu/logs/year=2026/month=11/day=17/hour=19/fleet-logs_<uuidv7>.json.gz
ndoo/kumbukumbu/traces/year=2026/month=11/day=17/hour=19/fleet-traces_<uuidv7>.json.gz
```

About one object per minute per signal. Each is an OTLP JSON export request:
`resourceLogs[].scopeLogs[].logRecords[]` (body, attributes such as
`remote_addr`, `ip`, `status`, `trace_id`) and `resourceSpans[]...spans[]`.
Readable with `jq`, or queryable in place with Athena. If S3 cannot be
reached, the collector queues on disk (`/var/lib/fleet-observability/otelcol`)
and retries for an hour.

## Finding things

Loki keeps each line's own fields as structured metadata, so they filter
without a parser:

- `{service_name="nginx", log_source="access"} | remote_addr="203.0.113.7"`: every request from an address
- `{service_name="nginx", log_source="access"} | status=~"5.."`: what failed at the edge
- `{service_name="fleet-server"} | ip="203.0.113.7"`: what the app saw from it, with the user
- `{service_name="fleet-server"} | userId="<id>"`: one user's requests
- `{service_name="fleet-server"} | severity_text=~"(?i)warn|error"`: the app's warnings and errors
- `{service_name="host-auth"} |~ "Accepted|Failed"`: SSH sign-ins
- `{service_name="fleet-server"} |= "Poll cycle complete"`: the Wialon poll

A line written inside a trace has a `trace_id`: Grafana links it to Jaeger,
and a span in Jaeger links back to its lines.

Two addresses per request at the edge: `remote_addr` is what connected (for
the ogc-monitoring domain, that is the LiteSpeed proxy), `xff` is what the
client or proxy claims. The app's `ip` is resolved through the proxies it
trusts (`TRUSTED_PROXY_IPS`, `src/lib/trust-proxy.ts`).

## Tuning

`/opt/fleet-observability/.env`, then `sudo fleet-observability up`:

- `BACKGROUND_SAMPLE_PERCENT` (100): of the background traces the app sends, the share Jaeger keeps (S3 keeps all it receives). The app records 5 % of them in the first place: `FLEET_TRACE_BACKGROUND_RATIO=0.05` in `/etc/fleet/observability.env`, applied by `app-restart`. Recording all of them cost about a core on this box (2026-11-17)
- `JAEGER_TTL` (48h): how long Jaeger keeps traces
- `*_MEM_LIMIT`: each container's memory ceiling (collector 384m, Jaeger 384m, Prometheus 320m, Loki 320m, Grafana 384m)

Nothing pages anyone yet: rules show on the dashboard. Add a Grafana contact
point (Alerting › Contact points) to be told.
