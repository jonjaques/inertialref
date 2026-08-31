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

## The sketch cache key must list every grammar field `derive` reads — and it drifts

**Highest-yield determinism check on any diff that touches `sketch.ts`'s `derive`.**
`cacheKey` is nine `|`-joined grammar fields plus the seed, with a docstring claiming it
is "keyed by what the derivation reads". Every phase that adds a term to `derive` risks
adding a tenth read without a tenth key field.

Confirmed on `feat/the-ground`: `microLadder` → `microCraterDensity(grammar)` reads
`grammar.air`, which is **not** in the key. Reproduction, two lines:
`terrainSketch({...luna.surface, grammar: {...g, air: 1}})` returns `microLevels.length === 4`
(the airless tail) because Luna's real surface was derived first; asked in the other order
it returns `[]`. Latent in production only because the seed is in the key and bodies have
distinct seeds — but it is order-dependence in canonical-adjacent generation and one word
to fix.

**Mechanical check:** `grep 'grammar\.' ` inside `derive` and every function it calls
(`craterLadder`, `microLadder`, `rayCraters`, …), and diff that set against the `cacheKey`
array.

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

## `BodyFixedDirection` producers keep multiplying outside the three `AGENTS.md` names

The invariant enumerates three (`bodyFixedDirection`, `geodeticDirection`,
`regionDirection`) and the enumeration _is_ the enforcement. Known extras:
`terrain.ts`'s `faceToDirection`; `flight.ts:298`'s `as BodyFixedDirection`; and now
`apps/game/src/engine/scatterField.ts:180`, `Vec.normalize(eyeLocal) as ScatterEye['direction']`
— the first one in `apps/`. Each is semantically correct and each widens the surface the
enumeration is supposed to close. Also unresolved: `elevationAt`, `drawnElevation` and
every exported band function take a bare `Vec3`.

## Design docs carry "Not built" tables that the diff silently falsifies

`docs/design/planetarium.md` § "Not built" still lists "Surface-level free look — the
observatory's floor is the datum sphere" after the branch that built it. `docs/design/`
is cited by name from `AGENTS.md` invariants, so it is not optional prose. Cheap check:
grep the design doc the touched invariant cites for the feature name.

## The mirror goes stale in one direction: AGENTS.md forward, rules back

This is now the highest-yield check in the whole audit and it has fired three times.

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
**Process** rules (`branching`, `writing`) sit outside it deliberately. The `.cursor/rules`
adapters `@`-reference the canonical `.claude/rules` file, so a new bullet needs no glob
change — but see the next section for the failure that replaced this one.

## A new rule lands in the wrong path scope for the files that make the mistake

The mirror-drift failure has mutated. `feat/the-ground` put the canonical/drawn ground
invariant in `.claude/rules/determinism.md`, whose `paths:` are
`packages/{simulation,procedural,universe,spatial,physics}/**` — and **every file in the
diff that actually had to choose between `surfaceRadius` and `drawnSurfaceRadius` is
outside it**: `packages/devtools/src/observatory.ts`, `packages/devtools/src/descent.ts`,
`apps/game/src/engine/scatterField.ts`, `packages/rendering/**`. The rendering rule covers
those paths and carries only the _other_ new bullet.

**The check, and it is one command:** take the files the diff changed to satisfy the new
invariant, and confirm each is matched by the `paths:` of the rule that states it.

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
On `feat/the-ground` the docs pass ran _concurrently and uncommitted_: eight `docs/` files
plus `README.md` went from clean to modified during the audit. Grep the **working tree**
for a figure you are about to call stale — it may already be being rewritten, and the
uncommitted prose is worth auditing too (it repeated the same retired `1.6 m`).

**The discipline that fixes it, and it costs thirty seconds:** the cheapest safe way to get
a second revision is `git archive origin/main | tar -x -C <scratch>/mainwt` — it touches no
git metadata at all, unlike `git worktree add`, so a concurrent session cannot be disturbed.
Symlink `node_modules` from the real repo into it and import the modules under test by
absolute path. Re-run `git status` / `git log` before writing, and drop findings the working
tree already fixes.

**Trap in that setup:** symlinking `node_modules` makes bare specifiers
(`@inertialref/universe`) resolve to the _real repo's_ packages, not the copy's. Import
by absolute path (`${ROOT}/packages/universe/src/system.ts`) for the module under test, and
verify with a probe that prints something version-shaped before trusting any cross-revision
diff. A module that reaches its siblings by bare specifier cannot be compared this way at all.

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
`feat/the-geology` added `sketch.ts`'s `CACHE` on the same pattern — `|`-joined, with a FIFO
cap. The separator is fine; what drifts is _which fields are in it_ — see the `air` section
at the top.

