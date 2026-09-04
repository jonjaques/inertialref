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

## An identifier rename sweeps the canonical file and its mirror, and stops there

New variant of the mirror-drift shape, and the _good_ half fired: `feat/a-coasting-ship-is-on-rails`
split `SimulationClock.advance` into `plan`/`settle`, and a follow-up commit
(`docs: the wall-clock invariant names the call that still takes a second`) correctly
rewrote **both** `AGENTS.md` and `.claude/rules/determinism.md` to name `clock.plan`. Its own
`--stat` is two files. What it did not reach: `docs/adr/0006-simulation-clock.md:20` — the ADR
the invariant cites by name — plus `docs/hosting.md:669` and a code comment at
`apps/game/src/pages/DataSection.tsx:48`, all three still reading "wall clock enters at exactly
one call, `clock.advance`". `SimulationClock.advance` now has **no production caller** at all.

**The check on any diff that renames a method an invariant names:** `rg` the old identifier
across the whole tree after reading the fix commit's `--stat`. A two-file docs commit for a
rule that is quoted in four places is the tell.

## A derived per-entity cache that a _new_ movement path bypasses

`World.#groundAhead` (`world.ts:178`) holds the contact test's post-step ground sample so the
next tick reuses it, and its docstring says "anything else that moves an entity drops it, and a
fresh sample is bit-identical to the reuse". `teleport`, `reframeEntity`, `#land`, `#liftOff`
and a frame change all call `#forgetDerived`. The new rails path does not: `#coast` moves the
entity for arbitrarily many ticks and `#leaveRails` (`world.ts:770`) clears `rails` and
`#coasting` and leaves `#groundAhead` alone. Measured: eccentric Earth orbit, rails entered at
130 km, `setControl` after 60,000 coasting ticks at 2,418 km — the integrator is handed the
130 km number. Benign **only** because rails eligibility (`periapsis > radius + groundBand`)
forces the stale value above the atmosphere ceiling, so the one branch that reads it takes the
same side either way; the contact block recomputes. One line to fix, three steps to prove safe.

**The check:** for each private `Map<EntityId, …>` in `World`, list every method that writes
`entity.state` and confirm each appears in `#forgetDerived`'s caller set.

## The method that settles a jump-vs-step equivalence claim, in ten minutes

`world.runTicks(N)` jumps; a bare `for (…) world.step()` loop steps the same ticks. Same seed,
same fixture, compare `stateHash()` and `Vec.distance` of the positions. Bit-identical over
200k/300k/400k ticks on three conics (circular LEO, escape hyperbola, high ellipse) and across
a real SOI departure — both worlds fired `left sphere of influence` on tick 59,200.

To count _jumps_ rather than ticks, monkeypatch the instance: `clock.commitTicks = (n) => {…}`.
A 100,000× 60 fps frame over a LEO coast is **one** jump of 106,666 ticks; 10⁷× is eight, the
longest 8.86 h — which is the "bounded by Luna at about ten hours" figure ADR-0025 quotes.

## A boundary-scheduled test converges regardless of its schedule — the argument, so you do not re-derive it

`World`'s rails schedule (`nextCheckAfter`) worried me because a restored world rebuilds
`nextCheck` as `nextBoundary(clock.tick)` while the original carries a `safeFor`-derived one, so
the two test at different boundaries. It cannot diverge: `nextCheck = firstBoundary(safeHorizon)`
and `safeHorizon ≤ crossingTick`, so `nextCheck ≤ firstBoundary(crossingTick)` at _every_ test,
and the strictly-increasing sequence must land exactly on `firstBoundary(crossingTick)`. The
detection tick is a function of the crossing instant alone, whatever the intermediate schedule.
Any "sound bound + fixed boundaries" scheme has this property; check the two inequalities rather
than hunting for a counterexample.

## The ground band is empirical, and the measurement is one loop

`groundBand = max(maxElevation, atmosphere.ceiling) + 108` replaced `binding.radius * 0.25` as the
gate below which terrain is sampled, on the premise that the field never exceeds `maxElevation`.
The band-share arithmetic argues it and `craters.ts`'s `softLimit` folds in on top, and
`universe.test.ts:332` tolerates `1.2 ×`. Measured `max(surfaceRadius(body, d) − body.radius)` over
6,000 directions × 129 Sol bodies and 3,000 × 362 generated bodies: the peak is **0.46 ×
maxElevation** at worst (Alpha Centauri III), minimum slack 108 m, and `datumRadius ≤ body.radius`
holds for every `figure` body because the half-extents arrive sorted. The gate is safe by ~2×.
Worth not re-deriving; worth re-running if a band's share ever exceeds its allowance.

## Same save, two numbers, again

`docs/concepts/persistence.md:6` says the save is "**900** once the ship is coasting" while the
same branch's `docs/design/technical.md:206` says **998** and `pnpm sim --self-test` capability 11
prints "998 bytes". Both describe capability 11's save. Third instance of this shape in these
notes. **Run the rig that prints the number** — `pnpm sim --self-test` takes seconds.

## A modulo-reduction test that reduces the same way the function does

`universal.test.ts`'s "holds a low orbit to the millimeter across a year of revolutions" compares
`propagateTwoBody(from, mu, year − whole)` against `propagateTwoBody(from, mu, year)`, where the
test computes `whole` from `2π√(r³/μ)` and the function reduces internally by
`2π/(√μ·α·√α)`. Mathematically the same period, so the test is close to asking the function the
same question twice; what saves it is that the two period expressions round differently and a
`toBeCloseTo(r, 3)` on the radius is independent. Fine as shipped — but the generic check is:
when a test asserts "the internal reduction is exact", make sure the expected side does not
reproduce the reduction.

## The bound is loosened to the exact value of the defect it guards

