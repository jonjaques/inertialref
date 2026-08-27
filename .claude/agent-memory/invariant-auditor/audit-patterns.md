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

## Order-dependence hides in "found, not authored" fixtures

The repository loves derived fixtures — a thing that searches the world instead of
naming addresses, on the argument that a search survives regeneration. It is a good
argument and it keeps producing the same bug: **the search reads mutable session state.**

`terrainZoo` (`feat/the-terrain-rig`) considers `world.loadedSystems()` first, with no
distance filter, then generates more only if short. So `ir.zoo()` from a session that has
flown anywhere returns different bodies than a fresh one — measured: `rocky-airless` moves
from `s:P223_4_0_8/b:1` to `s:P221_6_1_3/b:3.0` after twenty systems are loaded. The
author knew (the headless runner orders `--terrain-baseline` _before_ `--self-test` for
exactly this reason) but shipped the ordering hack rather than the fix.

**The check:** for any function billed as a stable fixture, ask what it reads that is not
the seed. `loadedSystems()`, `#target`, `clock.tick`, a module-level cache. Then prove it
by loading extra systems before the call. The two-line reproduction is worth more than
any amount of reading.

## Two test idioms here that degenerate into assertions that cannot fail

The house style labels an assertion by interpolating the subject into both sides:
`expect(\`${name}: ${actual}\`).toBe(\`${name}: expected\`)`. When the expected half is
copy-pasted it becomes `expect(\`${name}/${site.id}\`).toBe(\`${name}/${site.id}\`)`—`surveySites.test.ts:163`. Grep new test files for `expect(X).toBe(X)` where both
templates are byte-identical.

The other: a purity test on a memoized function. `surveySites` memoizes on a module-level
`Map`, so calling it twice and comparing returns the same object reference — the test
passes without `derive` ever running again. A purity test has to defeat the cache (vary a
key field, or construct a second body with the same parameters).

## `Observatory.focus` is not a pure retarget — anything calling it inherits its resets

`focus` clears the stance, recomputes `distance` from `framingDistance(radius, fov,
DEFAULT_FILL)` and, with `ease: false`, assigns `#state = #desired` outright. `stand`
calls it unconditionally whenever a destination is passed — and `harness.visit` always
passes one, even when it is the address already focused. Measured: framing 1,101,750 m →
2,392,965 m across a `visit`/`ascend` round trip on Iapetus, which falsifies "back to the
framing you left" in three docstrings and `docs/guides/harness.md`.

**The check:** a new verb that delegates to `focus`, `clear` or `teleport` "to reuse the
resolve step" almost always inherits a reset it did not want. Read the callee's whole
body, not its first line.

## `faceToDirection` is a fourth `BodyFixedDirection` producer AGENTS.md does not name

The invariant enumerates three (`bodyFixedDirection`, `geodeticDirection`,
`regionDirection`) and the enumeration _is_ the enforcement. `terrain.ts:62` exports a
fourth and its own docstring says "there are exactly two producers below". Until
`feat/the-terrain-rig` it was only used inside `terrain.ts` and in tests; `surveySites.ts`
now calls it in production. Not a correctness bug — face-local UV is body-fixed by
construction — but the list should say four or the call should go through
`regionDirection`.

## Design docs carry "Not built" tables that the diff silently falsifies

`docs/design/planetarium.md` § "Not built" still lists "Surface-level free look — the
observatory's floor is the datum sphere" after the branch that built it. `docs/design/`
is cited by name from `AGENTS.md` invariants, so it is not optional prose. Cheap check:
grep the design doc the touched invariant cites for the feature name.

## The mirror goes stale in one direction: AGENTS.md forward, rules back

This is now the highest-yield check in the whole audit and it has fired twice.

When a diff **amends** an existing `AGENTS.md` bullet (rather than adding a new one), the
`.claude/rules/` mirror is almost never amended with it. Adding a _new_ invariant is
ceremonious — author remembers all three homes. Editing an existing one is not.

Worked example: `feat/planetarium-panels` added `orbitScope` to the presentation-switch
bullet in `AGENTS.md` and left `.claude/rules/react-shell.md` enumerating the previous four
fields. That rule is what actually loads when an agent opens a `.tsx`; `AGENTS.md` does not
auto-load. So the drifted mirror is the _only_ thing in context, and it states the previous
rule with authority.

**Mechanical check:** for every `AGENTS.md` bullet the diff touches, grep every proper noun
in it (`grep -o` the backticked identifiers) across `.claude/rules/` and `docs/guides/`.
A field name added to the canonical list and missing from the mirror is the finding.

