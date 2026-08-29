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
  Three rules carry no `paths:` and are therefore in context from the first
  turn: `branching.md`, because the first commit happens before any directory
  rule would fire; `writing.md`, because a commit message is not a file a glob
  can match; and `browser.md`, because "check the app" is answered by picking a
  tool before anything has been opened.
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
- **Edits are formatted for you — but only the ones the hook can see.**
  Prettier runs on `Edit`/`Write`/`MultiEdit`, so do not run `pnpm format` or
  `pnpm lint` by hand after those; you would re-read output the hooks suppress.
  A file rewritten **through the shell** — a heredoc, `sed`, a script — fires no
  hook, and the first thing that notices is `format:check` in CI. Run prettier
  on those paths yourself, or make the edit through the tool.
- **A fresh checkout installs itself.** `SessionStart` runs `pnpm install`
  when `node_modules` is absent. This covers worktrees and cloud sessions. It
  does **not** fire for subagents: an agent working in a worktree must run
  `pnpm install --frozen-lockfile --prefer-offline` itself, first.

| Skill          | For                                                     |
| -------------- | ------------------------------------------------------- |
| `/drive`       | Driving the game: harness, headless runner, CDP driver  |
| `/ship`        | Rebase → check → audit → verify → PR, ready. You invoke |
| `/parallel`    | Fanning work across worktrees. Never auto-invoked       |
| `/adr`         | Writing an ADR in house style                           |
| `/context-log` | Appending to `CONTEXT.md`                               |

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
  assertion. **The limit is the measured one, not the derived one** — a bound
  written from the arithmetic admitted every cache size that still strobed,
  because the arithmetic described a floor and the defect lived above it.
- **A figure measured at one operating point is a figure about that point.**
  Earthrise is a hover, and a keep set measured there is invariant in a way it
  is not once the camera moves; the generalisation reached an ADR before an
  audit caught it. Measure at two points that differ in the variable you are
  about to claim does not matter, and name the point in the sentence.
- **Do not perturb the tree while a read-only subagent is auditing it.**
  Reintroducing a defect to watch a test fail is the right check and the wrong
  moment: `docs-curator` reported the working tree contradicting the commit,
  which was true, mine, and thirty seconds of noise for both of us. Land the
  experiment first, or launch the audit after.
- Write documentation, comments and commit messages in the voice in
  [`docs/STYLE.md`](docs/STYLE.md), and write all of them in the present tense.
  The code is what the product does now; nothing describes the version it
  replaced. History has three homes — `CONTEXT.md`, an ADR, and the commit
  message of the change itself.
- Commit each coherent piece as it goes green, without asking. Push and the
  pull request are `/ship`, which rebases onto `origin/main` first — `main`
  enforces linear history and takes squash merges only. Reviewing the result is
  `/code-review`, which the user invokes; `/ship` never does.
- Report completion as: Implemented / Architecture decisions / Tests and
  verification / Known limitations / Recommended next step.