Sharpest finding on `feat/a-coasting-ship-is-on-rails`'s tail two commits, and the
cheapest to spot: `universal.test.ts`'s angular-momentum bound went 1e-9 → **5e-9**, and
the comment above it says the step-exit Newton regression "reads **4.6 × 10⁻⁹** here".
4.6 < 5. `CONTEXT.md` restates both numbers in one sentence. Measured over 4 × 180,000
fast-check draws of the arbitrary's own domain: the step-exit variant exceeds 1e-9 on
10–14 states per 180k (~1.8% detection at `numRuns: 300`) and 5e-9 on 0–2 (~0.2%), so the
change is a 10× disarm. **When a bound is loosened, put the regression's own measured
value beside the new number and subtract.**

Same finding's second half: "5 × 10⁻⁹ is four times the worst this domain produces …
worst is 1.2 × 10⁻⁹" is one seed. Four seeds: 1.8e-10, 9.4e-10, **6.26e-8**, 8.6e-10 —
one in four exceeds the bound, so the shipped solver is flaky against it at about the
rate it catches the regression. fast-check is **unseeded** here (no `fc.configureGlobal`,
no setupFile), so "swept over N states" is a claim about one draw. Re-run it with three
seeds before quoting it.

The armed alternative exists and is one line: a _deterministic_ example. Hyperbola from
400 km at 1.156 × escape, propagated 100 days to 5.4 × 10¹⁰ m, separates HEAD
(4.8 × 10⁻¹²) from the step-exit variant (4.2 × 10⁻⁹) by 870×. The branch already found
this shape for the bisection defect ("converges on a near-parabolic hyperbola") and did
not for the step-exit one.

**The rig, reusable in ten minutes:** `sed` the package's imports to absolute paths into
scratch, `cp` it, patch the one line under test, and drive both copies from one loop
importing `fast-check` from
`node_modules/.pnpm/fast-check@4.9.0/node_modules/fast-check/lib/fast-check.js` (the root
`node_modules/fast-check/lib/esm/` path does not exist). 180,000 runs is 18 s.

## A "the row now reads 0×" honesty fix that arms a warning banner

`clock.settle`'s `#asked` became nullable so a paused frame keeps its 0× instead of
being read as the sub-tick "asked for nothing and delivered it" case. Correct — and
`PerfPanel.tsx:164`'s amber line is `achievedTimeScale < timeScale * 0.99` with no
`paused` term, so pausing at 100,000× now prints "capped — this frame could not deliver
100000×". `world.paused` is on the same `WorldInspection` object, unused. The concurrent
docs pass documented the 0× row in `docs/concepts/time.md` and did not notice the banner.
**When a status value gains a new legitimate low reading, grep every predicate that
compares it.**

## `#railsCheck`'s lazy coast record and the tick stamp: both equivalent, do not re-derive

`#enterRails` stopped constructing the `CoastRecord` and now only deletes it;
`#coastRecord` rebuilds it at first use with `nextBoundary(this.clock.tick)`. Equivalent:
every reader (`#coastable`, `step`, `#jump`) runs after `commitTick`, where `clock.tick`
equals the `tick` the old call site passed, and `railsSpeedBound` reads only frame +
epoch. Likewise `#record(..., tick - 1)` in `#railsCheck` matches the integrated path,
which stamps `this.clock.tick` _before_ `commitTick`. And `nextCheckAfter(tick, …)` is
the same value the old `this.clock.tick` gave. All three untested, all three correct.

`considerFrameChange`'s `rebased` boolean → `travel/elapsed` reset is not just a rename:
the old code kept `const travel` after calling `rebase`, so every child _after_ the
rebase subtracted travel and elapsed a second time from already-rebased gaps. The new
code zeroes them, which removes a double subtraction. Sound either way (the old one was
over-conservative), and the crossing tick is unchanged because the honest test is exact.

`coastState`'s `Q.integrate` swap is **bit-identical**: `Vec.length` is `Math.hypot` and
so is `Q.integrate`'s internal omega, and `integrateBody` calls the same function.
`visViva(mu, periapsis(e), a)` equals `sqrt(mu(1+e)/(a(1−e)))` in exact arithmetic;
`orbitalPeriod(mu, 1/alpha)` equals `2π/(√μ·α√α)`. Both differ only in the last bits.

The new bisection safeguard never exhausts: 250,000 propagations (Earth hyperbolas and
ellipses, heliocentric ellipses to 50 revolutions) peak at **66** of the loop's 100
iterations, 0 exhausted.

## Two counts of the same population, one branch apart

`docs/adr/0025-the-rails.md` says "sixty-seven children" of the Sun and
`flight.ts:551` — written by the same branch's first commit — says "sixty-six in Sol".
Measured `world.loadSystem(SOL).planets.length` = **67**. The ADR's "twelve" is right at
a 30 km reach threshold (12 bodies; the next is Annefrank at 42 km) and wrong at the
"twice that" 60 km one it argues in the same sentence (15).

## Resolved on earlier branches — do not re-report

- `Observatory.stand` guards `focus` on `wanted.address !== this.#target?.address`.
- `CAMERA_LENS` gained `revive: reviveLens`; the Reset-stays-enabled bug is gone.
- The `surfaceDetailFloor` memo key is `|`-separated, and `universe.test.ts`'s
  order-independence test was re-armed with `(33, 32.5)`.
- `craterProfile`'s `if (t > 1)` ejecta step is fixed by `smoothstep(1, RIM_OUTER, t)`.
- `rayCraters`'s sort is total; `morphCover`'s `evenRow/evenCol` cannot index the border.
- The `clock.advance` → `clock.plan` rename is now swept everywhere: ADR-0006,
  `docs/hosting.md`, `DataSection.tsx` and `.claude/rules/determinism.md` all name `plan`.
- `World.#leaveRails` calls `#forgetDerived`; the stale `#groundAhead` finding is closed,
  and `#step` now deletes the sample on a frame change and above the ground band.

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

## A font stack is a claim you can resolve mechanically, and the sigils were wrong

