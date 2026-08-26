---
name: audit-patterns
description: Recurring invariant-violation shapes found in InertialRef audits — where they cluster and which checks actually catch them
metadata:
  type: project
---

Recurring shapes found when auditing diffs in this repository, and where they cluster.

**Why:** The invariant list in `AGENTS.md` is long and auditing every rule with equal
suspicion wastes the budget. These are the places violations have actually appeared.

**How to apply:** Check these first, then sweep the rest.

## Documentation-only diffs still carry real risk

An agent-tooling / docs diff cannot violate a determinism or layering invariant, but it
can weaken the _mechanism_ that enforces one. Three checks pay for themselves:

- `.claude/settings.json` — moves between `allow` / `ask` / `deny`. A rule that asserts
  something is "denied outright" is a claim about literal Bash-prefix matchers, and those
  match strings, not intent. `Bash(git push * main:*)` and `Bash(git push origin main)`
  do not cover `git push -u origin HEAD` while standing on `main`.
- Whether a check moved from a local gate to CI. Verify it by reading
  `.github/workflows/check.yml`, not by trusting the prose that says so.
- Heading level of inserted sections. New `##` sections inserted before an existing `###`
  silently reparent that `###` under the wrong section.

## The three-part invariant contract

A new **code** invariant requires all three: a bullet in `AGENTS.md`, a one-liner in
`.claude/rules/`, a row in `docs/agents/invariants.md`. **Process** rules (branching,
writing) deliberately sit outside that contract and mirror `docs/agents/working.md`
§ "Starting work" and `docs/STYLE.md` instead. Both `AGENTS.md` (~line 24) and
`docs/agents/invariants.md` (~line 7) still describe `.claude/rules/` as if every file
in it were a path-scoped mirror of an `AGENTS.md` invariant — they are the two places
that go stale when a non-code rule is added.

## The rules-mirror checklist that mechanically works

For each `.claude/rules/<x>.md`, its `paths:` list must equal `.cursor/rules/<x>.mdc`'s
comma-joined `globs:`; an unscoped rule pairs with `alwaysApply: true`. `README.md` in
`.claude/rules/` is the one file with `paths:` and no Cursor mirror — that asymmetry is
long-standing, not a new defect. The README table lists rules but not itself.

Soft cap: a rule past ~30 lines is competing with the code for attention. Unscoped rules
are supposed to be tighter still, and that is the constraint most likely to slip.

## What `pnpm graph` covers

Acyclicity, layer order, and the no-third-party-runtime-deps ban in `packages/*`. It
reports "12 packages, no cycles, layering intact". It does **not** see a Three.js type in
`packages/*`, a bare `three` import in `apps/game`, or a hosting vendor concept below the
adapter — those stay manual.
