#!/usr/bin/env bash
#
# Clear the box's working tree so a refused deploy can go through — but only
# after proving that nothing on it is unique.
#
#     ! [remote rejected] HEAD -> main (Working directory has unstaged changes)
#
# That refusal means somebody edited tracked files in place on the box. The box
# has been used as a development machine more than once (the repair-assignment
# work of 2026-09-19 was written on it), so the edits are usually the DRAFTS of
# commits that have since landed here — and clearing them loses nothing. But
# "usually" is not a thing to run `git checkout -- .` on, because the one time
# it is wrong, the edit it discards is the only copy in existence.
#
# So this checks first. For every modified file it asks whether that exact
# content already exists somewhere in this repository's history. Only if every
# one of them does will it clear anything, and even then it moves rather than
# deletes.
#
# Read-only by default. Pass --apply to actually clear.
#
#     ./scripts/unblock-box-deploy.sh                 # report
#     ./scripts/unblock-box-deploy.sh --apply         # clear, then re-run the workflow
#
# Host and key come from the environment, because neither belongs in a file
# that is committed:
#
#     BOX_HOST=13.247.178.217 BOX_KEY=../keys/ustawi.pem ./scripts/unblock-box-deploy.sh
#
set -euo pipefail

BOX_HOST="${BOX_HOST:-13.247.178.217}"
BOX_USER="${BOX_USER:-ubuntu}"
BOX_KEY="${BOX_KEY:-../keys/ustawi.pem}"
BOX_DIR="${BOX_DIR:-/home/ubuntu/prod/fleet-server}"
NODE_BIN="${NODE_BIN:-\$HOME/.nvm/versions/node/v24.20.0/bin}"

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

say()  { printf '%s\n' "$*"; }
head2() { printf '\n== %s\n' "$*"; }

[ -f "$BOX_KEY" ] || { say "no key at $BOX_KEY — set BOX_KEY"; exit 1; }

box() { ssh -i "$BOX_KEY" -o IdentitiesOnly=yes -o BatchMode=yes "${BOX_USER}@${BOX_HOST}" "$@"; }

# ── 1 · what does the box actually have ───────────────────────────────────────
# One round trip. `hash-object` is the whole point: a path plus a content hash
# is a question this repository can answer offline, where a diff is only
# something to read.
#
# `-uall` rather than plain `--porcelain`, which COLLAPSES an untracked
# directory to one entry with a trailing slash — and the untracked thing that
# blocks this deploy is `prisma/migrations/<name>/`, so the default would hand
# `hash-object` a directory and get an error instead of an answer.
head2 "reading the box"
state=$(box "cd '$BOX_DIR' && \
  echo \"HEAD \$(git rev-parse HEAD)\" && \
  git status --porcelain=v1 -uall | while read -r st path; do \
    if [ ! -e \"\$path\" ]; then echo \"X - \$path\"; \
    elif [ \"\$st\" = '??' ]; then echo \"U \$(git hash-object \"\$path\") \$path\"; \
    else echo \"M \$(git hash-object \"\$path\") \$path\"; fi; \
  done")

box_head=$(awk '$1=="HEAD"{print $2}' <<<"$state")
say "box HEAD is ${box_head:0:7} — $(git log --format=%s -1 "$box_head" 2>/dev/null || echo 'a commit this clone does not have')"

if ! git merge-base --is-ancestor "$box_head" HEAD 2>/dev/null; then
  say ""
  say "STOP: the box is not an ancestor of your HEAD. It is carrying commits"
  say "this clone has never seen, and a deploy would discard them. Fetch from"
  say "the box before going any further:"
  say "    git fetch box main && git log HEAD..FETCH_HEAD"
  exit 1
fi

# ── 2 · is every edit already committed here ──────────────────────────────────
# Searched across ALL history, not just main: an edit made on the box and then
# committed on a branch is still an edit that exists somewhere, and losing it is
# not what anybody meant by cleaning up.
in_history() {
  local want="$1" path="$2" c
  for c in $(git rev-list --all -- "$path"); do
    [ "$(git rev-parse --quiet --verify "$c:$path" 2>/dev/null)" = "$want" ] && return 0
  done
  return 1
}

head2 "checking every modified file against this repository's history"
safe=1 modified=() blockers=() strays=()

