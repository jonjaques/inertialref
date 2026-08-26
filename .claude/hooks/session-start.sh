#!/usr/bin/env bash
#
# SessionStart hook — make the working directory runnable, and say what state the
# repository is actually in, before anything reads either.
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

# Facts for the model, and alerts for the human. They are different channels and the
# distinction is not cosmetic — see the report section at the bottom.
notes=()
alerts=()

# --- dependencies ------------------------------------------------------------------

if [ -f "$cwd/pnpm-workspace.yaml" ] && [ ! -d "$cwd/node_modules" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    if (cd "$cwd" && pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1); then
      notes+=("Dependencies were installed in $cwd — the fresh checkout had no node_modules.")
    else
      notes+=("pnpm install FAILED in $cwd. No test result from this tree can be trusted until 'pnpm install' runs and its output is read.")
      alerts+=("pnpm install failed in $cwd — this session is starting on a broken tree.")
    fi
  else
    notes+=("There is no pnpm on PATH and no node_modules in $cwd. Corepack or pnpm 11 has to be installed before any command here will run.")
    alerts+=("No pnpm on PATH in $cwd.")
  fi
fi

# --- runtime -----------------------------------------------------------------------
#
# Node 26 is not a preference. `pnpm sim`, `pnpm test` and the vitest suite execute the
# TypeScript sources directly through type stripping, with no build step, so an older
# runtime does not fail slowly — it fails at the first import. Cloud session images ship
# Node 20/21/22, which is the one environment where this reliably bites.

# Guarded rather than redirected: it is the input redirect that fails when the file is
# absent, before `tr` ever starts, so neither `2>/dev/null` on `tr` nor `|| echo ""` gets
# a chance — the shell prints its own "No such file" and the hook writes to stderr on
# every session in a checkout without a .node-version.
want=""
[ -f "$cwd/.node-version" ] && want=$(tr -d '[:space:]' <"$cwd/.node-version")
have=$(node -v 2>/dev/null | tr -d 'v' | cut -d. -f1)
if [ -n "$want" ] && [ -n "$have" ] && [ "$have" -lt "$want" ] 2>/dev/null; then
  if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
    notes+=("Node $have is too old — this repository needs Node $want for type stripping (\`pnpm sim\`, vitest). Cloud images ship Node 20/21/22. The fix that lasts is pasting scripts/cloud-setup.sh into the environment's Setup script field at claude.ai/code; a SessionStart hook cannot fix it, because it cannot change PATH for later commands.")
    alerts+=("Node $have is too old for this repository (needs $want). See scripts/cloud-setup.sh.")
  else
    notes+=("Node $have is older than the pinned Node $want in .node-version. Type stripping will fail; 'mise install' fixes it.")
    alerts+=("Node $have is older than the pinned Node $want. Run 'mise install'.")
  fi
fi

# --- repository state --------------------------------------------------------------
#
# The branch decision is the first thing every session gets wrong, and it is wrong in a
# way that is expensive rather than loud: work lands on `main`, or on top of a branch
# that was already merged, and is only discovered at the pull request. An agent cannot
# see any of that without spending three or four commands on it, and it spends them
# after the first edit rather than before.
#
# So the hook states the facts and .claude/rules/branching.md carries the policy. Facts
# here, imperative there — the same split the rules directory already uses.
#
# What this does *not* do is create the branch. A branch is named after the work, and at
# session start the work has not been described yet; a hook that cut one would produce
# `wip-3` on every session that turned out to be a question. The name is cheap and
# obvious at the first commit, which is where the rule puts it.

if git -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
  git_dir=$(git -C "$cwd" rev-parse --git-dir 2>/dev/null)
  common_dir=$(git -C "$cwd" rev-parse --git-common-dir 2>/dev/null)

  # A linked worktree is already on a branch made for one change, by `/parallel` or
  # EnterWorktree. Reporting "you are not on main" to it is noise, and any suggestion to
  # rebranch would undo the isolation it exists for.
  if [ "$git_dir" = "$common_dir" ]; then
    branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)

    default=$(git -C "$cwd" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
    default=${default#origin/}
    [ -n "$default" ] || default="main"

    # BatchMode stops a locked SSH agent from hanging the session on a passphrase prompt,
    # and ConnectTimeout bounds an offline start at 8s instead of the hook's 300s budget.
    # An unreachable remote is a normal condition here, not an error worth reporting.
    fetched=no
    if GIT_SSH_COMMAND="ssh -o ConnectTimeout=8 -o BatchMode=yes" \
      git -C "$cwd" fetch --quiet --prune origin >/dev/null 2>&1; then
      fetched=yes
    fi

    if [ "$fetched" = yes ]; then
      # `git fetch .` fast-forwards the local ref from the one just fetched, with no
      # second network round trip and no checkout. It refuses a non-fast-forward and
      # refuses outright when the branch is checked out, which is exactly the safety
      # wanted — the case where it refuses is handled below, where the tree is known.
      before=$(git -C "$cwd" rev-parse --short "$default" 2>/dev/null)
      if [ "$branch" = "$default" ]; then
        if [ -z "$(git -C "$cwd" status --porcelain 2>/dev/null)" ]; then
          git -C "$cwd" merge --ff-only "origin/$default" >/dev/null 2>&1
        fi
      else
        git -C "$cwd" fetch --quiet . "origin/$default:$default" >/dev/null 2>&1
      fi
      after=$(git -C "$cwd" rev-parse --short "$default" 2>/dev/null)
      [ "$before" = "$after" ] || notes+=("Local $default was fast-forwarded to origin/$default ($before to $after).")
    else
      notes+=("origin could not be reached, so origin/$default is as stale as the last successful fetch. Anything branched from it now may be behind.")
    fi

    dirty_count=$(git -C "$cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    ahead=$(git -C "$cwd" rev-list --count "origin/$default..HEAD" 2>/dev/null || echo 0)

    state="Git: on branch '$branch'"
    [ "$branch" = "$default" ] && state="$state (the default branch)"
    if [ "${dirty_count:-0}" -gt 0 ]; then
      state="$state with $dirty_count uncommitted path(s)"
    else
      state="$state with a clean working tree"
    fi
    [ "${ahead:-0}" -gt 0 ] && state="$state, $ahead commit(s) ahead of origin/$default"
    notes+=("$state. The branching policy for each of those states is .claude/rules/branching.md.")
  fi
fi

# --- report ------------------------------------------------------------------------
#
# In Claude Code these are two different readers. `hookSpecificOutput.additionalContext`
# reaches the model as a system reminder; `systemMessage` is displayed to the human. The
# notes exist to stop an agent misreading an environment failure as a code failure, so
# they are `additionalContext` — sending them to the human instead delivers "do not trust
# these test results" to the one reader who is not about to run any.
#
# Cursor's sessionStart contract does not have `additionalContext`, and its payload is
# identified the same way gate.mjs identifies it: by `conversation_id`. There everything
# goes through `systemMessage`, which is the only channel that exists.
#
# Alerts are the subset a human has to see either way, because only a human can decide
# to stop and fix the environment rather than let the session run on a broken tree.

cursor_host=$(printf '%s' "$payload" | jq -r 'if (.conversation_id | type) == "string" then "yes" else "no" end' 2>/dev/null)

output='{}'
if [ ${#notes[@]} -gt 0 ]; then
  if [ "$cursor_host" = yes ]; then
    output=$(printf '%s\n' "${notes[@]}" | jq -Rs '{systemMessage: .}')
  else
    output=$(printf '%s\n' "${notes[@]}" |
      jq -Rs '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: .}}')
    if [ ${#alerts[@]} -gt 0 ]; then
      output=$(printf '%s\n' "${alerts[@]}" |
        jq -Rs --argjson base "$output" '$base + {systemMessage: .}')
    fi
  fi
fi
[ "$output" = '{}' ] || printf '%s\n' "$output"

exit 0
