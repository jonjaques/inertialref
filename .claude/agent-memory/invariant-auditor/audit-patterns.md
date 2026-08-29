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

Related and unresolved as of `feat/the-geology`: `elevationAt`, and now every exported
band function in `bands.ts`/`craters.ts`/`sketch.ts`, take a bare `Vec3` rather than a
`BodyFixedDirection`. That was already true of `elevationAt` on `main`, so it is not a
regression — but the geology widened the public surface of it by six functions.

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
  (Fixed since: `everyPage(live)` now walks all 129 Sol bodies plus a projected system, so
  any `noData` reason a new group adds is covered automatically. What it still cannot check
  is whether a reason or a value is _true_ — see the geology-card note below.)

## The tree can move under you mid-audit — and it now does so routinely

On the quadtree review the branch gained a commit and four files gained uncommitted edits
while I was reading. It fired again on `perf/the-cost-of-a-sample`, twice: a concurrent session was fixing the very
doc-figure drift I was collecting, so six of my findings evaporated between the grep and the
write-up — and on the geometry-cache audit a `docs:` commit landed **during the audit** that
swept `harness.md`, `TERRAIN-PLAN.md`, ADR-0015 and `CONTEXT.md` and resolved four pending
findings while introducing a fifth. On this repository the docs pass reliably follows the fix
commit by minutes; audit the fix, then `git log` again before writing, and audit the docs
commit too — that is where the overclaimed invariant lands. **Re-run the grep immediately before writing, and `git status` with it.**
On `feat/the-geology` it was worse: a concurrent session **checked the
main working directory out to an older commit and back** mid-run (`git reflog` showed
`checkout: moving from feat/the-geology to c71bac5` and back), which silently poisoned a
main-vs-HEAD comparison — both sides reported `TERRAIN_ALGORITHM` v1.

**The discipline that fixes it, and it costs thirty seconds:** make two detached worktrees
under the scratch dir (`git worktree add --detach <scratch>/mainwt origin/main`, same for
the branch tip by SHA), symlink `node_modules` from the real repo into each, and run every
measurement against those paths. Never measure from the live checkout. Re-run
`git status` / `git log` before writing, and drop findings the working tree already fixes.

**Trap in that setup:** symlinking `node_modules` makes bare specifiers
(`@inertialref/universe`) resolve to the _real repo's_ packages, not the worktree's. Import
by absolute path (`${ROOT}/packages/universe/src/system.ts`) for the module under test, and
verify with a probe that prints something version-shaped (`TERRAIN_ALGORITHM`) before
trusting any cross-revision diff. A module that reaches its siblings by bare specifier
(`terrainZoo.ts`, `World`) cannot be compared this way at all.

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
expression. Additive composites and template strings without separators are the tell.

Fixed on `feat/the-quadtree-covers-the-disk` (`${radius}|${resolution}|${tolerance}`), and
`feat/the-geology` added `sketch.ts`'s `CACHE` on the same pattern — `|`-joined, keyed on
exactly the nine grammar fields `derive` reads, with a FIFO cap. That one is clean.

## A cache layer added in front of another disarms the test for the one behind it

`feat/the-geology` shipped `sketch.ts`'s `CACHE` (string-keyed, `|`-joined, FIFO at 96) with
a test named "derives the same sketch whatever order it is asked in". `perf/the-cost-of-a-sample`
put a `WeakMap<SurfaceParameters, TerrainSketch>` in front of it, and `terrainSketch` returns
from that WeakMap **before `cacheKey` is called**. The test asks the same _object_ twice, so
both its assertions became WeakMap identity lookups and it can no longer see the string cache
at all. Demonstrated: with `CACHE_LIMIT` at 1, the base-branch shape FAILS the assertion and
the two-layer shape PASSES.

**The check:** when a diff adds a fast path in front of existing memoized state, re-read the
test that covers that state and ask whether its inputs reach past the new layer. The fix is
almost always one line — assert on a _fresh object of equal value_ (`{ ...body.surface }`)
alongside the same-object assertion.

Verified separately, and worth not re-reporting: the two-layer cache is value-correct.
2,000 `elevationAt` samples over five bodies, interleaved and flushed with 129 other bodies
every 40 steps, are bitwise identical to a sequential run. Eviction can split _object
identity_ (two equal surfaces get two distinct `TerrainSketch` objects after 96 derivations)
and nothing in the tree compares sketch identity, so that is currently harmless.

## A retired figure comes back inside _new_ prose, not in the text that was left alone

