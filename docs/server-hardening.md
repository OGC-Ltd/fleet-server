# Production box hardening: Docker and the firewall

How Docker was installed on the production box, how the host firewall (UFW) was
switched on, and how each step was checked. Read this before running containers
on the box or changing any port.

| | |
| --- | --- |
| Box | `ubuntu@13.247.178.217` (af-south-1, Cape Town), key `keys/ustawi.pem` |
| OS | Ubuntu 26.04.1 LTS (`resolute`), kernel 7.0.0-1011-aws, t3.medium (2 vCPU, 3.8 GB) |
| Private IP | `172.31.11.141` in the VPC's `172.31.0.0/16` |
| Done | 2026-11-03 |

The box serves the live site (`logistics.raioperations.com`). See
[af-south-1-deployment.md](af-south-1-deployment.md) for how nginx, pm2 and
the app fit together.

---

## 1. State before any change

These are read-only checks, and they shaped every choice below.

- **Docker:** not installed. No Docker, containerd, podman or snap packages were present.
- **Firewall:** UFW inactive, iptables policy `ACCEPT` everywhere.
- **Listening ports:**

  | Port | Process | Bound to |
  | --- | --- | --- |
  | 22 | sshd | all interfaces |
  | 80, 443 | nginx | all interfaces, IPv4 and IPv6 |
  | 3000 | node (`server`, pm2) | **all interfaces** (`*:3000`) |
  | 53 | systemd-resolved | loopback only |

- **Apps under pm2:** `server` (about 1 GB of memory) and `report-worker` (about 210 MB), both online.
- **Spare capacity:** about 2.1 GB of memory available and 7.2 GB free on `/` (the disk is 62% full).
- **Redis is not on the box.** `REDIS_URL` points to ElastiCache
  (`master.kihi.wqwoti.afs1.cache.amazonaws.com`, `172.31.8.62`) over TLS.
  PostgreSQL is RDS (`172.31.46.183`). Both connections go *out* from the box.
- `unattended-upgrades` is enabled, and the apt lock was free.

## 2. Installing Docker

The source is Docker's own apt repository, never the Ubuntu `docker.io` package
or the snap. Docker's repo gets security fixes first.