Richest finding on `design` (the Plex/type branch) and the method generalizes to any
`unicode-range` work. **Do not read the prose; resolve the codepoints.** Parse every
`@font-face` in `index.css` _and_ in each `@fontsource` package's shipped CSS into
(family, ranges, file), then for each symbol walk the stack, filter by `unicode-range`,
and — this is the half that finds the bug — open the file with `fontkit` and ask whether
the glyph is actually **in** it. `unicode-range` is a download hint; a declared range over
a file that lacks the glyph falls through silently.

Measured on `design`: `☉` (U+2609) and `⊕` (U+2295) — the two sigils ADR-0024, DESIGN.md,
`index.css`, `adr/README.md` and `development.md` all name as the motivating case — resolve
to **no declared face**. Noto Sans Symbols' fontsource `symbols` subset begins at U+260A,
and its ranges list U+2299 and U+22C4-22C6 but skip U+2295. The vendored Plex subsets
declare `U+2200-22FF` and contain neither. `@fontsource/noto-sans-symbols-2` has U+2609
(and was already in the pnpm store, unlisted — someone tried it).

Second half, same branch: the **mono has no Greek at all**. The vendored mono subset has
0 Greek codepoints (the sans one has 73), `@fontsource/ibm-plex-mono` ships no greek
subset, `noto-sans-math` ships **latin only**, `noto-sans-symbols` declares no Greek range.
`docs/concepts/rendering.md:361`'s `μ₀` in a code block draws `₀` from the vendored Plex
file and `μ` from `ui-monospace` — two faces in one token, which is the exact failure the
comment above the stack claims to have closed.

The one-liner that finds all of it lives in the scratchpad recipe: build the face list,
`hasGlyph(file, cp)` via `fontkit.openSync(...).characterSet`, print the winning family per
codepoint per stack. Ten minutes, and it settles five prose sites at once.

Adjacent: check the ADR's stated `pyftsubset --unicodes=` recipe against the shipped
`unicode-range`. On `design` the recipe adds `U+2044,U+2113,U+2126`, the files contain all
three, and the `@font-face` omits them — glyphs that can never be selected.

## The new `:coverage` / instrument script is the one nobody re-runs

`design` added `pnpm test:coverage`, a `coverage:` block in `vitest.config.ts` whose
docstring argues the denominator at length, and `design/reports/complexity.md` — 481 lines
where every number comes from that command. **The command does not complete.** Two runs:
4 and 6 tests time out at the config's own `testTimeout: 20_000` (v8 instrumentation is
~4× per test), 96 s and 112 s against a claimed **31 s**, exit 1, and no `coverage/`
directory is written — so the report's stated input `coverage/coverage-final.json` cannot
be regenerated. The report acknowledges `hookTimeout` for the descent suite and not
`testTimeout` for `cover.test.ts`, `geology.test.ts`, `scatter.test.ts`,
`devtools.test.ts`, `terrainStreamer.test.ts`.

**Just run the new script.** A report document is a very strong signal that its own
command has been run exactly once, by hand, before the last three commits landed.

## `pnpm test` now has three numbers again, and the gate carries the low one

Same shape as the `test:gpu` 620 ms / 0.9 s / 1.2 s finding, one layer up.
`.claude/hooks/gate.mjs:10` says `test 6.5s` and "about twelve seconds";
`design/plans/test-speed.md` says **10.0 s** and "about 15 s"; `complexity.md:418` says
"the 31 s of `pnpm test`", which is its own table's figure for `test:coverage`. Measured
warm twice: 10.62 / 10.48 s vitest `Duration`, 10.9 / 10.8 s wall; cold 21.0 s.
Re-measure the gate header on any branch that changes what the suite runs.

## `describe.skip` as a cost decision: honest, documented, and still a hole in CI

`design` skipped `gameEngine.test.ts`'s one-descent suite (4 `it`s) to buy the Stop gate
ninety seconds. The docstring is exemplary — it names the price, names the fix, cites
`design/plans/test-speed.md` § 1. It is still true that `pnpm check` and CI run `pnpm test`,
so **"the ship lands on the ground it drew" is now proved nowhere**. `pnpm test` reports
`4 skipped`, which is the grep. Any diff that skips a suite in the _shared_ config has
removed it from CI, not just from the per-turn gate; the second-project shape
(`vitest.gpu.config.ts`) is the fix and it already exists.

## Commented-out code kept alive by `@ts-expect-error` is a suppressed dead-code signal

`apps/game/vite.config.ts:74-96`: the analytics build-log line is commented out, its two
locals are now unread, and they are held past `noUnusedLocals` by
`/* eslint-disable no-unused-vars */` plus two bare `// @ts-expect-error`. `pnpm lint` and
`pnpm typecheck` are green _because of_ the directives — the compiler was telling the truth
and was silenced. The docstring above is untouched and still present tense: "this is so the
build log answers it instead." **A bare `@ts-expect-error` with no description in a diff is
worth reading the line under it; here it absorbed the one diagnostic that says the function
is dead.**

## Labels walked back from title case, with the rule left standing in four places

`AGENTS.md:307`, `DESIGN.md:345` and `:792`, `.claude/rules/react-shell.md:127` and the
invariants row all say labels are title case in source. `design` converted
`'Focal Length'→'Focal length'`, `"Free Look"→"Free look"`, `"Minor Bodies"→"Minor bodies"`,
`"Orbit Paths"→"Orbit paths"` and added eight more sentence-case ones, amending none of the
five statements. ~11 sentence-case labels predate it, so the rule was already leaking — the
new thing is a change that walks it back on purpose. Grep:
`rg -n "label[=:] ?['\"\`][A-Z][a-z]+ [a-z]" apps/game/src -g '!_.test._'`, then subtract
the `aria-label`s (sentences, never displayed) and diff against `origin/main`.

## A branch that adds an invariant violates it once, in a file the sweep did not reach

