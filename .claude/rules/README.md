---
paths:
  - '.claude/rules/*.md'
  - 'AGENTS.md'
  - 'CLAUDE.md'
---

# .claude/rules

Path-scoped instructions. A rule with `paths:` frontmatter loads **only when a file
matching one of its globs enters context** — so an agent editing `dock/layout.ts` is told
about the one-panel-one-zone invariant at the moment it opens the file, and an agent
editing the catalogue is not.

This exists because of a measurable gap. `AGENTS.md` holds thirty invariants, each one
there because violating it is a rewrite rather than a refactor — and nothing loads it.
`CLAUDE.md` says "read AGENTS.md first", which is a request, not a mechanism. A session
that never reads it operates with none of them.

**A rule with no `paths:` loads at session start**, like `CLAUDE.md` — which is why this
file has them too, pointed at the two sides of the contract it describes. It loads when
you open a rule or `AGENTS.md`, and costs nothing the rest of the time.

## The maintenance contract

**`AGENTS.md` stays canonical.** It is vendor-neutral, it carries the reasoning, and it is
what a human reads. These files carry only the _imperative_ — the one line that has to be
in context to prevent the mistake — and point at the section or ADR that says why.

That split is what keeps the duplication from rotting: the imperatives are the stable
half. When you change a rule, change it in `AGENTS.md` and grep here for the one-liner.
When you add one, ask whether an agent could violate it without ever opening `AGENTS.md`;
if so it belongs here too.

Do not paste reasoning into these files. A rule that grows past ~30 lines is being read on
every touch of its directory, and the thing it is competing with for attention is the code.

| Rule             | Loads when you touch                                          |
| ---------------- | ------------------------------------------------------------- |
| `packages.md`    | anything in `packages/*`                                      |
| `determinism.md` | the simulation, procedural, universe, spatial or physics core |
| `react-shell.md` | any `.tsx` in the client                                      |
| `rendering.md`   | `render/`, `scene/`, or `packages/rendering`                  |
| `cutscenes.md`   | the cinematic director, its scripts, or `cinema/`             |
| `dock.md`        | `apps/game/src/dock`                                          |
| `catalogue.md`   | the star catalogue or the ingest app                          |
| `server.md`      | the Worker, net, protocol or persistence                      |
| `testing.md`     | any `*.test.ts`                                               |
