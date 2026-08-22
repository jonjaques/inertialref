---
name: parallel
description: Fan work out across agents in isolated git worktrees, so several changes are made at once without their edits colliding. Use when asked to work in parallel, or when a task decomposes into genuinely independent pieces.
argument-hint: '[the work to split]'
disable-model-invocation: true
---

# Parallel work in worktrees

A worktree is a separate checkout on its own branch, sharing this repository's history.
Agents in different worktrees cannot touch each other's files — Claude Code blocks an edit
that targets the main checkout from an isolated session.

**This repository is unusually well suited to it**, for one measured reason: a fresh
worktree costs **~3 s** to make runnable, because pnpm hardlinks from the machine-global
store. Verified: `pnpm install --frozen-lockfile --prefer-offline` in a fresh worktree
takes 3.0 s and `pnpm test` passes immediately after. Parallelism here is cheap.

## First decide whether to split at all

Fan-out pays when the pieces are **file-disjoint and independently verifiable**. It costs
more than it saves otherwise, because two agents editing the same module produce a merge
you have to referee.

| Good split                                       | Bad split                                                    |
| ------------------------------------------------ | ------------------------------------------------------------ |
| One package each, at the same layer              | Anything touching `packages/shared` — layer 0 ripples upward |
| A feature in `apps/game`, a fix in `apps/server` | Two agents in `apps/game/src/render`                         |
| One test file each across unrelated suites       | A refactor plus its callers                                  |
| Independent bugs from a list                     | Anything needing a decision the others depend on             |

If the work is sequential, say so and do it in one pass. Do not manufacture parallelism.

## How to launch

Ask for isolation explicitly when spawning:

```
Agent(subagent_type: "worktree-implementer", isolation: "worktree", prompt: "…")
```

Send every independent agent in a **single message** so they run concurrently. Each gets
its own worktree under `.claude/worktrees/`, branched from the current `HEAD` —
`worktree.baseRef` is `"head"` in `.claude/settings.json`, so a worktree carries the
feature branch you are on rather than resetting to `main`.

## The one thing each worktree agent must do first

**A worktree is a fresh checkout with no `node_modules`.** The `SessionStart` hook installs
dependencies for a session, but a subagent is not a session, so it does not fire. Every
agent working in a worktree must run this before anything else:

```bash
pnpm install --frozen-lockfile --prefer-offline
```

`.worktreeinclude` carries the gitignored files that cannot be reconstructed — the
cutscene's reference audio. It deliberately does not carry `node_modules`: pnpm's is a
symlink farm into `.pnpm`, and copying it dereferences the links into ~640 MB.

## Give each agent a verifiable finish line

An isolated agent cannot ask you a question cheaply, so the brief has to carry everything:

- the exact files it owns, and that it must not touch others;
- the invariants that apply — point at the `.claude/rules/` file for its paths, which
  loads automatically once it opens a matching file;
- the command that proves it done: `pnpm typecheck && pnpm test`, or a named test file;
- that it must report what it verified with numbers, not "it works".

## Collecting the work

Each worktree ends up as a branch. Review them one at a time, and land them in dependency
order — lower layers first, because a `packages/*` change can invalidate a
`packages/*` consumer's tests even when the files are disjoint. Run the full
`pnpm check` **after** merging, not only inside each worktree: each one proved itself
against its own tree, and nothing proved them against each other.

A worktree with no changes is removed automatically; one with work stays on disk until you
remove it. `git worktree list` shows them.

## The other parallel tools

- **`/code-review ultra`** — a deep multi-agent review in the cloud, on the current branch
  or a PR number. User-triggered and billed; suggest it, never launch it.
- **`claude --cloud "<task>"`** — a full cloud session per task, running independently of
  this machine. It clones the GitHub remote at your current branch, so **push first**.
  Requires the Node 26 setup script; see `scripts/cloud-setup.sh`.