`design` added "Never write a plan under `docs/`. Plans, working reviews and tooling
reports go in `design/`" and moved five plans — while checking in
`apps/game/.impeccable/critique/2026-08-31T22-19-32Z__src-app-tsx.md`, a working review,
under `apps/game/`. The final `docs:` commit swept `docs/plans/` and not this. It also
makes `.impeccable/` a tracked directory the machine's hook writes into every turn, with
nothing gitignoring the rest. **When a diff adds a "X lives in Y" rule, `git diff --name-status`
for every other X in the same branch.**

## What the concurrent docs pass fixed on `design`, mid-audit

Fifth branch running. Three commits landed while I read (`c4604c9`, `33beef3`, `9626ad4`)
and one of them added the `docs/agents/invariants.md` row for the new plan invariant —
which would have been a finding. It did **not** reach `DESIGN.md:298-306`, a past-tense
paragraph naming Instrument Sans whose parallel in `index.css` the same branch rewrote to
present tense. The pass reaches ADRs, guides, `CONTEXT.md` and now `invariants.md`; it
still does not reach `DESIGN.md`'s older prose or `.claude/rules/`.

## Cheap things that came back clean on `design`, worth not re-deriving

- `pnpm graph`, no `three` in `packages/*`, no bare `three` in `apps/game`, no new
  `Math.random`/`Date.now`/`performance.now`/`localStorage`, no `text-slate-500`.
- `formatReading`'s ladder is byte-for-byte `formatDistance`'s; the `group()` separator is
  hand-rolled for the `dossier.ts` locale reason and handles the U+2212 sign.
- `surveySites`'s renamed site keeps its `corner` **id** and says so; `regionDirection` is
  still the producer.
- Dock: `defaultOpen: false` reaches `normalizeLayout` only through `layoutOf`, so it
  places a first-time panel and reopening still reads the definition's `zone`
  (`dock/panels.ts:91-105`). The registry comment is true.
- `FOCUS_MAX` 1000 → 10_000 only widens `isLens`'s accepted set, and the 4.47 km telephoto
  hyperfocal it is sized against matches `packages/rendering/src/lens.ts:349-352`.
- ADR index discipline complete for the first time in these notes: table row, Mermaid node,
  an incoming edge, and both count words moved to twenty-four.
- `lint`, `typecheck`, `format:check`, `brand:check`, `presets:check`, `docs:build`,
  `fta:check` all green; `knip` reports the 5 unused files the report claims.

## An invariant amended to name a third field, with the old bound left covering it

`feat/the-liquid-worlds` is the cleanest instance yet of a rule going wrong while
its mirror stays in step. The canonical/drawn bullet gained `drawnGroundElevation`
(the seabed, sea clamp off) in `AGENTS.md:334`, `.claude/rules/determinism.md:42`
and `.claude/rules/rendering.md:118` — all three swept, which is the discipline
working — and the sentence that follows in all three still reads "**The drawn
fields** differ from the canonical one by at most `drawnDivergence`, which is
1.25 m." Measured over 2,000 directions: `|drawnGroundElevation − groundElevation|`
is 4,913 m on Earth and 9,841 m on 85 Pegasi IV, because the canonical field is
clamped up to the sea datum and the seabed is not. `drawnElevation` still holds
the bound exactly (46 wet worlds × 600 directions, `gap − drawnDivergence` = 0.0000).
**The check when a bullet gains a field: re-read every universally-quantified
sentence in the rest of the bullet and ask whether the new field satisfies it.**

## The `pack`-vs-reader asymmetry: `Math.max(x, 1)` on one side only

`cover.ts`'s `biotaCover` uses `Math.max(grammar.reliefLimit, 1)` as its budget;
the TSL port in `render/terrainKernel.ts` uses `scalar(SCALAR.BUDGET)`, which is
`surface.maxElevation` = `grammar.reliefLimit` with no floor. Unreachable in
practice (biota needs air, which needs kilometers of relief) but it is the shape
to look for in any hand port: a clamp, a floor or an `?? default` applied on one
side of the CPU/GPU pair.

## The eight-byte cover record: the patch-memory figure is now wrong in seven places