## A memo key that omits the _eye_ while the memoized build reads it

`feat/the-ground`'s `ScatterField` rebuilds instance matrices only when
`${home}|${range}|${readyRegions}` changes — but `#build` culls each rock against
`eyeLocal` (a 212 m range test and a two-pixel test) and sorts nearest-first for the
`MAX_ROCKS` truncation. Measured on Luna at a 2 m stance: moving 25 m tangentially leaves
the region set identical while **81 rocks should have entered and 79 should have left** of
1,050 drawn. The docstring only argues the standing case ("a standing camera crosses no
region"), which is true and is not the code's actual predicate.

**Generic form of the check:** list every input the memoized function _reads_, then diff
that list against the signature string. A comment that justifies a cache by describing one
motion state is where to look.

## A cache layer added in front of another disarms the test for the one behind it

`feat/the-geology` shipped `sketch.ts`'s `CACHE` (string-keyed, `|`-joined, FIFO at 96) with
a test named "derives the same sketch whatever order it is asked in". `perf/the-cost-of-a-sample`
put a `WeakMap<SurfaceParameters, TerrainSketch>` in front of it, and `terrainSketch` returns
from that WeakMap **before `cacheKey` is called**. The test asks the same _object_ twice, so
both its assertions became WeakMap identity lookups and it can no longer see the string cache
at all.

This keeps recurring in _new_ tests too: `feat/the-ground`'s
`scatter.test.ts` "answers the same whichever order the regions are asked for" passes the
same `LUNA.surface` object on both passes and churns only 8 derivations against a 96-entry
cap — so it reaches neither the string cache nor its eviction, and it could not have caught
the `air` key gap in the same commit.

**The check:** when a diff adds a fast path in front of existing memoized state, re-read the
test that covers that state and ask whether its inputs reach past the new layer. The fix is
almost always one line — assert on a _fresh object of equal value_ (`{ ...body.surface }`)
alongside the same-object assertion.

Verified separately, and worth not re-reporting: the two-layer cache is value-correct.
2,000 `elevationAt` samples over five bodies, interleaved and flushed with 129 other bodies
every 40 steps, are bitwise identical to a sequential run.

## The retired figure is now usually the _constant_, and the prose keeps arguing the old one

The classic shape is stale text nobody updated. `feat/the-ground` inverted it and it is the
richest single finding on that branch: `MICRO_CRATER_CEILING` was **halved from 1.6 to 0.8**
after a visual pass (`CONTEXT.md` says so outright — "the first attempt was 1.6 m of ceiling
and drew as broken glass at 21°"), and the constant's own docstring still reads "A fifth of
`CANONICAL_DETAIL_FLOOR`" — which is 1.6 — while four other sites (`terrain.ts` ×2,
`terrainSelect.ts`, `TERRAIN-PLAN.md`, and `CONTEXT.md` two paragraphs above its own
correction) argue the phase from "an eight-meter crater is 1.6 m deep". Measured deepest
sub-floor cut: 0.799 m. Only ADR-0021 states both halves correctly.

**The check, and it is cheap:** for every new constant whose docstring contains arithmetic
("a fifth of X", "half of Y"), _evaluate the arithmetic against the shipped value_. When it
disagrees, grep the derived literal across the tree — it will be in three to five places.
Then check `CONTEXT.md` for a sentence admitting the change; that is where the true story is.

Same branch, same shape, smaller: the tail's headline effect is quoted as "two to three
levels" in three places while the branch's own zoo table is 15→19, 16→17, 12→14, 10→12
(one to four), and across Sol it runs 0 to +10 (Europa 6→16).

## Count words and index tables in doc headers drift on every row added

`docs/adr/README.md:3` opens "Twenty decisions" and `README.md:380` repeats it — and
`feat/the-ground` added ADR-0021 with **no table row and no Mermaid node** in
`docs/adr/README.md` at all, only the `scripts/docs/wings.mjs` entry. Both count words and
the index table itself are worth checking on any diff that adds an ADR; nothing greps them.

## A measured figure gets restated in five places and corrected in one

The geology's headline numbers each live in a docstring, an ADR paragraph, `CONTEXT.md`'s
before/after table and one or two module headers. When the measurement is later refined,
the ADR and `CONTEXT.md` get the new number and the **code comments do not**.

**The check:** for every distinctive number the diff introduces, `rg` the literal across
`docs/`, `packages/`, `apps/`, `README.md` and `CONTEXT.md` and count the sites. Then
re-measure it yourself. On `feat/the-ground` three separate figures failed this:
`drawnDivergence` is "about two meters" in two comments against a published 1.25 m;
a patch's memory is "220 KB / 282 MB" in `terrainSelect.ts` where a patch carries **two**
4-byte cover attributes (237 KB / 303 MB, which `docs/roadmap.md` gets right in the same
diff); and a scatter region is "167 m across on Luna" twice, where `scatterLevel(1737400)`
is 13 and `regionSize` is 333 m — the 167 comes from the _test's_ `LEVEL = 14` fixture,
which is one level finer than production.

**Corollary worth its own line: when a docstring's number matches a test fixture and not
the code, the test fixture is the bug.**

## A comment claims a coverage guarantee the arithmetic does not provide

The geology's crater band is the worked example, and the shape generalizes to every
lattice/neighborhood walk. `craters.ts` and `sketch.ts` both assert "a sample's 3×3×3
neighborhood is guaranteed to contain every crater whose support reaches it". Cell size in
direction space is `1/cells = diameter/meanRadius`; a crater's angular radius is
`diameter/(2R)` = half a cell; `EJECTA_REACH = 2.6` radii is therefore **1.3 cells**, so a
crater two cells away can still reach the sample. The guarantee needs reach ≤ 1 cell or a
5×5×5 walk. (Still open; `feat/the-ground` inherits it four rungs deeper.)

**The check:** when a comment says "guaranteed to contain", write the support radius and
the cell width in the same units and divide.

## An octave/rung count derived from a ratio is almost always off by one

`GRIT_OCTAVES = ceil(log(CANONICAL_DETAIL_FLOOR / GRIT_FLOOR) / log(2.03))` = 2, and
`fbm3` runs frequencies `f·λ^0 … f·λ^(N−1)` — so two octaves reach 8/2.03 = **3.94 m**, not
the `GRIT_FLOOR = 2` m the constant is named for and whose docstring reasons at length
about why the 1 m octave is excluded. It needs `+ 1`. The irony worth remembering: the
docstring warns that "an octave count derived against the wrong lacunarity lands short"
while landing short for a different reason.

**The check:** write out the actual frequency list for the shipped count and compare its
last entry to the floor the constant claims.

## Profile/falloff primitives: check every branch boundary, not just the outer one

`craterProfile`'s `if (t > 1)` ejecta apron was the first (fixed since, by
`smoothstep(1, RIM_OUTER, t)`); `rayBrightness`'s `if (t > 1.2)` was the second.
The scan that finds them: walk a great circle in ~400,000 steps with an _exact_ rotation
(`axis·cos θ + u·sin θ`, never a normalized offset), record `max |Δ|` between adjacent
samples, and compare to the p99.9. A ratio above ~5 is a discontinuity. Then bisect: if the
gap survives to adjacent doubles it is a real C0 step.

