# ADR-0019: Terrain is a grammar, a sketch and a band stack

Status: accepted · 2026-08-28

## Context

[ADR-0015](0015-terrain-level-of-detail.md) gave the terrain a quadtree that
holds together from orbit to two meters. What it holds is three bands of noise:
continents, a ridged mountain layer masked by them, and a detail octave. Three
bands is the smallest number that reads as a planet rather than as noise, and it
is also the largest number that can read as anything _in particular_. Mercury
and Titan came out of it as the same rolling fBm at different amplitudes.

Every world in the game is drawn from `SurfaceParameters`: a seed, a peak
elevation, a base frequency and an optional sea level. Nothing in that record
knows whether the body has air, how hard its primary flexes it, or what it is
made of — so nothing downstream could either. The relief itself was
`radius × rng.range(0.0005, 0.004)`, a dial with no physics in it, which put as
much relief on a fifty-kilometer rubble pile as a fraction of its own size as on
Mars.

The milestone is "rich terrain from orbit to on foot"
([roadmap § terrain](../roadmap.md#terrain)), and the design bible already
commits to derived biomes and rock scatter
([content § terrain](../design/content.md#terrain)). Both need a surface that is
_about_ the body it is on.

## Decision

**Three layers, and each one is a different kind of thing.**

```
body facts  ──►  SurfaceGrammar  ──►  terrainSketch  ──►  elevationAt
seed        ──►  (which bands,       (plate nuclei,      (per-sample,
                  how loud)           hotspots,           pure, order-
                                      crater ladder)      independent)
```

**`SurfaceGrammar` is derived from facts, not drawn from a dial.** Surface
gravity from mass and radius; bulk density from mass and volume; atmospheric
column mass as `ρ·H`, which is `P/g` and lands Earth at 10,200 kg/m² against a
measured 10,330; equilibrium temperature from the star and the orbit; a
tidal-heating proxy from the primary. Everything else is written against those:
crater retention falls as `(1 − air)^1.5 · (1 − young)`, the simple-to-complex
crater transition is `29,000/g` for rock and an eighth of that for ice, ice
relaxes in proportion to how warm it is. The seed enters only where the answer
is genuinely arbitrary — how many plates a mobile-lid world happens to have, how
many hotspots, how much ocean floor.

It rides on `SurfaceParameters` rather than being looked up, because
`elevationAt` runs in a worker and a worker has no system, no star and no parent
planet. It is plain data for the same reason: it crosses a structured clone.

**`maxElevation` is a grammar output.** Peak relief is bounded three ways and
the tightest wins: material strength as `σ/(ρg)` with σ = 3.2 × 10⁸ Pa
calibrated on Olympus Mons; nine percent of the body's own mean radius,
calibrated on Vesta's Rheasilvia peak; and twenty-two kilometers, which is the
largest relief measured on any body in the Solar System and is the same number
on Vesta and on Mars four orders of magnitude of gravity apart. Each binds on a
different class of body — strength on the planets, size on the small moons, the
ceiling on Luna, where strength alone would allow fifty-nine kilometers.
Published relief overrides all three: Olympus Mons really is 21.9 km and the art
doctrine says the data is not negotiable.

**`terrainSketch` is the coarse structure a per-sample function cannot
express.** Plate nuclei with drift directions, a hotspot list, the crater
field's lattice ladder. Kilobytes, derived from the seed and the grammar in a
fraction of a millisecond, and memoized twice over because the two layers answer
different questions: a string key of what the derivation reads, because a
heightfield worker rebuilds a fresh `SurfaceParameters` from its payload on
every task and a `WeakMap` alone would derive a new sketch per patch; and a
`WeakMap` in front of it, because `elevationAt` resolves the sketch per
_sample_ and building that string 4,761 times a patch is 1.7 to 2.5 ms of
formatting a key that cannot have changed. It is regenerable content and
therefore a cache, never a save (ADR-0005).

**Plate identity is a spherical Voronoi diagram over the nuclei, and it is read
as a partition of unity rather than as a ranking.** `F2 − F1` is zero on a
boundary and grows inward, so the distance-to-boundary field the belts need
falls out of the same search that names the plate — that much is a _value_ and
is continuous everywhere. What is not is the _identity_ of the plate holding
`F2`: it changes discontinuously along the locus where the second and third
nearest are equidistant, which is a network of curves through every plate's
interior, nowhere near an edge. Anything reading a property off "the neighbor"
inherits that jump: 1,532 m of step on Proxima Centauri II and 3,081 m on Earth,
out of relief budgets of 20 and 10 km.

So a sample carries _every_ plate within a quarter-radian of the nearest, and a
band reads a property as a weighted average over all of them, normalized, with a
weight that reaches zero at its own margin. No rank identity enters, so
continuity is by construction rather than by a blend that has to be got right —
the same argument the crater lattice makes about the cube corner. `convergence`
is weighted over _pairs_ for the same reason. The weight is `(1 − s)/(1 + s)`,
which is exactly what the two-plate blend it replaces was already spending, so
where only two plates are in range the field is unchanged; the plain complement
smears Earth's elevation histogram until it stops reading as bimodal.

**The band stack replaces the three bands.** Hypsometry from plate identity,
tectonic belts from the boundary type, volcanic edifices from the hotspot list,
crater fields, and a derivative-damped domain-warped fBm carrying everything the
named features do not explain — plus chaos, sulci and tiger-stripe troughs where
the tide is still working the shell. Every band except craters returns roughly
[−1, 1] and is scaled by its **share** of the relief budget; the shares sum to
one, so the stack is bounded by the peak the strength limit allows and no band
can grow past its allowance.

Craters work in meters, because their shape is published in meters, and are
folded through `limit · tanh(x/limit)` on the way in. Saturated ground has three
or four craters on top of each other everywhere, and summed unbounded a basin
inside a basin goes through the mantle; a hard clamp would flatten the deepest
and most interesting ground into a plateau.

**Crater placement is a cubic lattice in ℝ³, not the cube-sphere's own grid.**
The cube grid is the obvious choice and it is wrong: a crater straddling a face
edge has to hash identically from both faces, and at the eight points where
three faces meet a cell has _seven_ neighbors rather than eight, so a ring walk
counts one of them twice and that crater comes out at double depth, on every
world, at eight places. A lattice of cubes in ℝ³ intersected with the unit
sphere has no seams and no corners: a cell is `floor(d · s)` whoever is asking.

The cost is a three-dimensional neighborhood instead of a flat one, and **how
wide it has to be is derived rather than written down**, because the ±1 walk it
started as could not contain the field it was placing. Two displacements
separate a crater's cell from the sample's and they are perpendicular: the
ejecta reach, which is 1.3 cells because a level's largest crater has an angular
radius of half a cell; and the radial slop, because the lattice is cubes and the
field is a shell cutting through them, so a crater's center sits off the sphere
by up to the cell's own width along the radius and is indexed there. A crater
the walk cannot see is not a missing crater, it is a step — it appears at full
apron height the moment the sample crosses into a cell that can see it. About
five cells an axis, against three, and it is most of what a patch costs.

**One field, at every level.** Nothing in the stack knows what patch is asking
or how closely it is sampling. That is not a missed optimization. The CDLOD
morph lands a child's vertices on its parent's grid, so a fully morphed child is
the child's _own field_ sampled at the parent's spacing — which equals the
parent's mesh only if both evaluate the same function. Two patches with
different detail floors differ by every feature between them, and at level 12 on
a lunar-sized body that is eight meters of pop at the handover. The early-out is
in the octave counts and the ladder depth, which are properties of the **body**:
a fifty-kilometer moon evaluates four octaves where an Earth-sized world
evaluates twelve, because it runs out of world first.

**The canonical field stops at 8 m of wavelength and half a meter of
amplitude.** Below that, detail is synthesized at render time and may differ
between backends by design. This is the same shape of honesty as the figured
body's datum: the divergence is bounded, named and measured rather than denied.
A landing ship spans tens of meters. When on-foot arrives the floor drops and
the canonical cost is re-measured, and that is a version bump named in that
phase.

**Terrain moves to algorithm version 2, once.** Every solid body's ground moved;
the loader already knows how to say "this save was written with terrain v1"
(ADR-0005). The phases after this one refine presentation and leave the
canonical field alone, precisely so the ground moves under saves a single time.
`SYSTEM_ALGORITHM` deliberately does not move with it: `makeSurface` draws the
same three values in the same order from the same stream — the first has changed
meaning, not position — so every other property of every body in the galaxy is
exactly where it was.

## Alternatives considered

**Stateful erosion simulation.** The look this buys is real and the method
cannot be. Hydraulic erosion is order- and resolution-dependent: two patches of
the same ground at different levels, or the same patch generated after a
different neighbor, produce different answers, and a terrain whose value depends
on who asked first cannot be a pure function of an address. The _look_ is bought
analytically instead, with derivative-damped fBm
([Quilez](https://iquilezles.org/articles/morenoise/)) — each octave attenuated
by how steep the sum already is, which is what running water and mass wasting
actually do to a landscape, at one divide per octave. Deferred as a possible
_offline_ pass over a sketch, where it would be a per-body derivation rather
than a per-sample one.

**Per-patch detail floors.** Free LOD control: an orbital patch does not pay for
boulder-scale craters. It breaks the morph, for the reason above, and the pop is
largest exactly where the plan promised none. Rejected, and the ladder cap is
what bounds the cost instead.

**Sizing the largest crater so its depth equals the crater band's share.** The
obvious inversion, and it produces a Mercury whose biggest crater is 33 km
across. The depth law saturates hard — past the transition, depth grows as
`D^0.3`, so a basin thirty times wider is only three times deeper — which means
inverting at the budget throws away two orders of magnitude of diameter to save
a factor of three in depth. Sizing at three times the budget and letting the
soft ceiling fold the depth back gives a thousand-kilometer basin 2.4 km deep,
against Caloris's measured 1,550 km and ~3 km.

**A step at `ICE_ROCK_DENSITY` for every icy behaviour.** The archetypes are a
classification and the geology is continuous: Callisto (1,834 kg/m³) and Titan
(1,881) are two thirds ice while Europa (3,013) is a silicate body with an ocean
on it, and a step at 2,000 says they are the same thing. The four archetypes
remain the coarsest output of the grammar rather than a second opinion —
`classifySurface` is the one implementation and both call it — and everything
else reads a ramp.

**A `WeakMap` on `SurfaceParameters` for the sketch.** The natural cache for a
derived value, and it derives a fresh sketch for every patch: the worker
reconstructs the surface from its payload each time, so no two tasks share an
object. Keyed by what the derivation reads instead.

## Consequences

**Every body in the galaxy looks like itself.** Mercury comes out saturated with
craters, one lid and no soft edges; Earth with twenty-two plates, orogens along
their margins and almost no craters; Venus the same size as Earth and a stagnant
lid, because it has no ocean and water is the leading explanation for why one of
them subducts; Enceladus with four parallel fractures across a shell nothing has
had time to hit.

**A patch costs 9 to 37 ms where it cost 12.8**, measured across the zoo:
8.8 ms on Miranda, which has no craters at all, 32.3 on a rocky airless world,
35.9 on Iapetus and 37.3 on a rocky atmosphered one, where the erosion damping
reads the analytic gradient. Two unrelated wins pay for part of it. Flattening
the gradient table in `noise3` from an array of triples to three `Float64Array`
lanes took it from 209 ns a call to 47, so the three bands this replaces would
now cost 3.6–3.8 ms. And `gradientAt` — eight calls per `gradientNoise3`, up to
twelve octaves a sample, the innermost thing in the stack — hashed with `pcg3d`
and read one of the three lanes it returns, which V8 never scalar-replaced. It
hashes with `noise3`'s own `hash3` now, written out rather than called because
two levels of call at eight sites exhausts the inlining budget: 59.7 ms on the
atmosphered world became 37.3.

**That hash was also a correctness bug, and the more expensive one.** `bands.ts`
picks between `ridged3` and `ridgedField` on whether a world erodes, on the
stated grounds that the two give the same number; hashing the gradient lattice
with `pcg3d` where `noise3` uses `hash3` made them different _fields_, separated
by up to 1.25 on a band whose contract is [-1, 1]. Two worlds a pascal apart got
unrelated mountain ranges rather than the same ones slightly more worn. They now
agree to twelve decimals, and `field.test.ts` holds them there.

**The crater neighborhood is the spread, and containment is what it buys.**
Sizing the walk to the ejecta reach and the radial slop took an airless patch
from 17.5 ms to 28.3 while removing a step of up to 158 m from about 30% of
directions. Two levers remain and both are deliberate not-yet: the radial bound
is the cube's full width where the worst case measured over six bodies is 1.36
of 1.73, and `EJECTA_REACH` is 2.6 where the published continuous ejecta deposit
is often mapped to 2. This is well past the condition for moving the GPU
producer from "adopt if the measurements say so" to a scheduled piece of work
([ADR-0023](0023-the-gpu-producer.md)).

**`surfaceDetailFloor` moved from 7–10 to 10–16, and everything downstream moved
with it.** Crater rims are sharp — a rim is about a seventh of its crater wide —
so resolving one to half a meter takes samples seven times finer again. A
whole-disk selection costs about ninety patches per level between the horizon
and the ground, so the extra levels underfoot took it from 410–480 patches to
380–862; `DEFAULT_MAX_PATCHES` went from 768 to 1,024 so that the cap stays a
safety net rather than a working limit, at 208 MB of vertex buffers in the
corner case. The streamer's per-frame request budget went from 8 to 24 for the
same reason: the ladder is strictly serial — a level cannot refine until all
four children of every node on it have arrived — and a landing that used to
sharpen in eighty frames wanted two hundred and fifty.

**The crater ladder's depth is the dial that connects those two.** It is capped
at fourteen halvings, so a body's finest crater is an eight-thousandth of its
largest — 134 m on Mercury, 95 m on Luna, 13 m on Callisto. Four decades of
crater diameter carry a body from orbit to the last thing the mesh resolves;
below that is the micro-relief tail [ADR-0021](0021-the-ground.md)
synthesizes rather than meshes, and it is the tail rather than the ladder
that sets the detail floor on every zoo body. The cap was eleven until
terrain algorithm v4, and `MAX_CRATER_LEVELS` carries the measured cost of
the three rungs.

**The dossier has a geology card.** The grammar is a claim about the _place_ —
how hard a mountain can stand on it, how saturated it is, whether its
lithosphere moves in pieces — and it is written in the universe's voice like
every other row on that panel (ADR-0014). What is not known is still marked not
known: nobody has flown the crater-count survey that would date the surface, and
no lander has taken a sample.

**A save written before this points at different ground.** That is what the
version bump is for, and doing it once is why the geology is one phase.

**One file imports its primitives through a namespace, and the comment says
why.** Vite's SSR transform — which is what `vitest` runs, and what nothing else
in this project does — rewrites every reference to an imported binding into a
property read on a module-namespace object. `craters.ts` reads four of them per
crater cell over a million cells a patch, which put a patch at 98 ms under the
test runner against 20 under Node's own loader. Destructuring the namespace once
brought it to 25. It is a rename rather than a copy, it is worth it in exactly
that one file, and it is recorded because the obvious reading of it is that
somebody was avoiding an import.

## Related

- [ADR-0005](0005-procedural-seeds.md) — the seed regime this is a pure function of
- [ADR-0015](0015-terrain-level-of-detail.md) — the quadtree this fills
- [ADR-0017](0017-the-lens.md) — the optics every patch count here is measured through
- [Streaming](../concepts/streaming.md) · [Rendering](../concepts/rendering.md)
- [Content § terrain](../design/content.md#terrain) — what the surface has to produce
- [`CONTEXT.md`](../../CONTEXT.md) — the measurements