The usual restated-figure drift is old text nobody updated. This one is the inverse and it is
harder to grep for: `surfaceDetailFloor`'s "13–17" was corrected to "12–16" across the tree on
`feat/the-geology`, and `perf/the-cost-of-a-sample` wrote **"between thirteen and seventeen"
into a freshly authored comment** in `terrainSelect.ts` — 440 lines below the same file's own
"level 12 to 16" — and into a new `CONTEXT.md` entry that reports the measured floors as
(12, 13, 15, 16) eighty lines later.

**The check:** grep the _retired_ literal against the diff's **added** lines, not against the
whole tree. `git diff base...HEAD | rg '^\+' | rg '<retired figure>'`.

Corollary on the same branch: the perf figures moved 20/37 -> 9/60 and the docs pass caught
`README.md`, `docs/roadmap.md`, `docs/design/technical.md`, `docs/agents/driving.md`,
`docs/concepts/streaming.md` and `TERRAIN-PLAN.md` — and missed the three sites that are not
under `docs/`: `apps/game/src/engine/terrainStreamer.ts` (twice, one of them the stated
justification for `PREFETCH_SECONDS`), `docs/adr/0015` and `packages/universe/src/sketch.ts`
(where the stale number sits inside the paragraph the same commit rewrote). **A docs pass
sweeps `docs/`; the misses are always in `apps/` and `packages/`.**

## The rank-seam class now has three sites and no `AGENTS.md` bullet

"Read a field value off a thing chosen by rank and you inherit a seam wherever the ranking
changes." `craters.ts` (the cube-face corner, ring walk counts a neighbor twice),
`bands.ts` (the boundary blend, 9,433.9 m on Proxima Centauri II) and `sketch.ts` (the
interior seam where second- and third-nearest plates are equidistant, 1,532 m Proxima /
3,081 m Earth). The precedent for promotion is `AGENTS.md`'s own `renderTime` bullet: "Three
sites have now had to learn this ... and nothing mechanical catches a fourth, so it is a rule
rather than three comments." Nothing in `AGENTS.md`, `.claude/rules/determinism.md` or
`docs/agents/invariants.md` states it. Recommend it every time this area is touched until it
lands.

## Running `packages/universe` standalone from a worktree is cheap and settles most claims

`node --experimental-strip-types` runs the sources directly. Absolute imports of
`packages/universe/src/{terrain,system,galaxy,grammar,sketch,craters,bands}.ts` +
`catalog/fixture.ts` (`TEST_CATALOG`, **not** `testCatalog.ts`) reproduces the test
fixtures in about fifteen lines. `generateSystem(rootSeed('inertialref'), MILKY_WAY,
catalogStub(TEST_CATALOG.stars[0]))` is Sol; `walkBodies` gives all 129. `MILKY_WAY` and
`catalogStub` live in `galaxy.ts`, not `address.ts`. `new World({ seed, catalog })` — the
seed is required and its absence throws inside `hashString`.

**The single most valuable thing this buys is a whole-galaxy diff.** Dump every body of
every star in `TEST_CATALOG` as JSON with the fields under test stripped recursively, run
it against both worktrees, and compare. On `feat/the-geology` that settled the whole
`SYSTEM_ALGORITHM`-does-not-move claim in one command: 192 bodies, byte-identical except
`surface.maxElevation` and its restatement `appearance.relief`. Strip **recursively** —
`Body.moons` carries nested surfaces and a top-level `delete` leaves them in.

Trap: `rg -rn` is `--replace n`, not "recursive with line numbers". Use `rg -n`.

## "Ready" predicates that test a different cache than the one the drawer reads

`terrainSelect`'s `ready` is documented as the thing that prevents holes: refine only into
regions that are drawable. The streamer answered it with `#fields.has(key)` — the
_heightfield_ cache — while `state()` skips any region whose `RenderPatch` has not been
built. Measured on a landing: 204 selected / 104 built at frame 40.

**The check, and it generalizes:** when a predicate names a precondition ("it is drawable",
"it is loaded", "it is ready"), find the code that actually _consumes_ the thing and confirm
it reads the same map.

## An ordering argument in a docstring, with no sort in the code

`#request`'s comment says "coarsest first and then nearest … a stable sort keeps that
grouping". There is no sort — it filters and slices. Comments that _argue_ for a property
are where to look, not comments that state one.

## A comment claims a coverage guarantee the arithmetic does not provide