while read -r kind hash path; do
  [ -z "${kind:-}" ] && continue
  case "$kind" in
    HEAD) continue ;;
    M)
      modified+=("$path")
      if in_history "$hash" "$path"; then
        say "  committed already   $path"
      else
        safe=0
        say "  *** ONLY ON THE BOX  $path  ($hash)"
      fi
      ;;
    X)
      # Deleted on the box. There is no content to rescue and the checkout puts
      # it back, so this is the one case that needs nothing but a restore.
      modified+=("$path")
      say "  deleted on the box, will be restored   $path"
      ;;
    U)
      # An untracked file blocks the checkout only if the incoming tree wants
      # that path. Git refuses to clobber untracked files, and it refuses AFTER
      # the dirty-tree check passes — which is how this failure appears twice in
      # a row to somebody who only fixed the first half.
      if git cat-file -e "HEAD:$path" 2>/dev/null; then
        blockers+=("$path")
        if in_history "$hash" "$path"; then
          say "  in the way, committed already   $path"
        else
          safe=0
          say "  *** IN THE WAY, ONLY ON THE BOX  $path  ($hash)"
        fi
      else
        strays+=("$path")
      fi
      ;;
  esac
done <<<"$state"

if [ ${#strays[@]} -gt 0 ]; then
  head2 "untracked, and not in the way — left alone"
  printf '  %s\n' "${strays[@]}"
  say ""
  say "  Not this script's business, but worth a look: .env.bak-* files hold"
  say "  live secrets, and dist.rollback/ is a whole build sitting on a 13 GB"
  say "  disk that also runs the API."
fi

if [ "$safe" -ne 1 ]; then
  head2 "NOT SAFE TO CLEAR"
  say "The starred files exist nowhere but the box. Get them off it before"
  say "anything else — that content has no other copy:"
  say ""
  say "    ssh -i $BOX_KEY ${BOX_USER}@${BOX_HOST} 'cd $BOX_DIR && git diff' > box.patch"
  say ""
  say "then apply it to a branch here and let it deploy through the workflow."
  exit 1
fi

head2 "every edit on the box is already committed here"
[ ${#modified[@]} -gt 0 ] && printf '  restore  %s\n' "${modified[@]}"
[ ${#blockers[@]} -gt 0 ] && printf '  move aside  %s\n' "${blockers[@]}"

if [ "$APPLY" -ne 1 ]; then
  head2 "report only"
  say "Re-run with --apply to clear it, then re-run the failed workflow"
  say "(Actions -> the failed run -> Re-run failed jobs). No new commit is"
  say "needed; the push is against that run's checkout, which has not moved."
  exit 0
fi

# ── 3 · clear it ──────────────────────────────────────────────────────────────
# `checkout --` on named paths, never `reset --hard`: the named paths are the
# ones just proved recoverable, and nothing else on that tree is this script's
# to touch. Blockers are MOVED, because a proof about file contents is not a
# proof that nobody wanted the file.
head2 "clearing"
stash="/tmp/box-deploy-$(date -u +%Y%m%dT%H%M%SZ)"

# Built here and piped to `bash -s` rather than interpolated into an ssh
# command line: the paths go through one round of quoting instead of three, and
# a path with a space stops being a way to run the wrong command on production.
{
  printf 'set -euo pipefail\n'
  printf 'cd %q\n' "$BOX_DIR"
  printf 'mkdir -p %q\n' "$stash"
  for p in ${modified[@]+"${modified[@]}"}; do
    printf 'git checkout -- %q\n' "$p"
  done
  for p in ${blockers[@]+"${blockers[@]}"}; do
    printf 'mkdir -p %q\n' "$stash/$(dirname "$p")"
    printf 'mv %q %q\n' "$p" "$stash/$p"
  done
  printf 'echo "anything moved is under %s"\n' "$stash"
  printf 'echo "--- git status now:"\n'
  printf 'git status --porcelain=v1\n'
} | box bash -s

head2 "migrations"
# The workflow deliberately never runs `prisma migrate deploy`, so the schema
# is a separate question from the code — and on a box that has had
# `migrate dev` run on it, it is a live one. A migration applied FROM the box
# is recorded in _prisma_migrations with a checksum of the file as it was then;
# if the committed copy differs by a byte, `migrate deploy` fails rather than
# no-ops. `migrate resolve --applied <name>` is the fix for that, never a
# re-run, which would fail on duplicate columns.
box "cd '$BOX_DIR' && export PATH=\"$NODE_BIN:\$PATH\" && npx prisma migrate status" || \
  say "  (migrate status failed — check it by hand before deploying)"

head2 "done"
say "Re-run the failed workflow now: Actions -> the run -> Re-run failed jobs."
say "If anything was needed after all, it is in $stash on the box."