Run clean on `feat/the-ground`'s `microRelief`: 400k samples at 10 cm of ground over five
bodies, max/p99.9 ratio 1.5–1.7, every bisected gap 0. The tail introduces no step. Note the
branch's own continuity test walks a **non-unit** circle (`vec3(cos·0.95, 0.31, sin·0.95)`)
at 0.5 m sampling, which could not have seen one anyway.

## A normalization that ignores the thing it is normalizing

`field.ts`'s `fbmField`/`ridgedField` accumulate `value += amplitude · damp · n` but
`norm += amplitude` — the damping is left out of the divisor. For `ridgedField` the
`(value/norm)·2 − 1` remap turns it into a **DC offset**: measured mean +0.265 undamped
against −0.890 at damping 6 and −0.965 at damping 24.

**The check:** for any new normalized accumulator, ask whether every factor applied to the
numerator is applied to the denominator, then measure the **mean** over a few thousand
directions — not the range. A DC offset is invisible in a min/max and obvious in a mean.

## A fix pass's residue: the _guard_ is fixed, the _reader_ is not

The highest-yield check on a "fifteen findings from the review" commit is not whether
each fix works — they usually do — but whether the fix reaches every consumer of the
thing it fixed. Two shapes from `feat/the-quadtree-covers-the-disk`: a widened effect
dependency with the render-time guard still on the narrow key, and a local snapshot taken
before an invalidating call.

