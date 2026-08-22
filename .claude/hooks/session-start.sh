#!/usr/bin/env bash
#
# SessionStart hook — make the working directory runnable before anything reads it.
#
# Two situations produce a checkout with no `node_modules`, and in both of them the
# first thing an agent does is run a command that fails for a reason that has nothing
# to do with the task:
#
#   * a git worktree (`--worktree`, or a subagent with `isolation: worktree`), which is
#     a fresh checkout — `node_modules` is gitignored and therefore absent;
#   * a cloud session, which clones the repository and nothing else.
#
# `pnpm install` costs ~3s here because pnpm hardlinks from the machine-global store,
# so paying it unconditionally-when-missing is cheaper than the round trip of an agent
# discovering the failure and reasoning about it. `.worktreeinclude` cannot solve this:
# pnpm's `node_modules` is a symlink farm into `.pnpm`, and copying it dereferences the
# links into ~640 MB of duplicated files.
#
# Never exits non-zero. A failed install must surface as a message, not as a session
# that refuses to start.

set -uo pipefail

payload=$(cat)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$cwd" ] || cwd="$PWD"
[ -d "$cwd" ] || exit 0

notes=()

# --- dependencies ------------------------------------------------------------------

if [ -f "$cwd/pnpm-workspace.yaml" ] && [ ! -d "$cwd/node_modules" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    if (cd "$cwd" && pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1); then
      notes+=("Installed dependencies in $cwd (fresh checkout had no node_modules).")
    else
      notes+=("pnpm install FAILED in $cwd. Run 'pnpm install' and read the output before trusting any test result.")
    fi
  else
    notes+=("No pnpm on PATH and no node_modules in $cwd. Enable corepack or install pnpm 11 first.")
  fi
fi

# --- runtime -----------------------------------------------------------------------
#
# Node 26 is not a preference. `pnpm sim`, `pnpm test` and the vitest suite execute the
# TypeScript sources directly through type stripping, with no build step, so an older
# runtime does not fail slowly — it fails at the first import. Cloud session images ship
# Node 20/21/22, which is the one environment where this reliably bites.

want=$(tr -d '[:space:]' <"$cwd/.node-version" 2>/dev/null || echo "")
have=$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1)
if [ -n "$want" ] && [ -n "$have" ] && [ "$have" -lt "$want" ] 2>/dev/null; then
  if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
    notes+=("Node $have is too old — this repository needs Node $want for type stripping (\`pnpm sim\`, vitest). Cloud images ship Node 20/21/22. Fix it once for every future session by pasting scripts/cloud-setup.sh into the environment's Setup script field at claude.ai/code; a SessionStart hook cannot fix it because it cannot change PATH for later commands.")
  else
    notes+=("Node $have is older than the pinned Node $want in .node-version. Type stripping will fail; run 'mise install'.")
  fi
fi

# --- report ------------------------------------------------------------------------
#
# systemMessage rather than plain stdout: plain stdout is shown to the human, and these
# notes exist to stop an agent misreading an environment failure as a code failure.

if [ ${#notes[@]} -gt 0 ]; then
  printf '%s\n' "${notes[@]}" | jq -Rs '{systemMessage: .}'
fi

exit 0
