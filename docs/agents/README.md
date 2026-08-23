# Agent handbook

This directory is the working guide for **coding agents**. Human documentation
lives under [`docs/`](../README.md). The visual system is
[`DESIGN.md`](../../DESIGN.md). The product brief is
[`PRODUCT.md`](../../PRODUCT.md). The build log is
[`CONTEXT.md`](../../CONTEXT.md).

[`AGENTS.md`](../../AGENTS.md) at the repository root is the auto-loaded working
card: the invariants, the definition of done, and pointers here. Keep that file
short. Put anything an agent needs that is _not_ an invariant here, so a person
reading the technical docs is not walking through session instructions.

---

## Read in this order

1. **[`AGENTS.md`](../../AGENTS.md)** — invariants and definition of done.
2. **The ADR for the area you are about to touch** — [`docs/adr/`](../adr/README.md).
3. **This handbook**, then the technical page for the mechanism.
4. **[`CONTEXT.md`](../../CONTEXT.md)** on demand, when you need the history of
   a bug or a decision that never became an ADR. It is long on purpose and is
   not loaded into context automatically.

| I need to…                          | Read                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------- |
| Not violate an invariant            | [`AGENTS.md`](../../AGENTS.md) · [map to technical docs](invariants.md) |
| Know how to start, verify, and stop | [Working](working.md)                                                   |
| Use the toolchain                   | [Development](../guides/development.md)                                 |
| Drive the simulation                | [Harness](../guides/harness.md) · [Driving](driving.md)                 |
| Change the client shell             | [Client](../guides/client.md) · ADR-0011, ADR-0012                      |
| Author or change a cutscene         | [Cinematics](../guides/cinematics.md) · ADR-0010                        |
| Add generated content or a task     | [Extending](../guides/extending.md)                                     |
| Write a test                        | [Testing](../guides/testing.md)                                         |
| Match the written voice             | [Style](../STYLE.md)                                                    |

Executable machinery — path-scoped rules, skills, hooks, subagents — lives in
[`.claude/`](../../.claude/rules/README.md). Those files are not documentation.
They are the mechanism that puts a one-line rule in context when you open a
matching file. The rule's reasoning stays in `AGENTS.md` and the technical
docs.

---

## What does not belong here

- Product vision, architecture, and concept pages — those are `docs/`.
- Game design — that is `docs/design/`.
- A running diary of what landed — that is `CONTEXT.md`.
- Vendor-specific Claude Code setup — that is [`CLAUDE.md`](../../CLAUDE.md).

If you are about to write a page that a human contributor should also read,
it belongs under `docs/guides/` or `docs/concepts/`, and this handbook should
link to it.