## A cap sized from one selection when the keep set is the union of two

The streamer's recurring defect: `GEOMETRY_CACHE` was `DEFAULT_MAX_PATCHES + 128`
"because only drawn patches get geometry", while `#evict` keeps
`drawn ∪ starvedChildren ∪ pyramid(wanted)` — and `wanted` is a _second_ `selectTerrain`
call at the look-ahead eye. A cap below `|keep|` pins residency at the keep set and makes
every non-keep mesh a victim every frame. Fixed to `* 2` on `feat/the-ground`'s base.

Any claim of the form "X does not depend on the viewport" is one table away from being
settled, and the author's version of the table is usually taken at a hover.

## A regression bound written from the theoretical floor, not the measurement

`gameEngine.test.ts` asserts `GEOMETRY_CACHE > (DEFAULT_MAX_PATCHES * 4)/3` = 1,365 — the
_floor_ the docstring itself says holds "before the starved rung is counted". When a fix's
own commit body quotes measurements, the assertion should be pinned to the largest of them,
per CLAUDE.md's "name the limit in the assertion".

## "One constant instead of two that must agree" usually leaves a smaller twin

`GEOMETRY_KEPT = GEOMETRY_CACHE` is right, but `descent.ts`'s `DEFAULT_CACHE` restates the
streamer's `FIELD_CACHE`. And the _test_ keeps the retired number — grep the retired
literal across tests, not just source. `feat/the-ground` added
`ScatterRocks.tsx`'s `INSTANCE_CAPACITY = 4_000`, a hand-copied twin of `scatterField.ts`'s
un-exported `MAX_ROCKS = 4_000`, with a docstring that names the other constant.

## A new gate in the code is a new branch in the docs' flowchart

`terrainStreamer.#resolve` gained `&& body.figure === null` and
`docs/concepts/streaming.md`'s Mermaid gate node still read `"a solid body, relief over
8 px?"`. Mermaid node labels are prose nobody greps.

## A comment's _reason_ can be false while its code is right

`useDocsFraming.ts` destructures `framing` "because the manifest hands back a fresh
`framing` on every render … eight times a second". Neither half is true. A comment that
cites a cadence (`8 Hz`, `every render`, `every frame`) is arithmetic — find the
subscription that would produce it.

The invariant version of this: `AGENTS.md`'s new "never give two attribute names one
`BufferAttribute` object" states the mechanism universally ("the pipeline does not build"),
while `ScatterRocks.tsx`'s own isolation note says the _instanced_ pair was left aliased
"which builds — it is the vertex-rate attributes that collide". The rule is a fine
defensive superset; its stated mechanism contradicts the author's own evidence.

## `<Routes location={x}>` already rebinds `useLocation` for the whole subtree

react-router's `useRoutesImpl` wraps the rendered matches in a `LocationContext.Provider`
carrying `locationArg`, and `ModeRoutes` renders `<Routes location={resolvedLocation(...)}>`.
So every `useLocation()` inside a mode already returns the background. Read the
node_modules source before filing a raw-pathname finding inside a mode.

## Read `node_modules/three` before filing a TSL semantics finding

Twice now the suspicion was wrong and thirty seconds of reading settled it. TSL `mod` is
`OperatorNode('%')`, and for float operands the WGSL backend emits
`tsl_mod_vec3(x, y) = x - y * floor(x / y)` — **floor-based, so it is non-negative for a
positive modulus** and a periodic-noise wrap survives negative coordinates. Version pinned
at `three@0.182.0` under `node_modules/.pnpm/`.

## A "one producer" getter resolves precedence for the _wrong_ consumer

`GameEngine.lens = this.cinematic?.lens ?? this.flightLens` hands every consumer a
cutscene-first value, including the observatory, which is defined as the arm that only
runs when the cutscene arm is null. Measured: `observatory.focus('s:SOL/b:2')` during
`tng-intro` returns 29,761,384 m against 20,779,658 m clean.

## `JSON.stringify(Infinity)` is `null`, and a persisted preference is JSON

`Lens.focus: Meters` holds `Infinity` by default; `usePersistentState` round-trips through
JSON. Resolved by `revive: reviveLens`.

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

## A new "provable by grep" claim in an ADR is a grep you should run

ADR-0018's "no key name written as a string literal in a label" is violated by
`hud/CutsceneTransport.tsx:45`, a file not in the diff. **Run the ADR's own grep over the
whole tree, not the changed files.**

## Untested because the test host declines the port

