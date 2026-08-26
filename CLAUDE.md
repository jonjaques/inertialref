# CLAUDE.md

Claude Code specifics for this repository.

**Read [`AGENTS.md`](AGENTS.md) first.** It is the working card: invariants and
definition of done. The rest of the agent handbook is
[`docs/agents/`](docs/agents/README.md). Human documentation is
[`docs/`](docs/README.md). This file is only what is specific to Claude Code
on this machine.

---

## Orientation

| File                                    | What it is                                                       |
| --------------------------------------- | ---------------------------------------------------------------- |
| [`AGENTS.md`](AGENTS.md)                | Invariants and definition of done. Read first.                   |
| [`docs/agents/`](docs/agents/README.md) | How to work here as an agent.                                    |
| [`docs/`](docs/README.md)               | Vision, architecture, concepts, ADRs, guides, design bible.      |
| [`docs/STYLE.md`](docs/STYLE.md)        | House voice — docs, comments, commits. American English.         |
| [`CONTEXT.md`](CONTEXT.md)              | Build log. Read on demand; do not treat it as the working guide. |
| [`README.md`](README.md)                | Project overview and the twelve proven capabilities.             |
| [`.claude/`](.claude/rules/README.md)   | Rules, skills, agents, hooks. Path-scoped rules load themselves. |

Commands, toolchain, and conventions:
[`docs/guides/development.md`](docs/guides/development.md).

Driving the simulation:
[`docs/agents/driving.md`](docs/agents/driving.md),
[`docs/guides/harness.md`](docs/guides/harness.md).

---

## What is automatic here

Most of `.claude/` runs without being asked.

- **Rules load themselves.** Each file has `paths:` globs and enters context
  only when a matching file does. They exist because `AGENTS.md` holds the
  invariants but Claude Code does not auto-load it. `AGENTS.md` stays canonical
  and carries the reasoning; the rules carry only the imperative. The contract is
  [`.claude/rules/README.md`](.claude/rules/README.md).
  Two rules carry no `paths:` and are therefore in context from the first turn:
  `branching.md`, because the first commit happens before any directory rule
  would fire, and `writing.md`, because a commit message is not a file a glob
  can match.
- **The session knows what tree it is in.** `SessionStart` fetches `origin`,
  fast-forwards local `main` when it can do so without a checkout, and states
  the branch, the uncommitted count, and the distance from `origin/main`. It
  does not create a branch — that happens at the first commit, when the work
  has a name. A dirty tree at session start is a question for you, not a
  decision for the agent. In a linked worktree it reports nothing about the
  branch: that tree is already on one cut for a single change, and saying "you
  are not on main" to it is noise.
- **The Stop hook runs the gate.** After a turn that touched a
  `.ts` / `.tsx` / `.mjs` / `.json` file, `graph → lint → typecheck → test`
  runs. A failure comes back as work to do, not a finished task. It blocks at
  most three times per prompt, then reports and lets go. `pnpm build` is not
  in it. The full `pnpm check` gates the push, which is what `/ship` runs, and
  `pnpm sim --self-test` runs in CI. `IR_SKIP_GATE=1` disables it.
- **Edits are formatted for you.** Prettier runs on every file written. Do
  not run `pnpm format` or `pnpm lint` by hand — you would re-read output the
  hooks suppress.
- **A fresh checkout installs itself.** `SessionStart` runs `pnpm install`
  when `node_modules` is absent. This covers worktrees and cloud sessions. It
  does **not** fire for subagents: an agent working in a worktree must run
  `pnpm install --frozen-lockfile --prefer-offline` itself, first.

| Skill          | For                                                       |
| -------------- | --------------------------------------------------------- |
| `/drive`       | Driving the game: harness, headless runner, browser traps |
| `/ship`        | Check → commit → draft PR → watch CI → ready. You invoke  |
| `/parallel`    | Fanning work across worktrees. Never auto-invoked         |
| `/adr`         | Writing an ADR in house style                             |
| `/context-log` | Appending to `CONTEXT.md`                                 |

| Agent                  | For                                               |
| ---------------------- | ------------------------------------------------- |
| `invariant-auditor`    | Auditing a diff against the invariants. Read-only |
| `property-tester`      | `fast-check` properties for anything mathematical |
| `worktree-implementer` | One isolated change, in its own worktree          |
| `docs-curator`         | Checking that the docs still describe the code    |

**Cloud sessions need one manual step.** Cloud images ship Node 20/21/22;
this repository needs Node 26 for type stripping. Paste
[`scripts/cloud-setup.sh`](scripts/cloud-setup.sh) into the environment's
**Setup script** field at claude.ai/code — once per environment; the result
is snapshotted. Until then `claude --cloud` starts and fails at the first
import.

---

## Working style

- The rules in `AGENTS.md` are not advisory. Each exists because violating it
  is a rewrite later rather than a refactor.
- Prefer a property-based test to an example when the thing under test is
  mathematical.
- When a test's bound is loose because of a real limit, name the limit in the
  assertion.
- Write documentation, comments and commit messages in the voice in
  [`docs/STYLE.md`](docs/STYLE.md), and write all of them in the present tense.
  The code is what the product does now; nothing describes the version it
  replaced. History has three homes — `CONTEXT.md`, an ADR, and the commit
  message of the change itself.
- Commit each coherent piece as it goes green, without asking. Push and the
  pull request are `/ship`.
- Report completion as: Implemented / Architecture decisions / Tests and
  verification / Known limitations / Recommended next step.