The geology's crater band is the worked example, and the shape generalizes to every
lattice/neighborhood walk. `craters.ts` and `sketch.ts` both assert "a sample's 3×3×3
neighborhood is guaranteed to contain every crater whose support reaches it". Cell size in
direction space is `1/cells = diameter/meanRadius`; a crater's angular radius is
`diameter/(2R)` = half a cell; `EJECTA_REACH = 2.6` radii is therefore **1.3 cells**, so a
crater two cells away can still reach the sample. The guarantee needs reach ≤ 1 cell or a
5×5×5 walk.

**The check:** when a comment says "guaranteed to contain", write the support radius and
the cell width in the same units and divide. It is two lines of arithmetic and it is
almost never done by the author.

## Profile/falloff primitives: check every branch boundary, not just the outer one

`profile.ts` opens with "Every one is C1 at both ends … a feature whose _value_ does not
reach zero draws a step at it. Both survive into the normals." `craters.ts`'s
`craterProfile` then guards the ejecta apron with `if (t > 1)` and evaluates
`(1/t³)·(1 − smoothstep(1.8, 2.6, t))`, which is **1 at t = 1⁺ and absent at t = 1⁻** — a
C0 step of `0.12·depth·rimLife·(0.6 + 0.8·typeDraw)` at the rim of every crater on every
body. Measured on Luna: two adjacent doubles apart in direction, `elevationAt` differs by
1,040 m; the same scan finds 896 m on Mercury, 873 on Iapetus, 442 on Callisto — every one
inside the predicted `[0.072, 0.168]·depth` band of that body's largest crater.

**The check that found it, and it is generic and fast:** walk a great-circle arc in
~400,000 steps, record `max |Δ|` between adjacent samples, and compare it to the p99.9.
A ratio above ~5 is a discontinuity, not terrain. Then bisect between the two samples: if
the gap survives down to adjacent doubles it is a real C0 step, and printing which lattice
cell indices moved tells you whether it is the window or the profile. The author's own
continuity test ("crosses a cube-face corner without a step in it") compares two walks of
_different arc length_ under a factor-of-three bound and cannot see any of this.

## A normalization that ignores the thing it is normalizing

`field.ts`'s `fbmField`/`ridgedField` accumulate `value += amplitude · damp · n` but
`norm += amplitude` — the damping is left out of the divisor. For `fbmField` that is a
symmetric amplitude loss. For `ridgedField` the `(value/norm)·2 − 1` remap turns it into a
**DC offset**: measured mean +0.265 undamped (matching v1 `ridged3`'s +0.255) against
−0.890 at damping 6 and −0.965 at damping 24. The docstring says the two are
"interchangeable as band inputs and an amplitude tuned against one reads the same against
the other", which is true only in the case the function does not exist for.

Downstream, `beltBand`'s stagnant-lid branch `(1 − ranges)³·2 − 0.1` amplifies it: on Mars
the band's mean is 1.599 (σ 0.21) and 97.5% of samples exceed the stated `[-1, 1]`; on
Venus 1.795 and 99.6%. That is a 3,064 m / 2,625 m uniform pedestal, and it also falsifies
the ADR's "the shares sum to one, so no band can grow past its allowance".

**The check:** for any new normalized accumulator, ask whether every factor applied to the
numerator is applied to the denominator, then measure the **mean** over a few thousand
directions — not the range. A DC offset is invisible in a min/max and obvious in a mean.
Do it for each value the caller can pass, not just the default.

## A fix pass's residue: the _guard_ is fixed, the _reader_ is not

The highest-yield check on a "fifteen findings from the review" commit is not whether
each fix works — they usually do — but whether the fix reaches every consumer of the
thing it fixed. Two shapes from `feat/the-quadtree-covers-the-disk`: a widened effect
dependency with the render-time guard still on the narrow key, and a local snapshot taken
before an invalidating call.

## A cap sized from one selection when the keep set is the union of two

The streamer's recurring defect, now three times: `GEOMETRY_CACHE` was
`DEFAULT_MAX_PATCHES + 128` "because only drawn patches get geometry", while
`#evict` keeps `drawn ∪ starvedChildren ∪ pyramid(wanted)` — and `wanted` is a
_second_ `selectTerrain` call at the look-ahead eye. `#evict` cannot delete a
keep-set member, so a cap below `|keep|` does not bound the map: it pins
residency at the keep set and makes every non-keep mesh a victim every frame.

`perf/the-cost-of-a-sample` fixed the number (`* 2`) and then, in the follow-up
docs commit, wrote a **stronger claim than the fix supports**: "`selectTerrain`
caps the selection, so the keep set is bounded by `DEFAULT_MAX_PATCHES` and not
by the viewport — measured 1,232 to 1,327 at both 3840×2400 and 5120×2880"
(ADR-0015 Consequences, `CONTEXT.md`). Measured against the shipped code, on one
body at one stance, the keep set moves with the viewport in every row: Ganymede
at 2 km altitude with a 1 km look-ahead is **1,084 / 1,349 / 1,625** at
1600×900 / 3840×2400 / 5120×2880. Invariance only appears when the camera is
_stationary_ (the look-ahead collapses, drawn == wanted) or when
`surfaceDetailFloor` binds before `maxPatches` does. The real ceiling is
`|drawn| + 4·|starved| + |pyramid(wanted)|` ≈ 2.35× the selection cap, not 1.33×.

**The probe that settles it, ~40 lines and reusable.** Reimplement the streamer's
private `pyramid` (it walks `regionParent`), then for each body call
`selectTerrain` twice — once at `direction`, once at a direction offset by
`lead / body.radius` — and size the union of `drawn.patches`,
`regionChildren(starved)` and `pyramid(wanted.patches)`. Sweep viewport ×
look-ahead lead (`PREFETCH_SECONDS` is 2, so 1 km of lead is 500 m/s). Any claim
of the form "X does not depend on the viewport" is one table away from being
settled, and the author's version of the table was taken at a hover.

## A regression bound written from the theoretical floor, not the measurement

Same branch: `gameEngine.test.ts` asserts `GEOMETRY_CACHE > (DEFAULT_MAX_PATCHES

- 4. / 3`= 1,365 — the *floor* the docstring itself says holds "before the
starved rung is counted".`DEFAULT_MAX_PATCHES * 1.5` = 1,536 passes that
     assertion and still sits under the measured keep set of 1,625 at 5120×2880, so
     the test admits the whole range [1,366, ~1,860] that reproduces the shipped
     strobe. When a fix's own commit body quotes measurements (1,597 and 1,713
     resident), the assertion should be pinned to the largest of them, per CLAUDE.md's
     "name the limit in the assertion".

