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

## The tree can move under you mid-audit

On the quadtree review the branch gained a commit and four files gained uncommitted edits
while I was reading — a concurrent session fixing the stale-comment sites I was about to
report. Re-run `git status` and `git log --oneline <base>..HEAD` _before writing the
report_, and drop findings that the working tree already fixes. Reporting a fix that is in
flight is the same cost as a false positive.

## What `pnpm graph` covers

Acyclicity, layer order, and the no-third-party-runtime-deps ban in `packages/*`. It
reports "12 packages, no cycles, layering intact". It does **not** see a Three.js type in
`packages/*`, a bare `three` import in `apps/game`, or a hosting vendor concept below the
adapter — those stay manual. `pnpm lint` (oxlint) does catch `react/no-multi-comp`, so
one-component-per-file rarely needs a manual pass; the Fast-Refresh half (a `.tsx`
exporting a non-component constant) does not, and is worth a grep.

## Memoization keys built by _addition_ are the order-dependence bug here

`terrain.ts`'s `surfaceDetailFloor` keyed its memo `radius * 1e6 + resolution + tolerance`,
so `(65, 0.5)` and `(64, 1.5)` collide and whichever call ran first won for both — measured
9 vs 8 on `s:SOL/b:0`, same seed, same body. This is the "generation depends on order"
invariant in its least visible form: the function is pure, the seed is derived from the
address, and the defect is entirely in the cache.

**The check:** for every new module-level `Map`/`WeakMap` in `packages/*`, read the key
expression. Additive composites and template strings without separators are the tell. Prove
it by calling twice in each order from two fresh processes — two lines, and it is the only
way to see it, because every production caller usually passes the defaults and never
collides.

Fixed on `feat/the-quadtree-covers-the-disk`: the key is `${radius}|${resolution}|${tolerance}`
now, separated, and `radius` is over-keying (the walk never reads it) rather than under-keying.

## Running `packages/universe` standalone from /tmp is cheap and settles most claims

`node --experimental-strip-types` runs the sources directly. Absolute imports of
`packages/universe/src/{terrain,system,galaxy}.ts` + `catalog/fixture.ts` (`TEST_CATALOG`,
**not** `testCatalog.ts`) + `catalogStub(TEST_CATALOG.stars[0])` reproduces the test
fixtures in about fifteen lines. Used it to confirm the sea-clamp detail-floor fix goes
red under the mutation (`rootSeed('d')` Earth: old walk 1, shipped walk 9) and to sweep
572 generated bodies for a residual trap (none). A measured mutation beats reading the
test.

Trap: `rg -rn` is `--replace n`, not "recursive with line numbers". It silently rewrites
the matched text in the output — `seedHex` printed back as `n` and nearly cost a false
"this field does not exist" finding. Use `rg -n`.

Recurring companion: the memoized function ships with **no test**, and the tests that do
exist use it on both sides (as the expectation _and_, via a default parameter, as the input
to the thing under test). `terrainRig.test.ts` asserts `descent bottoms out at
surfaceDetailFloor(...)` while `simulateDescent`'s default `maxLevel` _is_
`surfaceDetailFloor(...)` — tautological in the value, so it cannot see the collision.

## "Ready" predicates that test a different cache than the one the drawer reads

`terrainSelect`'s `ready` is documented as the thing that prevents holes: refine only into
regions that are drawable. The streamer answered it with `#fields.has(key)` — the
_heightfield_ cache — while `state()` skips any region whose `RenderPatch` has not been
built, and `#build` builds 4 per frame against 8 fields arriving. A refined parent is
dropped from the selection, so the gap is open sky. Measured on a landing: 204 selected /
104 built at frame 40, worst 138 on arrival and 68 during a sustained descent.

**The check, and it generalizes:** when a predicate names a precondition ("it is drawable",
"it is loaded", "it is ready"), find the code that actually _consumes_ the thing and confirm
it reads the same map. Two caches with a per-frame budget between them is the shape. The
cheap proof is comparing the selected count against the drawn count over a few hundred
headless frames — `game.terrain().patches` vs `game.terrainState().patches.length`.

## An ordering argument in a docstring, with no sort in the code

`#request`'s comment says "coarsest first and then nearest … the order is the argument … a
stable sort keeps that grouping". There is no sort — it filters and slices 8. Measured, the
first eight requests on Earth at 2 m are 470–750 km away, so the budget buys the horizon
rather than the ground underfoot.

Comments that _argue_ for a property are where to look, not comments that state one: the
argument is written when the author has the property in mind, and the sort is what gets
dropped in a later refactor. Grep the function for `sort`/`localeCompare` before believing
it. `TerrainSelection.patches`'s "stable order: face, then quadrant, then depth" was wrong
the same way in the same diff.