Third iteration of the same drift (220 KB → 237 KB → now stale again). Cover went
4 → 8 bytes/vertex in two attributes, so a 65×65 patch is 203 KB geometry +
67.6 KB cover ≈ **271 KB**, and 1,280 of them ≈ **347 MB**. Still reading 237 KB /
303 MB / "four bytes": `packages/rendering/src/terrainSelect.ts:150-154`,
`terrainMesh.ts:113` (line 52 in the _same file_ was updated), `docs/roadmap.md:197`
(the diff reflowed the row's whitespace and left the numbers),
`docs/concepts/streaming.md:443`, `docs/concepts/rendering.md:318`,
`docs/concepts/determinism.md:137` (a Mermaid node), `docs/design/content.md:168`,
`apps/game/src/engine/scatterField.ts:533`, `docs/adr/0021-the-ground.md:107`.
Four of those files were in the diff. **`rg '237 KB|four bytes|four-byte'` is the
whole check.**

## Sea-census figures in an ADR: run both revisions, the counts were 39/20 and are 54/30

ADR-0026 says "Twenty of the thirty-nine seas within twenty light years sat on
ground between 400 and 1,200 K." Measured with the shipped default seed
(`'inertialref'`, `session.ts:165`) and `data/catalog/stars-150ly.irsc`, over the
85 stars inside 20 ly: **54** seas on `origin/main`, **30** of them on ground
400–1,200 K, **14** left on HEAD. **Trap that cost ten minutes: `star.position` is
a `UniverseVector`, so `Math.hypot(x,y,z)` silently matches every star in the
catalog — use `UV.distance`.** The `git archive origin/main` + per-package
`node_modules` symlink recipe is what makes the before/after count possible.

## A grammar gate whose docstring excludes the case the `hasOcean` widener admits

`grammar.ts`'s `liquid` is `airborne * max(liquidWindow(T), hasOcean ? 0.5 : 0)`,
and its docstring says "Magma does not count: a lava sea stands and a lava channel
is a volcanic feature, not a drainage one." A magma world that drew a sea has
`liquidWindow = 0` and `hasOcean = true`, so it gets `liquid = 0.5` and
`drainage ≈ 0.42–0.48` — river valleys and `wet` channels on ground at 1,871 K.
Four bodies inside 20 ly: HIP 26013 b, HIP 65469 b, Gliese 9827 b, Gliese 1252 b.
**Any `Math.max(window, flagged ? k : 0)` widener needs its docstring's exclusions
re-checked against the flag.**

## Cheap things that came back clean on `feat/the-liquid-worlds`

- `pnpm graph` clean; no `three` in `packages/*`; only `three/webgpu` + `three/tsl`
  in `apps/game`; no `performance.` in `packages/*`; no new
  `Math.random`/`Date.now`/`localStorage`; no `text-slate-500`; new labels sentence case.
- Draw order preserved: `makeSurface` still takes `rng.bool(0.4)` and reads it
  after; the appearance palette is `new Rng(deriveSeed(surface.seed,'appearance'))`,
  its own stream. `solar/system.ts`'s hoist of `surfaceOf` above the `moons` loop is
  draw-order-neutral because each body's `rng` is `new Rng(deriveSeed(parentSeed,
'b:i'))` — the moons recurse with their own.
- `cellPixels` became a _mutable_ streamer field and **is** in the selection memo,
  folded into `optics = pixelsPerRadian/cellPixels`; `terrainSelect.ts:457` is its
  only reader, so the quotient is complete. (This was the open risk in the earlier
  memo-key note — closed.)
- `terrainAttributes.ts` gives each attribute name its own
  `InterleavedBufferAttribute` over one `InterleavedBuffer`; the warm-up dummies in
  `WaterPatches`/`TerrainPatches` construct a fresh `BufferAttribute` per name over a
  shared array, which the rule explicitly allows.
- Varyings (`terrainShaded/Local/Deposit/Deposit2`, `waterLocal`, `waterDeep`) collide
  with no attribute name; `waterDeep` vs the `waterDepth` attribute is deliberate.
- `WaterPatches` uses `placement.scale`, which for a _patch_ placement is
  `body.placement.compression` (`terrainStreamer.ts:888`) — not the ADR-0015 violation
  it looks like. Check the placement's producer before filing that one.
- Both `seabed` deciders go through `seaSheetDatum(body)`; `terrainProducer`'s cache
  key and `surfaceKernel`'s `WeakMap` both carry the flag; worker task version 4 → 5.
- `drawnDivergence` unchanged and still exact; the coast remap is inside `evaluate`,
  so canonical and drawn both get it and only the tail separates them.
- ADR index: table row, Mermaid node and two incoming edges all present — but the
  count words are **not**: `docs/adr/README.md:3` and `README.md:387` still say
  "Twenty-five decisions" with twenty-six in the table.

## Rerouting a writer through a persisted preference inserts a second predicate

Richest finding on `refactor/five-modules-deepened`, and the shape generalizes to every
"the preference is the owner" refactor. `GameEngine.requestLens` sets the field and then
calls the sink, which is now `write(CAMERA_LENS, lens)` — and `preferences.ts`'s `write`
announces **`resolve(preference)`**, not the value it was handed. So a value the _field's_
guard accepts and the _preference's_ `accept` rejects comes back as the **default** and the
binding clobbers the field with it.

Measured: `isUsableLens` is "finite and positive"; `isLens` additionally clamps to
`FOCAL_MIN..FOCAL_MAX` = `lensForFov(FOV_MAX=110)..lensForFov(FOV_MIN=20)`. So
`engine.requestLens(lensForFov(5))` leaves `engine.flightLens` at **65°**, silently, where
`origin/main` kept the 5° lens (React state held the raw value). Unreachable from the
shipped verbs — `riseFov` clamps to `[FOV_MIN, FOV_MAX]` and every `PICTURES.fovDeg` is 65
or 80 — and reachable from `window.engine`, which the field's own docstring names as the
case ("a capture script … reaches it without a storage predicate in the way").

**The check:** when a diff routes a field's writer through storage, put the field's
predicate and the preference's `accept` side by side and ask whether one is strictly
narrower. Then read `write` — if it announces the _resolved_ value, the narrower predicate
wins and the wider one is decoration.

## A table that becomes the one description needs a gate census, not just a green test

The band-stack refactor's `bandStack.test.ts` compares `stageOn(id, body)` against
`packedStageOn(pack, id)` over `terrainZoo` + Luna/Earth/Mercury. Count on/off per gate over
that fixture before believing it: `ice` 4/10, `drainage` 2/12, `craters` 12/2, `coast` 2/12,
`clamp` 1/13 — and **`tail` 14/0, `grit` 14/0**, plus **zero bare bodies**, so the
"packs a bare body as bare" case is `false === false` seven times. `grit`'s gate
(`gritRelief(grammar) > 0` = `0.45·(1 − 0.35·air)`) can never be false at all.

Widened to Sol + 80 catalog systems: 258 bodies, **214 bare**, `tail` off on 4 — so one gas
giant and one tail-free body arm all three rows. Same run: **0 disagreements** across every
gate, so the packer is faithful far beyond the fixture, which is worth not re-deriving.

**The generic check:** for any test that asserts "two spellings of a predicate agree over a
population", print the on/off counts per predicate. A row that is all-on is a row that would
pass against `() => true`.

## `Object.assign(host, extras)` keeps an accessor; the test for it usually cannot fail

`openSession` now returns `Object.assign(host, { harness, store, … })`. The `world` getter
survives because the source has no `world` key — proved in one line with
`Object.getOwnPropertyDescriptor(session, 'world').get`, and behaviorally with
`session.world !== before` after `harness.load(save)`. Both hold.

The assertion the branch added, `expect(partial.harness.world).toBe(partial.world)`, reads
the _same accessor on the same object_ twice and passes however the getter is built. The
property is really covered by the older load test, which compares `stateHash` before and
after. **When a diff changes how an object is assembled, ask what the new assertion would
say if the assembly were wrong** — an identity check across two paths into one object is
not it.

## The gate-substitution refactor: prove it with the two-revision sample loop, then check the version

`refactor/five-modules-deepened` replaced five inline conditions in `evaluate` with
`stageOn(...)` and `budget <= 0` with `bareGround(surface)`. `git archive origin/main`,
symlink `node_modules` **and each `packages/*/node_modules`**, import both `terrain.ts` by
absolute path: `elevationAt`, `drawnElevation`, `drawnGroundElevation` and `surfaceCoverAt`
were **bit-identical over 15,480 samples × 258 bodies**, so `TERRAIN_ALGORITHM` correctly
stayed at 3.

Trap in the loop: `bodyFixedDirection` needs a frame and throws on a bare vector — pass a
plain unit `Vec3` cast to the branded type for a sampling sweep.

Layering half, settled by reading imports rather than `pnpm graph`: `bandStack.ts` imports
`terrainKernel.ts` with `import type` only (erased), so the runtime edges are
`terrain.ts → bandStack.ts → micro.ts` and `terrainKernel.ts → bandStack.ts`, with no back
edge from `micro/craters/sketch/grammar/bands/cover/system` to `terrain.ts`. No cycle.

## The concurrent docs pass now reaches `.claude/agents/` — and still not a code comment

Sixth branch running. Mid-audit the tree gained `.claude/agents/invariant-auditor.md`
(rewriting this agent's own `world.entities.update` bullet — a finding I was about to file),
`docs/agents/invariants.md`, `docs/glossary.md` and `CONTEXT.md`. What it did **not** reach,
on a branch that deleted `SimulationClock.advance` and moved the store's write half:
`apps/game/src/scene/EngineTick.tsx:19` ("`SimulationClock.advance` already caps a step"),
`packages/devtools/src/harness.ts:1788` ("through `teleport` rather than `entities.update`"),
`packages/devtools/src/observatory.ts:716` ("the shell writes `engine.flightLens`") and two
test-file comments. **The pass sweeps markdown. Deleted identifiers hide in `.ts` comments,
and `rg` for the retired name across `apps/` and `packages/` is the whole check.**

## The fixture that makes a module's two named rituals into no-ops

Sharpest finding on `refactor/five-modules-deepened`'s final tree, and the shape
generalizes to every "the ritual is the whole trick" module. `groundWear.ts`'s
`anchorGround` does two things its docstring calls load-bearing: `Math.fround`
the anchor before measuring its altitude, and reduce the grain origin from the
**unrounded** anchor. `groundWear.test.ts` uses `buildPatch({bodyRadius:
1_737_400, region: regionAddress(0,0,0,0)})`, whose anchor is `(1737400, 0, -0)`
— **exactly representable in float32**, so `fround` is the identity on every
axis and `anchorAltitude` is exactly 0. Deleting either ritual passes the whole
file. `materials.gpu.test.ts` uses the same fixture, so the GPU suite cannot see
it either. The `toBeLessThan(0.25)` bound is unexercised for the same reason: the
rounding it bounds is zero.

**The check:** for every constant in a test fixture, ask whether `Math.fround(x)
=== x`. A round metric radius on a cardinal axis almost always is. An arming
fixture is one off-axis Earth anchor: `x = y = z = 6371000/√3 = 3678298.565…`
gives `anchorAltitude` **−0.1126 m** with the fround and **9.3e-10** without,
and moves the grain origin by 0.065 m — a tenth of `GRAIN_METRES`.

Same file, same class: line 90's `expect(wear.anchorAltitude).toBe(hypot(ax,ay,az)

- LUNA)` restates the implementation on both sides. It is only line 93's
  independent bound that could ever fail, and the fixture disarms that too.

## A rock's datum and a patch's datum are two fields with the same name

`body.radius` and `body.surface.radius` **differ** for any generated body with a
`figure`: `system.ts:714` is `radius: shape?.radius ?? radius` while
`makeSurface(..., { radius })` above it takes the pre-shape one. Sol bodies agree
(`radius: body.radius`, surface built from the same). The terrain material's
`datumRadius` uniform is `TerrainState.datumRadius` = `surface.radius`
(`terrainStreamer.ts:896`), so `anchorAltitude` must be measured against
`surface.radius` and not `body.radius` — which is what the branch's
`anchorGround(mesh, anchor, state.datumRadius)` fixes and what
`scatterField`'s deleted `anchorAltitude` (`− body.radius`) got wrong for figure
bodies. **When two call sites subtract "the radius", check which of the two they
took.**

## `world.entities` as a read view: what actually enforces it

`EntityView` is a getter's declared type over the real `EntityStore`, so
`update` still exists at runtime and a console/`.mjs` caller can reach it.
`AGENTS.md` says "there is no `update` to reach for"; `entity.ts`'s own docstring
says "no such door **on the type**", which is the precise claim. The enforcement
that can fail is `world.test.ts`'s
`expectTypeOf(world.entities).not.toHaveProperty('update')` — and it is armed:
expect-type 1.4.0 types `not.toHaveProperty` as `(key, ...MISMATCH:
MismatchArgs<Extends<KeyType, keyof Actual>, false>)`, so a present key demands a
`never` argument, and the root `tsconfig.json` `include: ["packages/*/src"]`
covers `.test.ts`. **Read the expect-type signature rather than trusting a
type-level assertion, and confirm the tsconfig includes the test file.**

