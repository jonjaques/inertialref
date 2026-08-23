---
name: context-log
description: Append a dated entry to CONTEXT.md, the build log — what landed, what was decided, what was measured, and which bug must not come back.
argument-hint: '[what to record]'
---

# The build log

`CONTEXT.md` is the build log: what actually exists, what was decided and why,
and which mistakes have already been made and must not return. It is a diary,
not the working guide — that is `AGENTS.md` and `docs/agents/`. It is long and
**deliberately not loaded into context** — it is read on demand, which is why
entries have to be findable by their headings.

## Where the entry goes

Sections are `##`, chronological, each titled with a date. The newest work goes
**immediately before `## Known gaps`**, which stays last. Two other sections are
cumulative rather than dated and are appended to in place:

- `## Bugs the tests found (worth not reintroducing)`
- `## Known gaps`

Also update `## Current state` near the top when a package changes state in its table, or
when a capability claim changes.

## The shape of an entry

```markdown
## <What it was, in the repository's voice> (DD Mon YYYY)
```

Look at the existing headings before writing one. They are not summaries — "The horizon
gap (resolved 20 Aug 2026 — it was the triangle winding)", "A real hull, and the canvas
that would not present", "Time warp, and the overlay that found it". The heading carries
the finding.

## What earns a place

- **A decision, with the reasoning that produced it** — especially one an ADR is too heavy
  for.
- **A measurement.** Numbers with units and the conditions they were taken under: tick
  rates, frame budgets, file sizes, counts. `docs/` describes design; this file records
  what was observed.
- **A bug and its real cause**, phrased so reintroducing it is recognisable. "It was the
  triangle winding" is the useful half.
- **Something tried and rejected**, and why. This is the highest-value content in the file
  and the easiest to leave out.

## What does not

- Anything the code, the tests or `git log` already say.
- Restating an ADR. Link to it.
- Progress narration. Nobody needs to know a file was created.

## House style

Prose, in the same voice as the rest of the file. Explain _why_, and specifically why the
obvious thing did not work. Convert relative dates to absolute. If an entry ends up being a
rule an agent must not violate, it also belongs in `AGENTS.md` and `.claude/rules/` — see
`.claude/rules/README.md`.
