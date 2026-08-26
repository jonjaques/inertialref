---
paths:
  - '.claude/rules/*.md'
  - '.cursor/rules/*.mdc'
  - 'AGENTS.md'
  - 'CLAUDE.md'
---

# .claude/rules

Path-scoped instructions. A rule with `paths:` frontmatter loads **only when a file
matching one of its globs enters context** — so an agent editing `dock/layout.ts` is told
about the one-panel-one-zone invariant at the moment it opens the file, and an agent
editing the catalog is not.

This exists because of a measurable gap. `AGENTS.md` holds the invariants, each one
there because violating it is a rewrite rather than a refactor. Cursor and some
other tools auto-load it; Claude Code does not. There, `CLAUDE.md` saying "read
AGENTS.md first" is a request, not a mechanism. A session that never reads it
operates with none of them.

**A rule with no `paths:` loads at session start**, like `CLAUDE.md` — which is why this
file has them too, pointed at the two sides of the contract it describes. It loads when
you open a rule or `AGENTS.md`, and costs nothing the rest of the time.

Two rules are deliberately unscoped, because no glob would fire in time for them.
`branching.md` governs the first commit, which happens before any rule about a directory
is relevant, and `writing.md` governs prose written into files a glob cannot predict —
including the commit message, which is not a file in the tree at all. Both are held to a
tighter length limit than the scoped ones for the same reason: they are in context for
every session, including the ones that only answer a question.

## The maintenance contract

**`AGENTS.md` stays canonical.** It is vendor-neutral and is auto-loaded by
tools that support the convention. [`docs/agents/`](../../docs/agents/README.md)
is the rest of the agent handbook. These files carry only the _imperative_ —
the one line that has to be in context to prevent the mistake — and point at
the technical page or ADR that says why. The map from rule to technical page is
[`docs/agents/invariants.md`](../../docs/agents/invariants.md).

That split is what keeps the duplication from rotting: the imperatives are the stable
half. When you change a rule, change it in `AGENTS.md` and grep here for the one-liner.
When you add one, ask whether an agent could violate it without ever opening `AGENTS.md`;
if so it belongs here too.

`AGENTS.md` is canonical for the code invariants. The two unscoped rules mirror a
different pair of pages, because what they carry is not a property of the code:
`branching.md` mirrors [`docs/agents/working.md`](../../docs/agents/working.md)
§ "Starting work", and `writing.md` mirrors [`docs/STYLE.md`](../../docs/STYLE.md). The
contract is identical — reasoning there, imperative here.

Cursor's path-scoped files in `.cursor/rules/*.mdc` contain only its `globs:` metadata
and an `@` reference back to these canonical bodies. Keep those globs in step with the
matching `paths:` list; never copy the body into a second rule.

Do not paste reasoning into these files. A rule that grows past ~30 lines is being read on
every touch of its directory, and the thing it is competing with for attention is the code.

| Rule             | Loads when you touch                                          |
| ---------------- | ------------------------------------------------------------- |
| `branching.md`   | every session — no `paths:`                                   |
| `writing.md`     | every session — no `paths:`                                   |
| `packages.md`    | anything in `packages/*`                                      |
| `determinism.md` | the simulation, procedural, universe, spatial or physics core |
| `react-shell.md` | any `.tsx` in the client                                      |
| `rendering.md`   | `render/`, `scene/`, `packages/rendering`, or the observatory |
| `cutscenes.md`   | the cinematic director, its scripts, or `cinema/`             |
| `dock.md`        | `apps/game/src/dock`                                          |
| `catalogue.md`   | the star catalog or the ingest app                            |
| `server.md`      | the Worker, net, protocol or persistence                      |
| `testing.md`     | any `*.test.ts`                                               |
| `site.md`        | the document head, `public/`, the brand pipeline, analytics   |