`observatory.test.ts`'s `harness()` calls `openSession` with no `host`, so `framingLens`,
`lensView` and `setFlightLens` are all undefined. **When a verb's behavior is gated on an
optional host port, look at what the test session passes for `host`.**

## The dossier can state a generated number as a measured fact

`feat/the-geology`'s geology card is built identically for `provenance: 'observed'` bodies,
so Earth's page reads "Lithosphere: 22 plates" (Earth has 7–8 major) with no marker
distinguishing derived rows from archived ones. **When a new `FactGroup` derives its values
from the generator, check what it says on Sol's mapped bodies.**

## Worked examples in cover/palette prose are not checked against the generator

`cover.ts`'s `iceCover` says "Europa is ice at the equator at noon". Measured: Europa's
`grammar.icy` is **0.00** in this generator. The author's own test quietly uses Callisto.
**Check every body named in a new field's prose by running it through the generator once.**
Same class on `feat/the-ground`: the "zero where a body has neither tail nor grit" case in
`microReliefBound` is unreachable, because `gritRelief = 0.45 · (1 − 0.35 · air)` bottoms
out at 0.29 and `air` is capped at 1.

## `viewport` on `LensView` is display pixels, so the buffer ratio is a _reciprocal_

`TerrainPatches` computes `supersample = state.lens.viewport.height / gl.domElement.height`,
which is 1/`engine.supersample`. The arithmetic is right; the local shares a name with the
engine field that holds its reciprocal.

## Cheap things that came back clean on `feat/the-ground`, worth not re-deriving

- `elevationAt` is **bit-identical to `origin/main`**: 2,640 samples over all 22 solid Sol
  bodies, zero mismatches. The `ChordForm` default (`'fast'`) and `ladderField`'s
  `firstIndex + rung` with `firstIndex = 0` reproduce the old walk exactly.
- The published `drawnDivergence` bound holds: max |drawn − canonical| over 3,000 directions
  is 1.02 m on Enceladus against a bound of 1.25 m. Mean is −0.30 m on airless bodies (the
  tail is net-negative, as craters cut down) and 0.00 on Venus.
- No C0 step in `microRelief` (see the profile section above).
- The grain band's domain really is continuous across a patch/rock boundary: `grainWrap` is
  floor-based on the CPU, TSL `mod` is floor-based in WGSL, and every octave `i` wraps at
  `GRAIN_PERIOD · 2ⁱ` in its own scaled domain, so a shift of 64 wavelengths is exact.
- Rocks wear the terrain material and the morph collapses correctly: `morphBand` is
  `(NO_MORPH_DISTANCE, NO_MORPH_DISTANCE)`, so `k = saturate(d − NO_MORPH) = 0` and all three
  mixes are the identity. All five `onObjectUpdate` uniforms are set in `ScatterRocks`.
- `regionScatter` is genuinely order-independent: `pcg4d` per slot, half-open slice ranges,
  no counter, no shared stream.
- `pnpm graph` clean; no `three` in `packages/*`; no bare `three` in `apps/game`; no
  `Math.random`/`Date.now`/`performance.now`/`localStorage` added; no `text-slate-500`.
- `stateHash`, saves, `surveySites` and `installSurfaceFrame` all still read the canonical
  field; `TerrainSketch` is derived and never persisted.

## Resolved on earlier branches — do not re-report

- `Observatory.stand` guards `focus` on `wanted.address !== this.#target?.address`.
- `CAMERA_LENS` gained `revive: reviveLens`; the Reset-stays-enabled bug is gone.
- The `surfaceDetailFloor` memo key is `|`-separated, and `universe.test.ts`'s
  order-independence test was re-armed with `(33, 32.5)`.
- `craterProfile`'s `if (t > 1)` ejecta step is fixed by `smoothstep(1, RIM_OUTER, t)`.
- `rayCraters`'s sort is total; `morphCover`'s `evenRow/evenCol` cannot index the border.

## A memoized selection: check the memo key against what the _callee_ reads, not the caller

`perf/the-hud-stops-billing-the-frame` added `TerrainStreamer.#selection`, reused while
`(body identity, eyeLocal within 5 mm, maxLevel, cacheEpoch, lens.focalLength/gauge/zoom,
viewport)` hold. It is complete, and the check that settles it is worth reusing: read the
callee's _parameter type_, not its call site. `TerrainEye` is `{radius, relief, distance,
direction}` and carries **no camera orientation**, so a look-around cannot change the
selection and the key is right to omit it. `#eye()` derives all four from `surface` +
`eyeLocal` alone. `cellPixels`/`resolution`/`maxPatches` are never passed and are module
constants. The only hidden input is the `ready` closure over `#patches`, and `#cacheEpoch`
is bumped in `#build`, `#evict` and both worker `.then`s — captured _before_ `#build`
mutates, which is what lets refinement advance.

