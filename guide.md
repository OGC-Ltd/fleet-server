# Fleet-Server Dev DB Tunnel — Troubleshooting Guide

The local dev server reaches the private RDS database through an SSH tunnel on
`localhost:15432`, via the EC2 jump host. When the tunnel is down, fleet-server
still starts but every Prisma query fails with `ECONNREFUSED` (e.g. the
`warm-cache sweep failed` log at startup).

- **RDS endpoint:** `fleet-store.cnim02awiv5t.af-south-1.rds.amazonaws.com:5432`
- **Jump host:** `ubuntu@13.247.178.217` *(reached by IP — the af-south-1 box's
  `ec2-13-247-178-217.af-south-1.compute.amazonaws.com` name is fine too, but if
  the instance restarts without an Elastic IP the address changes)*
- **Key:** `keys/ustawi.pem` in the `production` checkout (NOT `logistics.pem`,
  which was us-east-1, and NOT `turbo.pem`)
- **Local tunnel port:** `15432`

> **Everything us-east-1 is dead.** Production moved to af-south-1 (Cape Town)
> for POPIA. Both old jump hosts — `18.232.178.169` and `32.198.44.105` — are
> unreachable on 22 AND 80, their `ec2-*.compute-1.amazonaws.com` names no
> longer resolve, and `fleet-store.c8ty8uocsdjp.us-east-1…` is a DIFFERENT
> database, not a copy of this one. If you find those values anywhere, they are
> stale, not an alternative route.

> **A working tunnel is not enough — check the password too.** The committed
> `.env.example` still carries the us-east-1 password, so the usual failure is
> a tunnel that connects and then `password authentication failed for user
> "fleet_app"`. Compare fingerprints without printing either secret:
>
> ```bash
> grep -m1 '^DATABASE_URL=' .env.example | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#' | tr -d '"' | sha256sum | cut -c1-8
> ssh -i <key> ubuntu@13.247.178.217 "grep -m1 '^DIRECT_URL=' ~/prod/fleet-server/.env | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#' | tr -d \"'\\\"\" | sha256sum | cut -c1-8"
> ```
>
> They differed when this was last checked (2026-09-15). The box's `.env` is
> the authoritative one.

> **Or skip the tunnel entirely.** For one-off queries and migrations it is
> faster and more reliable to run ON the box, which already holds the right
> `.env`: `scp` a `.cjs`/`.ts` into `~/prod/fleet-server/` (it must live there,
> or `require('pg')` will not resolve), then
> `ssh … 'cd ~/prod/fleet-server && . ~/.nvm/nvm.sh && node x.cjs; rm -f x.cjs'`.
> Node on the box is nvm-only and pm2 is `npx pm2`.

---

## 1. Diagnose

**Symptom:** fleet-server logs `PrismaClientKnownRequestError` with `"code": "ECONNREFUSED"`.

### Windows (PowerShell)

```powershell
# Is the tunnel port listening?
Test-NetConnection -ComputerName localhost -Port 15432 -InformationLevel Quiet

# Is an ssh process running at all?
Get-Process ssh -ErrorAction SilentlyContinue

# Is the jump host reachable? (should print "ok")
ssh -i "C:\Users\HOD\Desktop\production\keys\ustawi.pem" -o BatchMode=yes -o ConnectTimeout=10 ubuntu@13.247.178.217 "echo ok"
```

### Linux / Ubuntu

```bash
# Is the tunnel port listening?
nc -z localhost 15432 && echo "tunnel up" || echo "tunnel DOWN"
# or: ss -tlnp | grep 15432

# Is an ssh tunnel process running?
pgrep -af "ssh.*15432"

# Is the jump host reachable? (should print "ok")
ssh -i ~/production/keys/ustawi.pem -o BatchMode=yes -o ConnectTimeout=10 ubuntu@13.247.178.217 "echo ok"
```

**Interpreting the jump-host test:**