The three-part contract for a _new_ code invariant still holds and is usually satisfied:
a bullet in `AGENTS.md`, a one-liner in `.claude/rules/` + a `.cursor/rules/*.mdc` whose
comma-joined `globs:` equals the `paths:` list, and a row in `docs/agents/invariants.md`.
**Process** rules (`branching`, `writing`) sit outside it deliberately.

## A new path-scoped rule can contradict a file already inside its own scope

`record.md` landed with `paths: apps/game/src/planetarium/**` and the flat imperative
"the reading is formatted here, never by `Intl`" — while `planetarium/simulationTime.ts`
builds two `Intl.DateTimeFormat`s on a well-argued 16-line rationale (a time zone is a
property of the reader, not of the ephemeris).

**Check:** take each new rule's `paths:` glob and grep the matched files for the thing the
rule forbids. A rule whose scope contains its own counterexample will get a correct file
deleted by a future agent.

## `text-slate-500` is the recurring design-invariant leak

DESIGN.md § Neutral is explicit and _measured_: 600 and 500 are **not text colors**
(4.24:1 on opaque `slate-950`, 3.2:1 with a star behind — and panel ground is
`bg-slate-950/85`, so the star case is the real one). One carve-out: `hud/connection.ts`,
a non-text pip. `.claude/rules/react-shell.md` mirrors it as "chrome text bottoms out at
`slate-400`". It is not in `AGENTS.md`, so it is easy to miss.

Every large new-panel diff reintroduces it — `main` carried 4 sites, one planetarium diff
added 14 more. Cheap check: `git diff origin/main...HEAD -- '*.tsx' | grep '^+' |
rg 'text-slate-500'`. Worst placements are a row's _only_ content and the gloss (which
DESIGN.md assigns to `slate-400` by name).

## `renderTime` is now usually right; the gap is the _test_ for it

Authors of new planetarium/observatory code cite the rule and use `clock.renderTime`
correctly, with a comment. What is missing is a test. Check `dossier.ts`-shaped modules for
the read (usually fine) and then ask what would fail if it were changed back.

Related: `travel.ts`'s `travelTargets` still samples poses at `world.clock.time`. That is a
list readout rather than the picture, so it is arguably outside the rule — but it grows more
consumers every release and is worth re-examining if a row ever becomes positional.

## Filter/selection logic hiding in a private `GameEngine` method

`GameEngine.#maybeTraceOrbits` holds both the rebuild key and the orbit _selection_ filter
that ADR-0014-era design docs argue about at length (129 lines vs 8). It is private, driven
only by `#step`, and has no test; `orbitPaths.test.ts` covers path generation only. Every
new branch added there is untestable where it sits. Recommend extraction to a pure function
in `orbitPaths.ts` rather than asserting the branch is wrong.

The specific silent failure to look for: a new stance/presentation field that changes the
selection must also appear in the rebuild **key**, or the switch is a no-op until something
else invalidates. This diff got it right; nothing would have caught it if it had not.

## Test-strength patterns worth checking in `packages/devtools`

- A "grep every string for banned vocabulary" test that iterates a hand-listed handful of
  addresses, while the test directly above it already walks all 129 bodies of Sol. Merge them.
- No `dossier`/panel test ever opens a **procedurally generated** system. Every fixture is
  Sol via `TEST_CATALOG`. So every `provenance === 'projected'` branch — which is exactly
  the population whose prose is most likely to slip into the engine's voice — is untested.

## What `pnpm graph` covers

Acyclicity, layer order, and the no-third-party-runtime-deps ban in `packages/*`. It
reports "12 packages, no cycles, layering intact". It does **not** see a Three.js type in
`packages/*`, a bare `three` import in `apps/game`, or a hosting vendor concept below the
adapter — those stay manual. `pnpm lint` (oxlint) does catch `react/no-multi-comp`, so
one-component-per-file rarely needs a manual pass; the Fast-Refresh half (a `.tsx`
exporting a non-component constant) does not, and is worth a grep.

## Cadence claims in comments are checkable arithmetic

`App.tsx` publishes the snapshot at `PANEL_HZ = 8` (125 ms). Any hook that keys an effect
on a bucket taken out of that snapshot cannot fire faster than 8 Hz, whatever its bucket
width says. Time warp ceiling is 100,000× (`hud/warp.test.ts`). Multiply before believing
a comment that quotes a millisecond figure.