## A new "never derive a stored value from a captured snapshot" rule, and the file the sweep missed

Sixth instance of "a branch that adds an invariant violates it once". A
concurrent session added `AGENTS.md` "Never derive a stored value from a captured
snapshot" + `.claude/rules/react-shell.md` + an `invariants.md` row after fixing
`GraphicsPanel`'s four `setSurface({...surface, x})` to the updater form. What it
did not sweep, and it is the sibling panel: **`hud/LensSlider.tsx:50`**
`camera.onLens(spec.at(camera.lens, scrub))`, where `camera.lens` is
`LensSection`'s captured `usePersistentState(CAMERA_LENS)` and `spec.at` keeps the
other three channels. `LensSection` is the one preference explicitly drawn in two
simultaneously-mounted places — the planetarium dock's `CameraPanel` and
`/settings/camera` over it — which is the exact pairing the new bullet's own text
names. Also `pages/ControlsSection.tsx:98` (`{...overrides, [id]: chord}`) and
`:111`, and `planetarium/CataloguePanel.tsx:306` (`setFiltering(!filtering)`).
Clean: `dock/useWorkspace.ts` is updater-form throughout; `firstLight.ts`'s
`{...store.getState()}` is a live read, not a snapshot.

**The grep:** `rg -n "usePersistentState\(" apps/game/src` for the mounts, then
read every writer of each object-or-boolean-valued one.