| Result | Meaning | Fix |
|---|---|---|
| `ok` | Host fine, tunnel just isn't running | Go to step 2 |
| `Connection timed out` | Instance stopped, IP changed, or security group blocks you | Go to step 3 |
| `Permission denied (publickey)` | Wrong key or wrong user | Check key path and `ubuntu@` user |

---

## 2. Start the tunnel

### Windows (PowerShell)

Foreground (keeps a terminal window busy; Ctrl+C to stop):

```powershell
ssh -i "C:\Users\HOD\Desktop\production\keys\ustawi.pem" -N `
  -L 15432:fleet-store.cnim02awiv5t.af-south-1.rds.amazonaws.com:5432 `
  -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes `
  ubuntu@13.247.178.217
```

Background (hidden window):

```powershell
Start-Process ssh -WindowStyle Hidden -ArgumentList `
  '-i', 'C:\Users\HOD\Desktop\production\keys\ustawi.pem', '-N', `
  '-L', '15432:fleet-store.cnim02awiv5t.af-south-1.rds.amazonaws.com:5432', `
  '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', `
  'ubuntu@13.247.178.217'
```

To stop a background tunnel: `Get-Process ssh | Stop-Process`

### Linux / Ubuntu

Foreground:

```bash
ssh -i ~/production/keys/ustawi.pem -N \
  -L 15432:fleet-store.cnim02awiv5t.af-south-1.rds.amazonaws.com:5432 \
  -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  ubuntu@13.247.178.217
```

Background (`-f` forks after auth):

```bash
ssh -i ~/production/keys/ustawi.pem -f -N \
  -L 15432:fleet-store.cnim02awiv5t.af-south-1.rds.amazonaws.com:5432 \
  -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  ubuntu@13.247.178.217
```

To stop a background tunnel: `pkill -f "ssh.*15432"`

> On Linux the key must not be world-readable: `chmod 600 ~/production/keys/ustawi.pem`

---

## 3. If the jump host itself is unreachable

Everything below needs the **AWS console** (EC2, region af-south-1 / Cape Town):

1. **Check the instance state.** Stopped → start it. Running but failing status
   checks → reboot.
2. **The public IP changes on restart** unless an Elastic IP is attached.
   After a restart, get the new public DNS/IP from the console and update:
   - the tunnel commands above,
   - the comment in `.env.example`,
   - anything pointing at the remote API by address.
3. **Security group:** SSH (22) is restricted to your IP only. If your ISP
   rotated your address, update the inbound rule to `<your-current-ip>/32`.
   Find your current IP:
   - Windows: `Invoke-RestMethod https://api.ipify.org`
   - Ubuntu: `curl -s https://api.ipify.org`
4. **CrowdSec / Fail2ban ban:** if the instance is up and the SG is correct but
   you're still blocked, SSH in from elsewhere (or use the EC2 serial console)
   and run:
   ```bash
   sudo cscli decisions list
   sudo cscli decisions delete --ip <your-ip>
   sudo fail2ban-client status sshd
   sudo fail2ban-client set sshd unbanip <your-ip>
   ```

---

## 4. Verify end-to-end

With the tunnel up and fleet-server running (`npm run dev`):

### Windows (PowerShell)

```powershell
Invoke-RestMethod http://localhost:3000/health
Invoke-RestMethod http://localhost:3000/api/v1/organisations   # DB-backed; expect 4 orgs
```

### Linux / Ubuntu

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/api/v1/organisations   # DB-backed; expect 4 orgs
```

The four are SUKARI, WESTSUGAR, MENENGAI and KASULU — the last of which is
named "Mufindi Paper Mills Ltd"; the code was never renamed with the org.

`/health` returning 200 only proves the HTTP server is up; the organisations
call proves the Prisma → tunnel → RDS path works. No restart of fleet-server is
needed after fixing the tunnel — the warm-cache sweep retries on its own.
