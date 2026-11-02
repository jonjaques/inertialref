#!/usr/bin/env bash
#
# Make a fresh worktree runnable: the gitignored environment files from the main
# checkout, then the dependencies. T3 Code runs this when it creates a thread's
# worktree (`runOnWorktreeCreate` in t3.json), and it is the same one line for any
# checkout git made and nothing else has touched.
#
# Two things `git worktree add` leaves behind, and why each is handled the way it is:
#
#   * The ignored environment files. `apps/game/.env.production` carries the GA
#     measurement id and the `.env.local` files carry the Clerk keys for `pnpm dev`, so a
#     worktree without them builds a bundle that silently measures nothing and serves a
#     game with no accounts. `.worktreeinclude` names them for the worktrees Claude Code
#     creates; this is the same list for the worktrees it does not: everything git
#     ignores whose name is `.env`, `.env.*` or `*.local`. Asked of git rather than
#     searched for with `fd`, because t3.json is read by anyone who opens the repository
#     in T3 Code and git is the one tool every one of them has. `--directory` collapses
#     an ignored directory to a single entry, so `node_modules` is one line rather than a
#     hundred thousand, and an env file inside an ignored directory is deliberately not
#     found — the reach `.worktreeinclude` has.
#   * `node_modules`. pnpm's is a symlink farm into `.pnpm`, so it is neither copied nor
#     symlinked (`.worktreeinclude` says why for each); `pnpm install` rebuilds it from
#     the machine-global store in about three seconds. Through `mise exec` when mise is
#     on the machine: a T3 Code terminal is not an interactive shell, so the mise hook
#     that switches Node per directory has not run in it, and a bare `pnpm` would run
#     the machine's default Node rather than the one `.node-version` pins.
#
# t3.json runs this with `async: false`, so the agent's first turn waits for it. That
# is deliberate: `.claude/hooks/session-start.sh` installs dependencies when it finds
# none, and a hook that fired while this install was half-written would find a
# `node_modules` and trust it.
#
# A missing env file is not an error: a worktree without one is a correct worktree
# that measures nothing. Only a failed install exits non-zero.

set -uo pipefail

here=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "worktree-setup: not inside a git checkout" >&2
  exit 1
}
# The first entry of `git worktree list` is always the main working tree.
main=$(git -C "$here" worktree list --porcelain | sed -n '1s/^worktree //p')

if [ -n "$main" ] && [ "$main" != "$here" ]; then
  copied=0
  while IFS= read -r -d '' path; do
    [ -e "$here/$path" ] && continue
    mkdir -p "$here/$(dirname "$path")"
    cp -p "$main/$path" "$here/$path" && copied=$((copied + 1))
  done < <(git -C "$main" ls-files --others --ignored --exclude-standard --directory -z |
    grep -z -E '(^|/)\.env(\..+)?$|\.local$' || true)
  echo "worktree-setup: copied $copied environment file(s) from $main"
fi

if command -v mise >/dev/null 2>&1; then
  exec mise exec -- pnpm install --frozen-lockfile --prefer-offline
fi
exec pnpm install --frozen-lockfile --prefer-offline