Before the key was trusted, it was checked against Docker's published
fingerprint. The install would have stopped on a mismatch.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /tmp/docker.asc
FPR=$(gpg --show-keys --with-colons /tmp/docker.asc | awk -F: '/^fpr/{print $10; exit}')
[ "$FPR" = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88" ] || { echo "FINGERPRINT MISMATCH"; exit 1; }
sudo install -m 0644 /tmp/docker.asc /etc/apt/keyrings/docker.asc && rm /tmp/docker.asc

. /etc/os-release
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

`Signed-By` ties this repo to Docker's key alone, so a package from any other
source cannot pass as Docker's.

The fingerprint matched, and the install gave **Docker 29.9.2** and **Compose v5.7.0**.

## 3. Daemon configuration

`/etc/docker/daemon.json` (owner root, mode 644):

```json
{
  "ip": "127.0.0.1",
  "icc": false,
  "userland-proxy": false,
  "no-new-privileges": true,
  "live-restore": true,
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "default-address-pools": [ { "base": "10.200.0.0/16", "size": 24 } ],
  "features": { "buildkit": true }
}
```

| Setting | Why |
| --- | --- |
| `ip: 127.0.0.1` | **The important one.** Docker writes its own firewall rules, which take effect *before* UFW. A plain `-p 8080:80` would therefore be public whatever UFW says. With this setting, a published port listens on the box only, and nginx reaches it from there. To expose a port on purpose, name the address: `-p 0.0.0.0:443:443`. |
| `icc: false` | Containers on the default bridge cannot talk to each other. Containers that need to talk share a user-defined network (Compose creates one per project). |
| `no-new-privileges` | A process in a container cannot gain privileges through setuid binaries. |
| `userland-proxy: false` | Ports are forwarded by the kernel instead of a `docker-proxy` process for each port. |
| `live-restore` | Restarting or upgrading the Docker daemon leaves running containers up. |
| `local` logs, 3 × 10 MB | Container logs cannot fill the disk. |
| `default-address-pools` 10.200.0.0/16 | Container networks stay clear of the VPC's `172.31.0.0/16`, where RDS and ElastiCache live. Docker's default `172.17–172.31` ranges could clash with it. |

The config was checked before the restart:

```bash
sudo dockerd --validate --config-file /etc/docker/daemon.json   # "configuration OK"
sudo systemctl restart docker
sudo systemctl enable docker.service containerd.service
```

**Access to Docker:**
- The `docker` group is **left empty on purpose**, and `ubuntu` is not in it. Membership in that group is root on the box without a password. Use `sudo docker …`.
- The daemon listens only on `/var/run/docker.sock` (mode `srw-rw---- root:docker`). There is no TCP socket, and none should ever be added.

**Defaults confirmed with `docker info`:** AppArmor `default` profile, built-in
seccomp profile, cgroup namespaces, `no-new-privileges`, `live-restore=true`,
logging driver `local`.

## 4. Docker checks

- `sudo docker run --rm --read-only --cap-drop ALL hello-world` printed "Hello from Docker!".
- `sudo docker run -d -p 8099:80 busybox httpd` gave a listener on **`127.0.0.1:8099` only**. This proves the `ip` setting works. The test container and images were removed afterwards.
- The live app was unaffected:
  - `/health` on :3000 returned 200.
  - `/api/v1/sim-clock` through nginx returned 200.
  - `https://logistics.raioperations.com/` returned 200.
  - Both pm2 apps stayed online.
- The firewall's `INPUT` policy was still `ACCEPT`. Installing Docker changes forwarding rules only.

No containers run on the box yet.

### Rules for future containers

1. Publish ports as `127.0.0.1:<port>:<port>` (now the default) and put the service behind nginx.
2. Never mount `/var/run/docker.sock` into a container. That hands the container root on the box.
3. Prefer images that run as a non-root `USER`. Add `--cap-drop ALL` and `--read-only` where the image allows it.
4. Pin images by version (better, by digest). Never use `latest`.
5. Secrets go in through env files that only root can read, never baked into images.

## 5. Port 3000 and the host firewall

### Would closing port 3000 affect the live site?

This was checked before anything changed. It would not.

- **From outside**, a probe from an office PC found 22, 80 and 443 open. **Port 3000 was closed**: the AWS security group already blocks it.
- **On the box**, every connection to :3000 came from `127.0.0.1`: 13 of 13 at the time of the check. That is nginx.
- **nginx** sends `/api/`, `/webhook/` and the Controltech callbacks to `127.0.0.1:3000`.
- **The other ways in** use 80 or 443, not 3000:
  - the LiteSpeed proxy (port 80)
  - the `api.php` fallback in new-ui (port 80)
  - certbot renewal (port 80)
  - the factory and VSS webhooks (port 443, through nginx)
  - the browsers' live stream (port 443)
- The deploy health check runs `curl 127.0.0.1:3000/health` *on the box* over SSH.
- **Database and Redis** are outgoing connections. UFW is set to allow all outgoing traffic.

So the firewall adds a second layer and takes nothing away. If someone opens
3000 in the security group by mistake, the box still refuses it.

### Risks and how they were handled

| Risk | Handling |
| --- | --- |
| Locking everyone out of SSH | A systemd timer switches UFW off again after 5 minutes. A **new** SSH login is tested, and only then is the timer cancelled. |
| Deploys throttled mid-run | UFW's usual `limit 22/tcp` blocks an address after 6 connections in 30 s. Each deploy workflow makes about 30 ssh/scp calls from one runner, so **`allow 22/tcp` is used, not `limit`**. |
| Open live-stream sessions dropped | UFW lets connections that already exist carry on, so nothing is cut when it switches on. |
| UFW thought to cover Docker ports | It doesn't. Docker's rules come first. That is what the `ip: 127.0.0.1` setting in section 3 handles. |

### Rules

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp  comment 'ssh, deploys'
sudo ufw allow 80/tcp  comment 'http: LiteSpeed proxy, ACME, redirect'
sudo ufw allow 443/tcp comment 'https: site, API, SSE, webhooks'

# Failsafe first: if the next step locks us out, UFW turns itself off in 5 minutes.
sudo systemd-run --unit=ufw-failsafe --on-active=5min /usr/sbin/ufw disable
sudo ufw --force enable
# From a NEW terminal: ssh in again, then check the site. Only after both work:
sudo systemctl stop ufw-failsafe.timer
```

UDP 443 is not opened, because nginx does not serve HTTP/3 here. The rules
apply to IPv6 as well (`IPV6=yes` in `/etc/default/ufw`).

### Outcome

UFW was switched on 2026-11-03 at about 22:43 UTC (box clock), with the failsafe armed. These checks ran inside the 5-minute window:

**From outside (an office PC):**
- Ports 22, 80 and 443 open; port 3000 closed.
- `https://logistics.raioperations.com/` → 200.
- `/api/v1/sim-clock` over HTTPS → 200.
- Plain HTTP by IP (the path the LiteSpeed proxy uses) → 200.

**SSH:**
- 8 fresh SSH logins back to back all succeeded. That is the deploy pattern, and it proves `allow` (not `limit`) is right.

**On the box:**
- `/health` → 200, and both pm2 apps online.
- 14 HTTPS connections still established, so live viewers were not dropped.
- No new connection errors to RDS or ElastiCache in the server log.
- The kernel log showed 0 `UFW BLOCK` lines in the first minutes.

**Containers:**
- A container still reaches the internet (`wget https://download.docker.com`).
- Docker's forwarding rules come before UFW's `deny (routed)` default.

The failsafe was then cancelled (`systemctl stop ufw-failsafe.timer`). UFW is
`active` and `enabled` at boot.

## 6. Day-to-day commands

```bash
sudo ufw status numbered                      # current rules
sudo ufw allow 8443/tcp comment 'why'         # open a port; always add a comment
sudo ufw delete <n>                           # remove rule n from the numbered list
sudo journalctl -k | grep 'UFW BLOCK'         # what is being refused
sudo docker ps --format '{{.Names}} {{.Ports}}'   # every port should show 127.0.0.1
```

Before any change that could cut SSH, arm the failsafe first, exactly as in section 5.

## 7. Still open

- **Node binds `*:3000`.** UFW and the security group both block it now. Binding the app to `127.0.0.1` (a `HOST` setting) would close it at the source as well. That needs a code change and a deploy.
- **SSH is open to the whole internet** in both UFW and, presumably, the security group. Deploys come from GitHub-hosted runners, whose addresses change, so narrowing it needs a fixed path first. Options are a self-hosted runner or AWS SSM.
- **Elastic IP.** The box's public IP can change on a stop/start, so it is still worth confirming in the console.
