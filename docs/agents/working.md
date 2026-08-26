# Working in this repository

How an agent should start, change, verify, and finish work. Commands and
toolchain facts are in [development](../guides/development.md). The invariants
are in [`AGENTS.md`](../../AGENTS.md).

---

## Starting work

A session begins by knowing what tree it is standing in. The `SessionStart`
hook fetches `origin`, fast-forwards local `main` when it can do so without a
checkout, and states the branch, the uncommitted count, and how far ahead of
`origin/main` the branch is. The imperative half is
[`.claude/rules/branching.md`](../../.claude/rules/branching.md), which carries
no `paths:` and so is in context from the first turn.

**A dirty working tree is someone else's work.** Ask what to do with it —
continue on the branch, stash it, commit it as it stands — rather than building
on top of it or cleaning it up. Uncommitted changes are the one repository state
with no history behind it, so a wrong guess there is the only one that cannot be
undone.

**The branch is cut at the first commit, not at the start of the session.** By
then the work has been described and can be named after itself, which is why the
branches here read like their commits rather than like `wip-3`. It comes off
`origin/main`:

```bash
git switch -c feat/<topic> origin/main
```

From `origin/main` rather than from `HEAD`, because `HEAD` may be a branch that
was merged last week — and a branch based on a merged branch produces a pull
request whose diff contains work that already shipped, which is discovered at
review and costs a rebase.

Nothing is committed to `main`.

---

## Before you change anything

1. Read the [ADR](../adr/README.md) for the area you are touching. They are
   short. They exist because those decisions are expensive to reverse.
2. Run `pnpm check`. If it is already red, fix that first or say so. Do not
   pile a change on a broken gate.
3. Find the test that covers the behavior you are about to change. If there
   is not one, write it first.

---

## Where to edit

| Kind of change                         | Where it goes                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Simulation, coordinates, generation    | `packages/*`, observing the layer declared in each `package.json`                                                              |
| Host adapters (workers, saves, Worker) | `apps/game`, `apps/headless`, `apps/server`                                                                                    |
| Overlay UI                             | `apps/game/src/hud/`, through the existing wrappers, not a one-off control                                                     |
| Modes and routes                       | `apps/game/src/pages/` — the mode is a function of the path, never React state                                                 |
| Dock layout                            | `apps/game/src/dock/layout.ts` and `dock/floating.ts`, never a splice at a call site                                           |
| Star catalog ingest                    | `apps/ingest/` — offline, never at play time                                                                                   |
| Solar System measurements              | `packages/universe/src/solar/` — transcribed facts, checked against `data/reference/solar-system.json`                         |
| Anything under `data/`                 | Fix the pipeline in `apps/ingest/`, never the artifact. A correction applied to the output alone is undone by the next rebuild |
| Brand assets                           | `design/brand/brandmark.svg` only; `pnpm brand` writes the rest                                                                |

Do not assemble a session by hand. `openSession` in `packages/devtools` is the
one constructor. A host passes adapters in; it does not reconstruct the graph.

---

## Definition of done

Not "the browser rendered something." Done means:

- The implementation is correct.
- The architectural boundaries still hold (`pnpm graph`).
- Determinism is still determinism. Add every new canonical field to
  `world.stateHash()`; coverage is manual, not automatic. See
  [determinism](../concepts/determinism.md#determinism-in-the-simulation-not-just-generation).
- Tests exist and pass, including a regression test when a defect exposed a
  missing invariant — and you have **watched that regression test fail** with the
  defect reintroduced. Three have failed that check here for three different
  reasons; see [testing](../guides/testing.md#prove-a-regression-test-can-fail).
- `pnpm check` is green.
- The ADRs and `CONTEXT.md` reflect any meaningful architectural change.
- The debug tooling can inspect whatever you added.

A Stop hook runs `graph → lint → typecheck → test` after a turn that touched
source. It is a safety net, not the definition of done. The full `pnpm check`
gates the push, which is what the `ship` skill runs, and `pnpm sim --self-test`
runs in CI. `IR_SKIP_GATE=1` disables the hook when you must.

---

## After a meaningful change

- **Code comments** explain why, and specifically why the obvious thing does
  not work. Do not restate the code, and do not narrate what the file said
  before. [`docs/STYLE.md`](../STYLE.md) § "Code comments".
- **Everything written is written in the present tense.** The code is what the
  product does now; a comment, a guide, a plan or a pull request body describes
  it as it stands, never as the version it replaced.
  [`docs/STYLE.md`](../STYLE.md) § "Look forward, not back".
- **Technical docs** update when the page would otherwise describe a previous
  version. See the [docs curator](../../.claude/agents/docs-curator.md).
- **`CONTEXT.md`** gets a dated entry when you decided something, measured
  something, or found a bug that must not return. Use the `context-log` skill.
  Do not use `CONTEXT.md` as a substitute for an ADR or a concept page.
- **A new invariant** goes in `AGENTS.md` and as a one-liner in
  `.claude/rules/` — see that folder's [contract](../../.claude/rules/README.md).
  Add a row to [invariants.md](invariants.md) pointing at the technical page.
- **A count or a measurement in prose goes stale silently.** Grep for the old
  number before you finish: "eight planets", "twenty moons", "19 maps", "thirty
  invariants" and "twelve decisions" were all true and all in several files at
  once. `README.md`, `PRODUCT.md`, `docs/roadmap.md`, `docs/design/` and the
  guides each state the same facts for different audiences.

---

## Committing

**Commit without being asked.** A commit is reversible and costs nothing; a
session that ends with forty files in one lump is neither reviewable nor
bisectable. Commit each coherent piece once the Stop gate is green.

Every commit gets a subject that is a declarative claim behind a conventional
prefix, and an extended body saying **why** — specifically why the obvious
approach did not work, with the numbers that settled it.
[`docs/STYLE.md`](../STYLE.md) § "Commit messages" is the specification;
`git log --oneline -20` is the calibration.

A commit message is the one place a backward glance is correct, because a commit
exists to describe a change. That license does not extend to the source comment
next to it.

Pushing and opening a pull request are [`/ship`](../../.claude/skills/ship/SKILL.md),
which runs the full `pnpm check`, opens the PR as a **draft**, watches CI in the
background, and marks it ready only once the checks are green and the
verification CI cannot do — a screenshot, a before/after pair, a headless probe
— is attached.

---

## Reporting

Report completion as: Implemented / Architecture decisions / Tests and
verification / Known limitations / Recommended next step.
