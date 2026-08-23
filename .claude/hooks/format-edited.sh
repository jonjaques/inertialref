#!/usr/bin/env bash
#
# Claude PostToolUse and Cursor afterFileEdit hook. Two jobs, both cheap.
#
#   1. Run prettier on the file that was just written, so `pnpm format:check` is never
#      the thing that fails at the end of a turn. Formatting is not a judgement an agent
#      should be spending tokens on, and a diff full of reflowed lines hides the change.
#
#   2. Record that a *source* file moved, for .claude/hooks/gate.mjs. The Stop hook has
#      no way to know what happened during the turn, and running the gate after a turn
#      that only edited Markdown is six seconds spent proving nothing.
#
# Cursor supplies `file_path` directly and Claude nests it under `tool_input`; both forms
# resolve prettier from the session's own checkout, not from $CLAUDE_PROJECT_DIR. Inside a
# worktree those are different directories and only the former has node_modules. Always
# exits 0 — a formatter is not allowed to interrupt work.

set -uo pipefail

payload=$(cat)
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .file_path // empty' 2>/dev/null)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)
session=$(printf '%s' "$payload" | jq -r '.session_id // "cursor"' 2>/dev/null)

[ -n "$file" ] && [ -f "$file" ] || exit 0
if [ -z "$cwd" ]; then
  cwd=$(git -C "$(dirname "$file")" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")
fi

prettier="$cwd/node_modules/.bin/prettier"
[ -x "$prettier" ] || prettier="${CLAUDE_PROJECT_DIR:-$cwd}/node_modules/.bin/prettier"

case "$file" in
  # --ignore-unknown would make prettier silently skip anything else, but listing the
  # extensions keeps a stray binary or lockfile write from paying for a node startup.
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.jsonc | *.css | *.md | *.html | *.yml | *.yaml)
    [ -x "$prettier" ] && "$prettier" --write --ignore-unknown --log-level=silent "$file" >/dev/null 2>&1
    ;;
esac

# Anything the four tsconfig projects, oxlint, vitest or the layering check would look
# at. Markdown and CSS are deliberately absent: nothing in `pnpm check` reads them.
case "$file" in
  *.ts | *.tsx | *.mjs | *.json)
    cache="${CLAUDE_PROJECT_DIR:-$cwd}/.claude/.cache"
    mkdir -p "$cache" 2>/dev/null && : >>"$cache/dirty-$session"
    ;;
esac

exit 0