## `.claude/settings.json` deny rules are part of the diff, and the justification is checkable

`refactor/five-modules-deepened` removed `Read(./.env)` / `Read(./.env.*)` from
the deny list (a bare `rg` resolves as a read of `.` and the deny beat the
`Bash(rg:*)` allow, one dialog per search — a real cost, especially to subagents).
The `CLAUDE.md` paragraph justifying it says the two files under `apps/game/` are
"a GA measurement id and a committed example". Only `.env.example` is tracked;
`apps/game/.env.production` is **present on disk and gitignored**, and
`.gitignore:18-20`'s own comment says the id is deliberately kept out because
"this repository is public". **Check a permission-relaxation's stated premise with
`git ls-files` and `git status --ignored` — never by reading the file.**

## What came back clean on the final `refactor/five-modules-deepened` tree

Worth not re-deriving. `pnpm graph` (12 packages, layering intact), `typecheck`,
`lint`, `format:check`, `docs:build` (1269 pages), `presets:check`, `brand:check`
all green; `pnpm test` 98 files / 1585 passed / 4 skipped in 7.0 s;
`pnpm sim --self-test` 12/12, save 998 bytes.

- `bandStack.ts` has **zero runtime imports** (all four `import type`), so
  `terrain.ts → bandStack.ts` and `terrainKernel.ts → bandStack.ts` add no edge.
  `d9147a8` dropped the last one (`gritRelief` from `micro.ts`).
- `bandStack.test.ts` is now armed: the "every gate takes both answers" census
  test is the thing my earlier note asked for, and Venus/Phobos supply the
  tail-off and bare-budget rows.
- `renderHost()`'s defaults reproduce every previous `?.() ?? x` exactly:
  `framingLens → LENS_PRESETS.flight`, `pixelRatio → 1`, the rest null/no-op.
  `Object.assign(host, extras)` keeps the `world` getter (source has no `world`
  key), and `devtools.test.ts` now proves it by replacing the world.
- `three` r182's `UniformNode.onUpdate` does `this.value = value` — an
  assignment, never an in-place `copy` — so `wear.ts`'s `Object.freeze`d
  `UNDRESSED_GROUND` vectors are safe as uniform values.
- All 13 removed `entities.update` call sites went to a verb or a spawn
  argument; no write half remains outside `World`. `stateHash` already carried
  `control` and `flightAssist`, so `EntityInit` gaining them adds no field.
- Mirror discipline complete for the entity-write amendment, including the
  path-scope half that used to fail: the bullet went into
  `.claude/rules/packages.md` (`packages/**/*.ts`), which is what actually covers
  `packages/persistence` and `packages/devtools` — `determinism.md`'s scope does
  not. Both `.cursor/*.mdc` globs still equal their `paths:`.
- No new `Math.random`/`Date.now`/`performance.*`/`localStorage`; no `three` in
  `packages/*`; no bare `three` in `apps/game`; no `text-slate-500`; no
  `'use no memo'` directive added or removed; no plan under `docs/`; the two new
  `docs/agents/invariants.md` rows point at a heading that exists
  (`architecture.md#invariants`, line 332).
- Glossary figures check out: `MIN_DISTANCE_RADII = 1.5`, `MIN_STANCE_HEIGHT = 2`,
  and the `RenderHost` member list matches `harness.ts` in order.

## The version bump is argued for the field the author thought about, and one other field moved

Richest finding on `feat/terrain-v4-and-the-baked-relief`, and a new shape: the
branch **did** reason about whether to bump `SYSTEM_ALGORITHM`, in a whole
`CONTEXT.md` paragraph ("No version is spent. The polar radius is presentation…"),
and the reasoning is _correct for `polarRadius`_ — `datumRadius` (`terrain.ts:846`)
returns `body.radius` whenever `figure === null`, and a figure body takes
`shape.polarRadius`, so the generated flattening never reaches the canonical field.
What no paragraph covers is the field a **different commit on the same branch**
changed: `planetTilt` at `system.ts:904`/`:1532`. `axialTilt` is not presentation —
`frames.ts:222`'s `spinEvaluator` builds the body-fixed frame's orientation _and_
angular velocity from `axialTilt` and `rotationPeriod`.

Measured, `git archive origin/main` + per-package `node_modules`, 400 catalog stars /
6,496 generated bodies: **1,515 `polarRadius`** (up to 16.4% of the body's own
radius), **142 `axialTilt`** (max 0.72 rad = 41.2°), **1 `rotationPeriod`** (1.37×) —
with `SYSTEM_ALGORITHM` still 3. `world.stateHash()` cannot see it (a landed entity's
numbers are body-frame-relative and unchanged), and `versionDrift` reports `system@3`
on both sides, which is exactly "two builds disagree about one address space with
nothing to notice".

