---
name: adr
description: Write a new architecture decision record in this repository's house style, or find and read the existing ADR that already governs a decision.
argument-hint: '[the decision]'
---

# Architecture decision records

`docs/adr/` is numbered from `0001`, and the next number is one past the highest file
there — read the directory rather than trusting a count written down, including this one.
They exist because these decisions are expensive to reverse, and `AGENTS.md` opens by
telling you to read the one for the area you are touching **before** changing anything.

## Before writing one, check one does not already exist

| ADR    | Governs                         |
| ------ | ------------------------------- |
| `0001` | universe coordinates            |
| `0002` | reference frames                |
| `0003` | render coordinates              |
| `0004` | entity addressing               |
| `0005` | procedural seeds                |
| `0006` | the simulation clock            |
| `0007` | persistence                     |
| `0008` | multiplayer partitions          |
| `0009` | issue-ordinal addressing        |
| `0010` | the cinematic director          |
| `0011` | the application shell and modes |
| `0012` | dockable panels                 |
| `0013` | measured figures                |

If one covers the ground, **you are not relitigating it** — you are either applying it, or
writing a new ADR that supersedes it and says so explicitly.

## The shape

Read the highest-numbered ADR before writing; it is the closest to current style. The
skeleton:

```markdown
# ADR-00NN: <decision, stated as the thing decided — not "choice of X">

Status: accepted · <D Mon YYYY>

## Context

## Decision

## Alternatives considered

## Consequences
```

## What makes one good here

- **The title is the decision, not the topic.** "Dockable panels, with the layout as
  arithmetic" — you can tell what was decided without opening it.
- **Context names the forces, including the embarrassing ones.** ADR-0012 says the first
  version spliced arrays at call sites and had panels in two zones at once. A context that
  reads like a feature request is not a context.
- **The decision is bolded, one sentence, then the bullets that make it precise.**
- **Alternatives were genuinely considered and are named with why they lost.** This is the
  half that stops the decision being reopened in six months.
- **Consequences include what got worse.** Every real decision costs something.
- Prose, not notes. Comments and documents here explain _why_, and specifically why the
  obvious thing does not work.

## After writing it

- Add it to `docs/adr/README.md`.
- If the ADR creates an invariant an agent could violate without reading it, add the
  one-line imperative to `AGENTS.md` § "The rules that actually matter" **and** to the
  matching `.claude/rules/*.md`, plus a row in `docs/agents/invariants.md` — see the
  contract in `.claude/rules/README.md`.
- Record the decision in `CONTEXT.md` with `/context-log`.