## A fix pass's residue: the _guard_ is fixed, the _reader_ is not

The highest-yield check on a "fifteen findings from the review" commit is not whether
each fix works — they usually do — but whether the fix reaches every consumer of the
thing it fixed. Two shapes, both found on `feat/the-quadtree-covers-the-disk`:

- `useSurveySites` added `seedHex` to the effect's dependency array, so the effect
  re-runs on a world replacement — but the render-time guard is still
  `built.of === address ? built.sites : null`. The address is unchanged by a save load,
  so the previous world's sites are returned for one paint, clickable. **Check: when a
  key is widened, grep for every other place that key is compared.**
- The streamer's `#previous` is nulled by `clear()`, but `update()` captures
  `const previous = this.#previous` _above_ the retarget branch that calls `clear()`.
  A local snapshot taken before an invalidating call outlives the invalidation.

## "One constant instead of two that must agree" usually leaves a smaller twin

The fix that retires `GEOMETRY_KEPT = 512` for `GEOMETRY_KEPT = GEOMETRY_CACHE` is
right. But `packages/devtools` cannot import `apps/game`, so `descent.ts`'s
`DEFAULT_CACHE = DEFAULT_MAX_PATCHES * 3` restates the streamer's own
`FIELD_CACHE = DEFAULT_MAX_PATCHES * 3`. The number shrank from 512 to the multiplier
`3`; the failure mode did not change, and nothing asserts the two agree.

Companion: the _test_ keeps the retired number. `terrainRig.test.ts:305` still asserts
`uniqueRegions > 512` under a comment that now names `DEFAULT_MAX_PATCHES * 3` (2,304).
512 is below even one selection (768). **Grep the retired literal across tests, not just
across source.**

## A new gate in the code is a new branch in the docs' flowchart

`terrainStreamer.#resolve` gained `&& body.figure === null`, which removes 92 of Sol's
129 bodies plus every generated body under `ROUNDING_RADIUS` from streaming.
`docs/concepts/streaming.md`'s Mermaid gate node still reads
`"a solid body, relief over 8 px?"`, and ADR-0015's carve-out section is about _mapped_
bodies only. Mermaid node labels are prose nobody greps. When a diff adds a term to a
predicate, grep the docs for the predicate's other terms (`solid body`, `carve-out`).

## Cadence claims in comments are checkable arithmetic

`App.tsx` publishes the snapshot at `PANEL_HZ = 8` (125 ms). Any hook that keys an effect
on a bucket taken out of that snapshot cannot fire faster than 8 Hz, whatever its bucket
width says. Time warp ceiling is 100,000× (`hud/warp.test.ts`). Multiply before believing
a comment that quotes a millisecond figure.

## The last commit on a docs-adjacent branch is the one that breaks the build

`feat/the-docs-join-the-site` added a hand-maintained allow-list
(`scripts/docs/wings.mjs`) and a gate that fails the build on any `docs/**.md` no
wing claims. The _next_ commit on the same branch added
`docs/adr/0016-documentation-as-a-mode.md` — the ADR for the feature — and did not
list it. `pnpm docs:build` throws (`build.mjs:236 assertNothingUnlisted`), and
`pnpm build` runs `docs:build` first, so `pnpm check` is red.

**The check, and it is thirty seconds:** run the tests for the _new_ gate, not the
whole suite. `pnpm vitest run <the new test file>`. A feature that ships an
exhaustiveness gate over a directory will be violated by the documentation commit
that follows it, because the author is thinking about prose by then. Do this
_last_, after the tree has stopped moving.

## Count words in doc headers drift on every row added

`AGENTS.md`-adjacent prose likes to open a table with its own cardinality —
"Fourteen decisions", "Four values, and each one is a different answer". Nothing
greps these. `docs/adr/README.md:3` was already off by one before this branch and
is off by two after; `paths.ts:88`'s `MODES` docstring said "Four values" over a
five-row table it had just gained, in the same hunk.

**Cheap check:** for every table the diff adds a row to, grep the paragraph above
it for a number word. `rg -n 'One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen'`
over the touched markdown is enough.

## A comment's _reason_ can be false while its code is right

`useDocsFraming.ts` destructures `framing` into four values "because the manifest
hands back a fresh `framing` on every render … eight times a second". Neither half
is true: `loadManifest` memoizes the promise, `useManifest` stores the resolved
object and `wingFor` returns a member of `manifest.wings`, so the identity is
stable — and `DocsMode` subscribes to no engine slice, so it never re-renders at
`PANEL_HZ` at all. The destructuring is still the right call. This repository's
comments are load-bearing enough that a false premise is a finding on its own: the
next agent "simplifies" against it.