**The check on any branch that argues a version:** the argument names one field. List
_every_ field the branch writes into a generated `Body` — `git diff origin/main...HEAD --
packages/universe/src/system.ts | rg '^\+.*(axialTilt|rotationPeriod|polarRadius|radius|mass):'` —
and diff the whole body record across revisions rather than the field the prose
discusses. The commit that moved the extra field is usually the _last_ one, landing
after the version paragraph was written.

Corollary that also fired: `design/plans/rings.md`'s "The seam" says "the character
draw touches nothing in `packages/universe` … no version is spent", in the same commit
that edits `packages/universe/src/system.ts`. A "the seam" / "what this does not touch"
section in a plan is a `--stat` you can run.

## `surfaceDetailFloor` moves in both directions, and the zoo is four bodies

`MAX_CRATER_LEVELS` 11 → 14 carried a docstring saying Mercury's floor goes "from 14 to
16" and "600 patches to 1,250". Measured `surfaceDetailFloor` both revisions: Mercury is
**16 at cap 11 and 15 at cap 14** — the direction is reversed and both endpoints are
wrong. `CONTEXT.md` in the same commit says "a floor of 15", which is right; the
docstring carried the pre-tail figure verbatim through its own rewrite.

The generalisation is the other half: "Measured across the zoo the detail floor does not
move" is true of the zoo's four members (Gliese 1061 d 19→19, Gliese 1061 IV 17→17,
Iapetus 14→14, Miranda 12→12) and false on 8 of 192 Sol+fixture bodies — **Earth 15→17**,
Proxima Centauri II 14→16, Alpha Centauri IX b 10→12, Mars 15→16, Barnard's b/c 16→17,
Sirius I 17→18, Mercury 16→15. The probe is ten lines: import both `terrain.ts` by
absolute path and call `surfaceDetailFloor(body.surface)` over `walkBodies`.

## A published-value table for Sol keyed by issue ordinal: run the loop, then check the _contents_

`proceduralRings.ts`'s `PUBLISHED` maps seven `g:milky-way/s:SOL/b:N` strings to ring
characters, and `proceduralRings.test.ts` holds the key set equal to the mapless ringed
bodies both ways. That test cannot see a **swap** (Chariklo's character on Chiron's
address). Verified by hand: b:4 Jupiter, b:6 Uranus, b:7 Neptune, b:11 Haumea, b:13
Quaoar, b:53 Chariklo, b:54 Chiron — all match their comments. Also verified the second
test is armed: without the lookup, `hash('ice-giant:g:milky-way/s:SOL/b:6')` draws
`mixed`, not `threads`, so the >0.7-clear assertion would fail.

Same file's plan opens "Nine bodies in Sol carry a ring system"; measured **8**
(the seven plus Saturn). A count word in a plan's first sentence is one loop away.

## Two moment-of-inertia accuracies, and the doc quotes the one no generated body gets

`rotationalFlattening(mass, radius, period, C)` reaches Jupiter/Saturn/Earth/Neptune
within 1.25/0.46/0.24/3.56% **with each body's own published `C`** and within
6.63/7.32/7.09/3.56% **with `momentOfInertiaFactor(kind)`**, which is what a generated
body gets. `universe.test.ts` encodes both correctly (5% own, 10% class); the CONTEXT
entry gets it right; `docs/concepts/rendering.md` writes "with a moment of inertia factor
for their class, which reaches … within 5%", conflating them. **When a branch ships two
accuracy bounds, grep the published doc for the tighter number.**

Clean on the same change, worth not re-deriving: the 0.42 Jacobi clamp is unreachable —
0 bodies at it over 600 catalog stars, max generated flattening 0.152 — and
`hydrostaticSpinFloor` holds over the whole 150 ly catalog (5,089 giants, 0 violations of
the floor or of the 0.14 bound the test asserts).

## What came back clean on `feat/terrain-v4-and-the-baked-relief`

- `pnpm graph` (12 packages, layering intact), `pnpm typecheck`, `pnpm test` on the two
  new plain-Node files (51 passed), `pnpm test:gpu` **41 passed / 8 files, 18.4 s** —
  which is 20× `.claude/skills/drive/SKILL.md:27`'s "~1s".
- No `three` in `packages/*`, no bare `three` in `apps/game`, no new
  `Math.random`/`Date.now`/`performance.`/`localStorage`, no `text-slate-500`, no new
  `as BodyFixedDirection`, no `entities.update`.
- The two-texture-nodes-over-one-stand-in invariant is respected everywhere else:
  `createPlanetMaterial` has seven distinct stand-ins (`WHITE`, `FLAT_NORMAL`, `BLACK`,
  `CLEAR`, `RING_WHITE`, `BLANK_REFLECTANCE`, `BLANK_RELIEF`); `createCloudMaterial` and
  `createRingMaterial` each hold one `texture(WHITE)` in their own program, which does not
  collide. The `.claude/rules/rendering.md` mirror was swept in the same commit.
- The bake frame is consistent: `terrain.ts`'s `bakeNorth = normalize(Y − up·up.y)`,
  `bakeEast = cross(bakeNorth, up)` in body-fixed axes reproduces `planet.ts`'s
  `north = axis − geometric(axis·geometric)`, `east = cross(north, geometric)` in world
  axes, and the slope is taken from `normal` (line 452, the mesh normal) rather than
  `shaded` (line 898, the bumped one), which is what its docstring claims.
- Ring photometry: `RING_ALBEDO` scales `single` and `transmitted` alike, so the
  lit/backlit crossover the GPU test holds really does not move. Mip filtering does not
  fork the program (`isUnfilterable` is nearest+nearest only).
- `MAX_KERNEL_LEVELS` 15→18, `SLAB_AT` 52→56, `KERNEL_WORDS` 116→132, `TILE_FRAMES`
  17→20; the new "fifty-six, two words to spare" is right. `CONTEXT.md`'s "from 48" is not.
