# Automated deploy (GitHub Actions)

`.github/workflows/deploy.yml` replaces the hand-run ssh ritual. A push to
`main` compiles the commit and runs the unit tests on a clean runner, then —
only if that passes — pushes it into the box's working tree, builds there and
restarts pm2. `dash` has an equivalent workflow of its own.

Nothing runs until the repository secrets below exist. Until then the workflow
will start and fail at the ssh step; it cannot deploy a half-configured box.

## Required repository secrets

Settings → Secrets and variables → Actions.

| Secret | What it is | How to get it |
| --- | --- | --- |
| `EC2_SSH_KEY` | Private key for `ubuntu@` on the box — the whole PEM including the `-----BEGIN`/`-----END` lines | the contents of `keys/logistics.pem` |
| `EC2_HOST` | The box's public DNS name | EC2 console, or the host in your working `ssh` command |
| `EC2_HOST_KEY` | The box's host keys, as `known_hosts` lines | `ssh-keyscan <host>` run once **from a machine you already trust**, pasted whole — all three lines, without `-H` |

`EC2_HOST_KEY` is pinned rather than discovered with `ssh-keyscan` inside the
job, because keyscan trusts whatever answers on the day and this connection
carries the code that is about to run in production.

Paste the **unhashed** output (no `-H`). The workflow re-labels each line's
hostname field to whatever `EC2_HOST` holds before writing `known_hosts`, so the
two cannot silently disagree — pasting keys scanned from the DNS name while
`EC2_HOST` is the IP would otherwise fail with a bare
`Host key verification failed` and nothing pointing at the cause. Only the label
is rewritten; the key material, which is the thing being trusted, is untouched.
Hashed (`-H`) entries still work but cannot be re-labelled, so they must match
`EC2_HOST` exactly.

Verify a paste against the fingerprints — the workflow prints them at the start
of every deploy:

    ssh-keygen -lf <(ssh-keyscan <host> 2>/dev/null)

## The host name is the weak point

The instance has **no Elastic IP**, so its public DNS rerolls on every
stop/start — and `EC2_HOST` then points at nothing until someone edits the
secret. Assigning an Elastic IP (or a Route 53 record) is what makes this
pipeline reliable; without one, an instance restart silently breaks deploys for
both repositories.

## What it deliberately does not do

- **No `prisma migrate deploy`.** A schema change against the shared RDS
  instance is not something a merge should trigger. Run it by hand.
- **No force-push, no `git reset --hard`.** The push relies on
  `receive.denyCurrentBranch=updateInstead`, which REFUSES when the box's
  working tree is dirty. That refusal is the point: a deploy that would discard
  someone's manual edit fails loudly instead of quietly winning. If it fires,
  ssh in, look at `git status`, and resolve it deliberately.
- **No `.env` management.** That file is root-owned on the box and holds the
  prod-only poller flags. New configuration belongs in `.env.example` and the
  schema in `src/config/env.ts`, committed — not injected at restart.

## If a deploy goes wrong

The workflow polls `/health` after the restart and prints the last 60 lines of
`pm2 logs` when it fails. To go back:

```bash
ssh -i keys/logistics.pem ubuntu@<host>
export PATH=$HOME/.nvm/versions/node/v24.18.0/bin:$PATH
cd ~/prod/fleet-server && git reset --hard <previous-sha> && npm run build && pm2 restart server
```

The pm2 app is **`server`**, not `fleet-server`. There were two apps on this
directory until 2026-08-10 — `server` held port 3000 and did the polling,
`fleet-server` held neither and raced it into duplicate-key errors — and the
second was deleted. Restarting the old name during a rollback is the worst
moment to discover it restarts nothing, so check `/health`'s `uptime` afterwards:
seconds means it came back, hours means you are still on the bad build.