The residual worth checking on any future edit: the held branch runs `#request` but not
`#build`/`#evict`, so a cap can be exceeded for exactly one frame. Fine because an
arriving field bumps the epoch.

## Verify an "identical answer, fewer allocations" refactor by running both revisions

Two of this branch's riskiest changes were settled in ten minutes each, and the method
generalizes.

**`balance`'s depth map carried across passes** (`terrainSelect.ts`): `git archive
origin/main | tar -x` into `.scratch/mainwt`, symlink `node_modules`, import _both_
`selectTerrain`s by absolute path, and diff the sorted patch-key sets. 8,136 cases —
12 Sol bodies × 14 altitudes × 17 directions, plus a `ready` predicate at four starve
densities — came out identical, `starved` sets included. Note the carried map is _more_
eager than the rebuilt one (children are deepened mid-pass), which converges to the same
2:1 closure because a split only ever adds +1 to an ancestor's depth.

**A pure function moved to a worker**: reconstruct the payload the task actually posts
and compare against the main-thread call over every body. `surfaceDetailFloorTask` sends
five fields; `SurfaceParameters` has exactly five; 129 Sol bodies, 0 mismatches. Check
the _default arguments_ too — the no-pool path calls `surfaceDetailFloor(surface)` and
the worker passes `HEIGHTFIELD_RESOLUTION` explicitly, which happens to be the default.

## `WeakMap` keyed on a value object is safe here, and the grep that proves it

`formatAddress`/`bodyFrameId`/`bodyFixedFrameId` memoize on the `UniverseAddress` object.
Safe: every variant is all-`readonly`, the one array (`body: readonly number[]`) is never
written, and `regionAddress()` returns a fresh literal. The one-line proof —
`grep -rnE "\.(galaxy|system|body|region|object)\s*=[^=]" packages/*/src apps/*/src` —
returns a single hit and it is `World.galaxy`. Run that before accepting any new
identity-keyed cache on an address.

## The advisory section that turns a path-scoped mirror into an essay

New inverse of the mirror-drift shape. `perf/the-hud…` added 46 lines to
`.claude/rules/timing.md` ("The shapes the two performance passes kept finding") that
mirror **nothing in `AGENTS.md`** and are pure narrative with measured figures — against
`.claude/rules/README.md`'s two explicit clauses, "these files carry only the
_imperative_" and "Do not paste reasoning into these files. A rule that grows past ~30
lines…". It took timing.md 62 → 108. And three of the five bullets are about
`Starfield.tsx`, `terrainSelect.ts` and `browserWorker.ts`, none matched by timing.md's
own `paths:` — the wrong-path-scope failure again, now for advice rather than an
invariant. Same branch took `browser.md` 28 → 43 against README's "kept under thirty
lines" for the three unscoped rules.

**Cheap check on any diff touching `.claude/rules/`:** `wc -l` before and after, and for
every backticked filename in a new bullet, confirm the rule's own `paths:` matches it.

## A `.mjs` script's query-key twin has nothing holding it to `QUERY`

`scripts/drive.mjs:200` writes `url.searchParams.set('presentation', 'occluded')` and
names `QUERY.presentation` in the comment above it. A `.mjs` cannot import the TS module,
so the twin is necessary — but renaming the key in `pages/paths.ts` silently re-arms the
presentation watchdog on every driver boot, which is the exact defect that commit fixes
and which fails as a slow boot rather than an error. `apps/game/src/pages/pages.test.ts`
is where a `QUERY.presentation === 'presentation'` assertion belongs.

## The concurrent docs pass is now reliable enough to plan around

Third branch running. On this one the working tree gained AGENTS.md, `.claude/rules/
rendering.md`, `README.md`, five `docs/concepts` and `docs/guides` files and
`packages/universe/src/terrain.ts` _during the audit_ — and it had already fixed the
`placePathInto` half of the ADR-0003 mirror before I could file it. **Run `git status`
immediately before writing and drop what the tree already fixes.** What the docs pass
reliably does _not_ sweep: `.claude/rules/*` and Mermaid diagrams. `streaming.md` gained
three new paragraphs about the detail-floor gate and the selection memo while its
flowchart still shows one gate straight into `WALK`.

## Two counters off one rig line, combined into a ratio that does not exist

Richest finding on `feat/headless-webgpu`, and the shape generalizes to every
"measured elsewhere in this repository" citation. `docs/plans/test-speed.md`
argues for a heightfield disk cache with "the worker pool caches **31,766 of
37,854** requests in one baseline descent". Both numbers are real and neither
means that: `pnpm sim --terrain-baseline` prints, for `rocky-airless — Gliese
1061 d`, `37854 requests / 35883 unique / 31766 cache hits`. The dedup rate is
1,971/37,854 = **5.2%**, which is what `CONTEXT.md`'s own baseline table already
records ("Cache hit rate, 64 heightfields: **< 5%** on a tracked descent"). The
rig's output refutes the reading on its face — `cache hits` **exceeds**
`requests` on three of the four bodies (43,396 > 23,632; 52,546 > 21,697;
60,503 > 10,432) — so it cannot be a subset of them.

**The check:** when a doc cites a figure with no `rg` hit anywhere else, run the
rig and read the whole line. Two adjacent counters with different populations is
the commonest way a plan acquires an 84% where the tree records 5%.

## Same measurement, three numbers, one of them nobody's

`pnpm test:gpu` is "620 ms" (CONTEXT.md), "0.9 s" (`docs/plans/test-speed.md`
table and prose) and "**1.2 s**" (`docs/guides/testing.md`), all attributed to
"an idle M5". Measured three times idle: vitest `Duration` 566/591/647 ms, wall
`real` 0.86/0.88/0.94 s. So 620 ms is the vitest line, 0.9 s is wall, and 1.2 s
is neither. **Vitest prints two times and a doc that quotes one without saying
which is not comparable to the table row beside it** — test-speed.md's other
rows are wall clock.

## `CONTEXT.md` § "Known gaps" is present tense and the docs pass never sweeps it

`feat/headless-webgpu` inserted its new section immediately above `## Known
gaps` and left the gap that says the tone curve "is verified on a GPU or not at
all… there is no CPU backend to evaluate one in Node, and the benchmark harness
`docs/design/technical.md` already calls an M2 prerequisite is what would do
it" — while the same branch's `output.test.ts` comment correctly names
`*.gpu.test.ts` as the home. Everything below `## Known gaps` in CONTEXT.md is a
claim about now; everything above it is dated history and is fine.

## A plan document's premise block asserts the present content of files it retires

`docs/plans/headless-webgpu.md:6-12` opens "`docs/guides/testing.md` and
`.claude/rules/rendering.md` **both state** that a TSL node graph cannot be
evaluated in Node" — and § 7's table lists the four passages "that become
wrong". The branch rewrote all four. The **body** of a plan is intent and may
stay; a blockquote asserting what two files in the tree say right now is not.
Grep a shipped plan for present-tense claims about other files.

## The method that proves a shader regression test is armed, without touching the tree

`git archive HEAD | tar -x` into scratch, symlink `node_modules` and
`apps/game/node_modules`, revert the fix in the copy, and run
`node node_modules/vitest/vitest.mjs run --config apps/game/vitest.gpu.config.ts`
from the copy's root. **`node_modules/.bin/vitest` is a shell shim and dies with
`SyntaxError` under `node`** — go to `vitest.mjs` directly. The gpu config's
`include` and `setupFiles` are root-relative, so running from the copy's root
picks up the copy's files.

Result on `feat/headless-webgpu`: all three stand-in reverts go red, and for
distinct reasons — the ground's is a device error
(`unresolved value 'nodeUniform17_sampler'` at
`CreateShaderModule([ShaderModuleDescriptor "fragment"])`), the atmosphere's and
the planet's are signature mismatches
(`unsampled: textureLoad(…)` vs `sampled: textureSample(…)`).

## `isUnfilterable` in r182 is exactly two filters, so mip settings do not fork the program

`WGSLNodeBuilder.js:603`: unfilterable iff `minFilter === NearestFilter &&
magFilter === NearestFilter`. So a test fixture using `LinearFilter` both ways
is a valid stand-in for a real map loaded `LinearMipmapLinearFilter` +
`anisotropy` (`planetTextures.ts:151`) — the mip and wrap settings never reach
the generated WGSL. Do not file that as a fixture-mismatch finding.

## A constant moves and its own file keeps the retired figure 900 lines down

`feat/the-gpu-producer` took `BUILDS_PER_FRAME` 4 → 8 and rewrote its docstring, and
`terrainStreamer.ts:1130` — the same file — still reads "0.25 ms a patch, **four a
frame** by budget". Plus `docs/concepts/streaming.md:100` (a Mermaid node, one line
below a node the same commit _did_ edit), `streaming.md:440`, `docs/roadmap.md:187` and
`docs/plans/the-timeline.md:477`. streaming.md and roadmap.md were both in the diff.

**The check on any diff that changes a numeric constant:** `rg` the retired _word form_
("four a frame", "twice", "a fifth of") as well as the digit, and grep the constant's own
file top to bottom — the docstring is edited, the call-site comment is not.

Same branch, adjacent shape: the new docstring cited the budget doc and got it backwards.
`terrainStreamer.ts:199` says eight builds is "two milliseconds: the terrain line of the
frame budget in `docs/design/technical.md`, and nothing else's", while
`technical.md:156` — edited by the same branch — reads "1.0 ms … 2 ms, **twice this
line**". When a comment names a document and a number, open the document.

## The GPU-port branch: what came back clean and the two-line proof

Worth not re-deriving. `git archive origin/main | tar -x`, symlink `node_modules` **and
each `packages/*/node_modules`** (workspace links live there, not at the root — the root
symlink alone fails with `Cannot find package '@inertialref/shared'`), then import both
`terrain.ts` by absolute path.

- `elevationAt` and `drawnElevation`: **bit-identical**, 15,480 samples × 129 Sol bodies.
- `surfaceCoverAt`: identical, 7,740 samples.
- `generateHeightfield`: **167 of ~540k samples move, max 0.63 m on Miranda** — the
  `ChordForm` `'exact'` integer slab test. It moves exactly the 17 bodies with at least
  one tail rung whose `cells²` is an exact integer, and no body with none. Presentational,
  unversioned, correct.

The `'exact'` change is reachable only from `micro.ts:166` → `microRelief` →
`drawnElevation`. `craterField`/`ladderField` default to `'fast'`, so `elevationAt`
never takes it. That is the whole version-discipline question and the grep that settles
it is `rg "'exact'" packages/universe/src`.

## A justification whose premise is a claim about the generator — measure the generator

`craters.ts`'s `ChordForm` docstring argues the integer slab test with "They are equal on
every tail rung of every Sol body: … a published radius is a round number, and an integer
sphere has lattice points on it." Measured over `walkBodies(SOL)` + `terrainSketch`:
**29 of 128 bodies have an integer `cells²` at every tail rung, 17 at some, and 82 at
none** — Earth (796375.086…), Mars (423690.025…), Ceres, Phobos, Deimos among them. The
code is right; the reason given is false for two thirds of the population it names. Same
family as the `cover.ts` "Europa is ice at the equator" finding.

**The probe:** `Number.isInteger(level.cells * level.cells)` across every tail rung of
every body, one loop. Any docstring that says "every body" is one loop from being settled.

## `warmAtMount` from a renderer callback is never a census unit

`App.tsx:370` registers the GPU producer's pipeline compile with `warmAtMount`, and
`App.tsx:348` + ADR-0023's consequence list both claim the boot cover waits for it. It
cannot: `warmup.ts`'s module `session` is set only by `beginWarmup()`, called only from
`warmScene()` in `preload.ts:165`, called only from the `App` effect keyed on `output` —
and `output` is set by `setOutput(handle.description)` on the line _after_
`adoptProducer(handle)`. So `session === null` at the first call and settled at every
later one; `warmAtMount` takes its detached `producer.run(() => {})` branch every time.

**The check for any new `warmAtMount` caller:** trace who sets the module `session` and
whether that has run yet at the call site. A `useEffect`-mounted component is fine; a
renderer-ready callback is not.

## The concurrent docs pass now lands mid-audit as _uncommitted_ working-tree edits

Fourth branch running, and this time it fixed `.claude/rules/browser.md` (the watchdog's
stated mechanism, which the in-frame `requestAnimationFrame` sample invalidates) and
`docs/adr/0017-the-lens.md` (`camera.fov` → "the only _lens_ field") while I was reading.
Both would have been findings. What it still did **not** sweep: `AGENTS.md:196` and
`.claude/rules/rendering.md:66`, which carry the same `camera.fov` claim the ADR just
qualified. **The pass reaches ADRs and prose docs; it does not reach `AGENTS.md` or the
path-scoped mirrors.** Grep the canonical file for the sentence the ADR was just softened
on.