## "One constant instead of two that must agree" usually leaves a smaller twin

`GEOMETRY_KEPT = GEOMETRY_CACHE` is right, but `descent.ts`'s `DEFAULT_CACHE =
DEFAULT_MAX_PATCHES * 3` restates the streamer's `FIELD_CACHE`. And the _test_ keeps the
retired number — grep the retired literal across tests, not just source.

`feat/the-geology` reintroduced the shape twice: `terrainRig.test.ts` asserts
`peakDrawn < 1_024` where 1,024 _is_ `DEFAULT_MAX_PATCHES` spelled as a literal (so the
test can no longer say anything the cap does not), and `terrainStreamer.ts` states the
per-patch cost as "24 to 44 ms" in one comment and "20 to 37 ms" in another, forty lines
apart in the same file.

## A new gate in the code is a new branch in the docs' flowchart

`terrainStreamer.#resolve` gained `&& body.figure === null` and
`docs/concepts/streaming.md`'s Mermaid gate node still read `"a solid body, relief over
8 px?"`. Mermaid node labels are prose nobody greps.

## Count words in doc headers drift on every row added

`docs/adr/README.md:3` opens "Eighteen decisions" over a table the diff just gave a
nineteenth row. `README.md:375` says "Seventeen". Nothing greps these.
`rg -n 'One|Two|…|Twenty'` over the touched markdown is enough.

## A measured figure gets restated in five places and corrected in one

The geology's headline numbers each live in a docstring, an ADR paragraph, `CONTEXT.md`'s
before/after table and one or two module headers. When the measurement is later refined,
the ADR and `CONTEXT.md` get the new number and the **code comments do not**:
`surfaceDetailFloor` "13–16" was corrected to "13–17" in `ADR-0019`, `CONTEXT.md` and
`docs/concepts/streaming.md` while `terrainStreamer.ts`, `terrainSelect.ts` (twice) and
`terrainRig.test.ts` kept the old range.

**The check:** for every distinctive number the diff introduces, `rg` the literal across
`docs/`, `packages/`, `apps/`, `README.md` and `CONTEXT.md` and count the sites. Then
re-measure it yourself — on this branch, Earth's atmospheric column is quoted as
"10,200 kg/m² against a measured 10,330" in three places and the code computes
`1.217 × 8500 = 10,344.5`, which is _above_ the measured value rather than below it; and
`grammar.ts:328` says "Mars comes out at 0.30" where `mobility` is 0.092, because the
prose was written with the `hasOcean ? 1 : 0.3` factor at 1.

