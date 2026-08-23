# Working in this repository

How an agent should start, change, verify, and finish work. Commands and
toolchain facts are in [development](../guides/development.md). The invariants
are in [`AGENTS.md`](../../AGENTS.md).

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

| Kind of change                         | Where it goes                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| Simulation, coordinates, generation    | `packages/*`, observing the layer declared in each `package.json`                    |
| Host adapters (workers, saves, Worker) | `apps/game`, `apps/headless`, `apps/server`                                          |
| Overlay UI                             | `apps/game/src/hud/`, through the existing wrappers, not a one-off control           |
| Modes and routes                       | `apps/game/src/pages/` — the mode is a function of the path, never React state       |
| Dock layout                            | `apps/game/src/dock/layout.ts` and `dock/floating.ts`, never a splice at a call site |
| Star catalog ingest                    | `apps/ingest/` — offline, never at play time                                         |
| Brand assets                           | `design/brand/brandmark.svg` only; `pnpm brand` writes the rest                      |

Do not assemble a session by hand. `openSession` in `packages/devtools` is the
one constructor. A host passes adapters in; it does not reconstruct the graph.

---

## Definition of done

Not "the browser rendered something." Done means:

- The implementation is correct.
- The architectural boundaries still hold (`pnpm graph`).
- Determinism is still determinism (`world.stateHash()` covers any new
  canonical field).
- Tests exist and pass, including a regression test when a defect exposed a
  missing invariant.
- `pnpm check` is green.
- The ADRs and `CONTEXT.md` reflect any meaningful architectural change.
- The debug tooling can inspect whatever you added.

A Stop hook runs `graph → lint → typecheck → test` after a turn that touched
source. It is a safety net, not the definition of done. The full `pnpm check`
and `pnpm sim --self-test` belong at commit, which is what the `ship` skill
runs. `IR_SKIP_GATE=1` disables the hook when you must.

---

## After a meaningful change

- **Code comments** explain why, and specifically why the obvious thing does
  not work. Do not restate the code.
- **Technical docs** update when the page would otherwise describe a previous
  version. See the [docs curator](../../.claude/agents/docs-curator.md).
- **`CONTEXT.md`** gets a dated entry when you decided something, measured
  something, or found a bug that must not return. Use the `context-log` skill.
  Do not use `CONTEXT.md` as a substitute for an ADR or a concept page.
- **A new invariant** goes in `AGENTS.md` and as a one-liner in
  `.claude/rules/` — see that folder's [contract](../../.claude/rules/README.md).
  Add a row to [invariants.md](invariants.md) pointing at the technical page.

---

## Reporting

Report completion as: Implemented / Architecture decisions / Tests and
verification / Known limitations / Recommended next step.
