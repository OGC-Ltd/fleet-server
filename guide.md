# Fleet-Server Dev DB Tunnel — Troubleshooting Guide

The local dev server reaches the private RDS database through an SSH tunnel on
`localhost:15432`, via the EC2 jump host. When the tunnel is down, fleet-server
still starts but every Prisma query fails with `ECONNREFUSED` (e.g. the
`warm-cache sweep failed` log at startup).

- **RDS endpoint:** `fleet-store.c8ty8uocsdjp.us-east-1.rds.amazonaws.com:5432`
- **Jump host:** `ubuntu@ec2-32-198-44-105.compute-1.amazonaws.com` *(IP changed 2026-07-23; was 3.239.71.114 — if the instance restarts without an Elastic IP this changes again)*
- **Key:** `logistics.pem` (NOT `turbo.pem`)
- **Local tunnel port:** `15432`

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
ssh -i "C:\Users\supervisor\Documents\keys\logistics.pem" -o BatchMode=yes -o ConnectTimeout=10 ubuntu@ec2-32-198-44-105.compute-1.amazonaws.com "echo ok"
```

### Linux / Ubuntu

```bash
# Is the tunnel port listening?
nc -z localhost 15432 && echo "tunnel up" || echo "tunnel DOWN"
# or: ss -tlnp | grep 15432

# Is an ssh tunnel process running?
pgrep -af "ssh.*15432"

# Is the jump host reachable? (should print "ok")
ssh -i ~/keys/logistics.pem -o BatchMode=yes -o ConnectTimeout=10 ubuntu@ec2-32-198-44-105.compute-1.amazonaws.com "echo ok"
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
ssh -i "C:\Users\supervisor\Documents\keys\logistics.pem" -N `
  -L 15432:fleet-store.c8ty8uocsdjp.us-east-1.rds.amazonaws.com:5432 `
  -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes `
  ubuntu@ec2-32-198-44-105.compute-1.amazonaws.com
```

Background (hidden window):

```powershell
Start-Process ssh -WindowStyle Hidden -ArgumentList `
  '-i', 'C:\Users\supervisor\Documents\keys\logistics.pem', '-N', `
  '-L', '15432:fleet-store.c8ty8uocsdjp.us-east-1.rds.amazonaws.com:5432', `
  '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', `
  'ubuntu@ec2-18-232-178-169.compute-1.amazonaws.com'
```

To stop a background tunnel: `Get-Process ssh | Stop-Process`

### Linux / Ubuntu

Foreground:

```bash
ssh -i ~/keys/logistics.pem -N \
  -L 15432:fleet-store.c8ty8uocsdjp.us-east-1.rds.amazonaws.com:5432 \
  -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  ubuntu@ec2-32-198-44-105.compute-1.amazonaws.com
```

Background (`-f` forks after auth):

```bash
ssh -i ~/keys/logistics.pem -f -N \
  -L 15432:fleet-store.c8ty8uocsdjp.us-east-1.rds.amazonaws.com:5432 \
  -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  ubuntu@ec2-18-232-178-169.compute-1.amazonaws.com
```

To stop a background tunnel: `pkill -f "ssh.*15432"`

> On Linux the key must not be world-readable: `chmod 600 ~/keys/logistics.pem`

---

## 3. If the jump host itself is unreachable

Everything below needs the **AWS console** (EC2, region us-east-1):

1. **Check the instance state.** Stopped → start it. Running but failing status
   checks → reboot.
2. **The public IP changes on restart** unless an Elastic IP is attached.
   After a restart, get the new public DNS/IP from the console and update:
   - the tunnel commands above,
   - the comment in `.env.example`,
   - anything pointing at the old remote API (e.g. fleettrack's
     `3.239.71.114:3000` base URL).
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
Invoke-RestMethod http://localhost:3000/api/v1/organisations   # DB-backed; expect 5 orgs
```

### Linux / Ubuntu

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3000/api/v1/organisations   # DB-backed; expect 5 orgs
```

`/health` returning 200 only proves the HTTP server is up; the organisations
call proves the Prisma → tunnel → RDS path works. No restart of fleet-server is
needed after fixing the tunnel — the warm-cache sweep retries on its own.
