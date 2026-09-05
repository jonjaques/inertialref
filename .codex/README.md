# Codex in InertialRef

Codex uses the same working rules and executable checks as Claude Code. The
shared sources stay in `.claude/`; this directory contains the native adapters.

| Configuration        | Source                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Startup instructions | `AGENTS.md`, then its linked handbook and relevant rule details                            |
| Skills               | `.agents/skills/*` symlinks to `.claude/skills/*`                                          |
| Subagents            | `.codex/agents/*.toml` reads `.claude/agents/*.md`                                         |
| Lifecycle            | `.codex/hooks.json` calls `scripts/agents/codex-hook.mjs`, which invokes `.claude/hooks/*` |
| Repository settings  | `.codex/config.toml` enables hooks and subagents and sets a 64 KiB instruction budget      |

Paths in this table are relative to the repository root. Skills resolve their
relative references from the shared `.claude/skills/<name>/` directory.

## Hook behavior

`SessionStart` runs the shared dependency setup and branch report. Commands
resolve the current Git root, including when Codex starts in a subdirectory or
a linked worktree. The adapter sets the hook's project directory to that root;
a worktree never formats or gates the main checkout by accident.

`PostToolUse` translates each `apply_patch` path into the shared formatter's
single-file input. Additions, updates, and move destinations are formatted;
source deletions mark the gate dirty even though no file remains to format.
Shell edits require explicit formatting and verification, as they do in Claude.

`Stop` runs the shared `graph → lint → typecheck → test` gate. Codex turn IDs
supply the per-prompt retry counter; Stop continuations keep the original
counter so a persistent failure cannot restart its budget on every retry.
The shared `IR_SKIP_GATE=1` escape hatch applies. The full `pnpm check` remains
the completion gate for code changes.

Hooks require the host's trust approval. Repository configuration cannot grant
that trust or override managed policy. Reload the session after configuration
changes and review any hook trust prompt. If hooks are unavailable, perform
setup, formatting, and checks explicitly; do not assume a hook ran.

## Host differences

Claude's `Agent`, `Monitor`, `isolation: worktree`, model names, and automatic
memory are host-specific. Use Codex collaboration tools for authorized
subtasks, explicit Git worktrees for isolation, and `gh pr checks` with bounded
polling for a requested CI watch. Do not spawn a new user-owned task merely to
translate a Claude subagent call. Preserve the shared skill's workflow and
opt-in boundaries when adapting its tool examples.

The invariant auditor reads `.claude/agent-memory/invariant-auditor/` and
returns proposed additions in its report. It is configured read-only. Other
roles inherit the user's model and permission settings. The worktree role
requires an assigned existing worktree; its name does not create one.

Claude's permission allow/deny matchers are not Codex permissions. This setup
leaves the host's approvals, sandbox, model selection, and credentials alone.
Keep permission policy in the host's supported configuration rather than
translating Claude matchers into broad shell allowances.

## Verification and references

Run `pnpm vitest run scripts/agents/codex-hook.test.mjs` for the adapter and
`pnpm check` for the repository. The adapter tests cover patch paths, deletion
markers, checkout selection, failure propagation, and continuation budgets.

Configuration follows the official [hooks](https://learn.chatgpt.com/docs/hooks),
[skills](https://learn.chatgpt.com/docs/build-skills), and
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