## A comment's _reason_ can be false while its code is right

`useDocsFraming.ts` destructures `framing` "because the manifest hands back a fresh
`framing` on every render … eight times a second". Neither half is true. The destructuring
is still the right call. A comment that cites a cadence (`8 Hz`, `every render`, `every
frame`) is arithmetic — find the subscription that would produce it.

## `<Routes location={x}>` already rebinds `useLocation` for the whole subtree

react-router's `useRoutesImpl` wraps the rendered matches in a `LocationContext.Provider`
carrying `locationArg`, and `ModeRoutes` renders `<Routes location={resolvedLocation(...)}>`.
So every `useLocation()` inside a mode already returns the background. Read the
node_modules source before filing a raw-pathname finding inside a mode.

## A "one producer" getter resolves precedence for the _wrong_ consumer

`GameEngine.lens = this.cinematic?.lens ?? this.flightLens` hands every consumer a
cutscene-first value, including the observatory, which is defined as the arm that only
runs when the cutscene arm is null. Measured: `observatory.focus('s:SOL/b:2')` during
`tng-intro` returns 29,761,384 m against 20,779,658 m clean. **When a single getter
collapses a precedence order, list the consumers and ask which arm each one is part of.**

## `JSON.stringify(Infinity)` is `null`, and a persisted preference is JSON

`Lens.focus: Meters` holds `Infinity` by default; `usePersistentState` round-trips through
JSON. Values survived by luck (`Number.isFinite` guards); the `===` against the constant
did not. Resolved by `revive: reviveLens`.

## The branch's own re-measurement falsifies its own source comments

`TERRAIN-PLAN.md` § 8 predicted `scale²`; the same branch measured 1.9–3.2× and wrote the
walkback into the plan, the ADR and `CONTEXT.md`. The prediction survives verbatim in
`packages/rendering/src/lens.ts:11` and `terrainSelect.ts:70`.

## A new host port that writes a value React already owns

`HarnessHost.setFlightLens` writes `engine.flightLens` directly while the field's owner is
`usePersistentState(CAMERA_LENS)` in `App`. **Find who else writes the field. If one of
them is React state, the port needs to go through the React setter.**

## `viewport` in this repo is _device_ pixels; pointer deltas are CSS pixels

`pixelAngle(lens, viewport)` is radians per _device_ pixel. Anything multiplying it by a
pointer delta is off by the DPR. `Observatory.dragSensitivity()` does exactly this.

## The mirror drift fired a third time, in its usual direction

Phase 1.6 added `chrome` and `labels` to `Stance` and left the presentation-switch bullet
enumerating the previous five. **Amending is what gets missed, every time.** Diff the type
definition, not the prose.

## A new "provable by grep" claim in an ADR is a grep you should run

ADR-0018's "no key name written as a string literal in a label" is violated by
`hud/CutsceneTransport.tsx:45`, a file not in the diff. **Run the ADR's own grep over the
whole tree, not the changed files.**

## Untested because the test host declines the port

`observatory.test.ts`'s `harness()` calls `openSession` with no `host`, so `framingLens`,
`lensView` and `setFlightLens` are all undefined. **When a verb's behavior is gated on an
optional host port, look at what the test session passes for `host`.**

## The dossier can state a generated number as a measured fact

ADR-0014's rules are about missing rows and the _voice_ of a reason, and `dossier.test.ts`
says outright that it cannot check whether a value is true. `feat/the-geology`'s geology
card is built identically for `provenance: 'observed'` bodies, so Earth's page reads
"Lithosphere: 22 plates" (Earth has 7–8 major) and "largest basin 418 km across"
(Vredefort is ~300 km) with no marker distinguishing the derived rows from the archived
ones. **When a new `FactGroup` derives its values from the generator, check what it says on
Sol's mapped bodies, not on a projected one.**

## Resolved on earlier branches — do not re-report

- `Observatory.stand` guards `focus` on `wanted.address !== this.#target?.address`.
- `CAMERA_LENS` gained `revive: reviveLens`; the Reset-stays-enabled bug is gone.
- The `surfaceDetailFloor` memo key is `|`-separated, and `universe.test.ts`'s
  order-independence test was re-armed with `(33, 32.5)` after `(64, 1.5)` stopped
  producing a different answer.
