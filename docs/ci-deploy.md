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
| `EC2_SSH_KEY` | Private key for `ubuntu@` on the box — the whole PEM including the `-----BEGIN`/`-----END` lines | the contents of `keys/ustawi.pem` — `logistics.pem` reached the OLD eu box and opens nothing now |
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
  someone's manual edit fails loudly instead of quietly winning. It reads
  `! [remote rejected] HEAD -> main (Working directory has unstaged changes)`,
  and the recipe is below.
- **No `.env` management.** That file is root-owned on the box and holds the
  prod-only poller flags. New configuration belongs in `.env.example` and the
  schema in `src/config/env.ts`, committed — not injected at restart.

## If the push is refused

```
! [remote rejected] HEAD -> main (Working directory has unstaged changes)
```

Nothing has been deployed: this is the FIRST step of the deploy job, so the box
is still running the previous build and the only thing that failed is the
attempt to replace it. There is no urgency and no half-applied state.

It means somebody edited a tracked file on the box in place. Find out what,
before undoing it — that edit is the only copy of whatever it was:

```bash
ssh -i keys/ustawi.pem ubuntu@<host>
cd ~/prod/fleet-server && git status && git diff
```

**The box is somebody's development machine, and that is the usual cause.**
The repair-assignment work of 2026-09-19 was written on it — five files under
`src/modules/repairs/` edited in place and a migration created there with
`prisma migrate dev` — and then brought home and committed as `3377625`,
`c4718ba` and `d88f890`. The box was never cleaned up afterwards, so the drafts
sat in its working tree until the next deploy tried to overwrite them and was
refused. Expect that shape again; expect it not to be labelled.

What makes it safe to clear is not the diff looking familiar. It is that the
exact content is already committed somewhere in this repository — a question a
content hash answers and reading a diff does not. `scripts/unblock-box-deploy.sh`
asks it for every modified file, across all branches, and refuses to clear
anything if even one file's content exists nowhere else:

```bash
./scripts/unblock-box-deploy.sh            # report, changes nothing
./scripts/unblock-box-deploy.sh --apply    # clear, then re-run the workflow
```

It also handles the half of this that bites people twice. `updateInstead`
checks for a dirty tree, and *then* the checkout refuses to clobber untracked
files the incoming tree wants — so a box carrying an untracked
`prisma/migrations/<name>/` that a commit also adds fails a second time, with a
different message, to somebody who only fixed the first half. The script moves
those aside rather than deleting them.

Then re-run the workflow (Actions → the failed run → **Re-run failed jobs**).
Nothing needs a new commit; the push is against `HEAD` of the run's checkout,
which has not moved.

Do not reach for `git reset --hard` to get past the refusal in one move: that is
exactly the silent discard it exists to prevent.

### The schema is a separate question

A migration created on the box with `migrate dev` has **already been applied to
the shared RDS**, and `_prisma_migrations` records a checksum of the file as it
was at that moment. If the copy that was later committed differs by a byte —
comments tidied on the way in, say — then `prisma migrate deploy` fails on a
checksum mismatch rather than no-opping. The fix is
`prisma migrate resolve --applied <migration-name>`, never a re-run, which would
fail on duplicate columns. Check before deploying code that reads the new
columns:

```bash
ssh -i keys/ustawi.pem ubuntu@<host>   'cd prod/fleet-server && export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH && npx prisma migrate status'
```

### While you are in there

`.env.bak-*` files accumulate in `~/prod/fleet-server` — nine of them by
2026-09-19 — and they hold live secrets with whatever permissions the copy that
made them happened to use. `dist.rollback/` is a whole build on a 13 GB disk
that also runs the API. Neither blocks a deploy, and nothing will ever remove
them on its own.

**`dash` will not have failed alongside it**, and that is not luck. Its workflow
pushes to a temporary branch and then runs `git merge --ff-only` on the box, so
a dirty tree only stops it when the dirt is in a file the merge touches. The two
repositories deploy on the same commit but not on the same interlock: a green
`dash` run says nothing about whether the API moved.

## If a deploy goes wrong

The workflow polls `/health` after the restart and prints the last 60 lines of
`pm2 logs` when it fails. To go back:

```bash
ssh -i keys/ustawi.pem ubuntu@<host>
export PATH=$HOME/.nvm/versions/node/v24.20.0/bin:$PATH
cd ~/prod/fleet-server && git reset --hard <previous-sha> && npm run build && pm2 restart server
```

The pm2 app is **`server`**, not `fleet-server`. There were two apps on this
directory until 2026-08-10 — `server` held port 3000 and did the polling,
`fleet-server` held neither and raced it into duplicate-key errors — and the
second was deleted. Restarting the old name during a rollback is the worst
moment to discover it restarts nothing, so check `/health`'s `uptime` afterwards:
seconds means it came back, hours means you are still on the bad build.