**The check:** a comment that cites a cadence (`8 Hz`, `every render`, `every
frame`) is arithmetic — find the subscription that would produce it. Usually there
isn't one.

## `<Routes location={x}>` already rebinds `useLocation` for the whole subtree

Nearly filed "DocsMode reads `resolvedLocation(...).pathname` but the raw
`useLocation().hash` one line below, so opening a dialog over a fragment link
resets the scroll". It cannot happen: react-router's `useRoutesImpl` wraps the
rendered matches in a `LocationContext.Provider` carrying `locationArg`
(`react-router@8/dist/development/lib/hooks.js:612`), and `ModeRoutes` renders
`<Routes location={resolvedLocation(useLocation())}>`. So _every_ `useLocation()`
inside a mode already returns the background. `resolvedLocation` at a mode's root
is a defensive no-op, and `useOverlay.keep` re-wraps the _mode's_ location rather
than chaining, so it cannot double-unwrap either.

Read the node_modules source before filing a raw-pathname finding inside a mode.
The rule still binds anything rendered _outside_ `ModeRoutes` — the shell bar, the
dock, `App`.

## A "one producer" getter resolves precedence for the _wrong_ consumer

`feat/the-lens` shipped `GameEngine.lens = this.cinematic?.lens ?? this.flightLens`
and handed the same resolved value to every consumer through `lensView()`. The
observatory is the one consumer that must **not** see the cutscene arm: it only ever
produces a camera when the cutscene arm is null, so a lens resolved cutscene-first is
a dependency on an arm the observatory is defined as the fallback for. `focus()`,
`frameTarget()` and `view().fill` are command-driven and therefore reachable while a
cutscene plays. Measured on the branch: `observatory.focus('s:SOL/b:2')` during
`tng-intro` returns 29,761,384 m against 20,779,658 m clean — 43% further, `fill`
0.38 against `DEFAULT_FILL` 0.55 — and it survives `stopCutscene()` because the
distance is stored in `#state`, not recomputed.

**The check, and it generalizes past the lens:** when a single getter collapses a
precedence order, list the consumers and ask which arm each one is _itself_ part of.
An arm reading the resolved value inherits every arm above it. The tell is a docstring
that names the answer it expects — here three of them (`GameEngine.lens`,
`CameraRig.tsx`, ADR-0017 § "One producer, one lens") all say "the observatory solves
against the flight lens" while `AGENTS.md` says it reads `engine.lensView()`. Two
statements of the same order that disagree means one of them is the code.

Reproduction shape that settled it in 30 s: a throwaway `apps/game/src/engine/*.test.ts`
using the `engine()` helper from `gameEngine.test.ts` (inline worker + `MemorySaveStore`),
`viewportPixels` set, `frame()`, then the command with and without `harness.play(...)`.
`ObserverStatus` has no `.distance` — it is `status.state.distance`.

## `JSON.stringify(Infinity)` is `null`, and a persisted preference is JSON

`Lens.focus: Meters` holds `Infinity` by default. `usePersistentState` round-trips
through `JSON.stringify`, so a restored `camera.lens` has `focus: null` — and
`controls.ts`'s `isLens` (`value is Lens`) explicitly admits it. Everything downstream
happens to guard with `Number.isFinite`, so the _values_ are right; the equality
check is not: `CameraPanel.tsx`'s Reset `disabled` compares `camera.lens.focus ===
DEFAULT_LENS.focus`, so clicking Reset and reloading leaves Reset enabled forever.

**The check:** any preference or capture record with an `Infinity`/`NaN`/`-0`/`undefined`
field is not JSON-round-trippable. Grep the persisted shape for those, then grep for
`===` against a constant carrying one. `LensReadout.depthOfField.far` has the same
shape and goes out over CDP.

## The branch's own re-measurement falsifies its own source comments

`TERRAIN-PLAN.md` § 8 predicted `scale²` — "21× the patches at 20°", "263× between
the two ends". The same branch measured 1.9–3.2× (refinement runs out of _levels_ at
`surfaceDetailFloor`, so the square is never spent) and wrote the walkback into
`TERRAIN-PLAN:717`, `ADR-0017:169` and `CONTEXT.md`. The prediction survives verbatim
in `packages/rendering/src/lens.ts:11` and `terrainSelect.ts:70` — and
`terrainSelect.ts` carries the _corrected_ figure 40 lines lower in
`DEFAULT_MAX_PATCHES`, so one file states both.

**The check:** when a plan document gains a "did not survive contact" paragraph, grep
the falsified number across `packages/` and `apps/`. A phase that ships a measurement
updates the plan and the ADR and forgets the module headers that motivated the work.
