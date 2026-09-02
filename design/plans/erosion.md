# Erosion — the rivers, and what the liquid owes

The liquid phase ([ADR-0026](../../docs/adr/0026-the-liquid.md)) put a sea on
the ground, valleys in it and a coast between them, and bought the frame back
at a retina size. What it did not do is make a river. This page is the plan
for the phase after it: **erosion**, which is the concept the rivers are
missing; the **tradeoffs** that phase made for the frame, each with what it
cost and when to revisit it; and the **defects** it left, ranked.

It is a plan, so it promises. When a phase lands, its decision moves into an
ADR and the section here goes; cite the ADR, not this page.

| Reads with                                                | For                                                |
| --------------------------------------------------------- | -------------------------------------------------- |
| [Terrain — what is left](terrain.md)                      | The milestone this is a phase of, and its § 5 seam |
| [Perf](perf.md)                                           | The frame's figures outside the two surfaces       |
| [ADR-0019](../../docs/adr/0019-the-geology.md)            | The band stack the graph would sit in              |
| [ADR-0023](../../docs/adr/0023-the-gpu-producer.md)       | The kernel every canonical band is ported to       |
| [Content § terrain](../../docs/design/content.md#terrain) | What the bible asks a river to be                  |

**Where the numbers come from.** The frame figures are the drive rig at
1920×1200 over a device pixel ratio of 2 — 9.2 million pixels — on Gliese
908 IV at the sunlit shore (latitude 6.6°, longitude −46.4°), in daylight,
which is the rule for judging terrain. The band figures are `pnpm test:gpu`
and the unit suites. Run-to-run variance on the frame is about two frames a
second; a figure taken beside a test run is a figure about the test run.

---

## 1. What is wrong with the rivers

The valleys are the zero-level strip of a noise. `valleyField` in
`packages/universe/src/bands.ts` takes a three-octave fBm at 24 cycles round
the body, bends it by a warp, and returns `1 − |n| · 2.6`; the tributaries are
the same construction at 74 cycles on their own seed, unwarped. That gives a
network of curves that branch, meander and never end on a plain — which is
what a river looks like from orbit and why the phase took it. Everything it
gets wrong follows from the one thing the strip does not know: **which way is
downhill.**

- **A channel's floor is the landform minus a cap.** `drainageCarve` cuts
  `0.13 · budget` at most, shallowed by `1 − e^(−0.85 · aboveDatum / deepest)`
  toward the datum. The floor therefore follows whatever the plates and the
  swell put there: along its own length a river runs uphill, downhill and
  uphill again, and at ground level it reads as a chain of ponds in a trench.
  A river's floor is a datum _along the channel_, monotone to the sea, and
  the ground is cut to it; the cap has it the other way round.
- **Two noises do not make a tree.** The tributary field is independent of the
  trunk field, so a tributary crosses a trunk at any angle, crosses a divide
  as readily as a valley, and is the same width at its head as at its mouth.
  Discharge grows downstream and every hydraulic width grows with it —
  `w ∝ Q^0.5` is the oldest figure in fluvial geomorphology — and nothing in
  a strip carries a discharge.
- **The mouth is a remap.** `coastRemap` flattens the landform toward the sea
  datum inside a band of `0.1` of the hypsometry share, whichever way the
  ground came in. A valley meeting the sea is a delta where the river carries
  sediment and a ria where the sea rose into it; both are shapes, and the remap
  has one shape, a shelf.
- **A lake is wherever the ground is under the sea datum.** The sheet is drawn
  at one level per body, so a crater floor below datum three thousand
  kilometers inland holds water at sea level — the flooded craters in the
  plates are that, and they are right by accident. A basin's water stands at
  its own spill level, which is a graph property, not a datum.
- **Wet is a strip, not a flow.** `channelWetness` is the top 0.7% of the strip
  field, so every channel is the same thread of `wet` cover, painted on its
  bed at one colour. The material has no flow direction to advect a wave
  along, no width to draw a sheet across, and the `biota` band does not know
  a river is there — a riparian corridor is the most visible thing a river
  does from orbit and there is none.
- **The slopes are noise.** Between the valleys the ground is fBm: no gullies
  on a hillside, no talus at the foot of a scarp, ridges rounded the way a
  noise crest is rounded rather than sharpened the way running water leaves
  them. The "erosion look" is a per-pixel matter and the phase spent its
  per-pixel budget on the gradient fetch.

The common cause is that erosion is a process with a direction and the field
is a function with none. The plan is not to run the process on the planet; it
is to run it once, coarsely and deterministically, per body, and let the field
_read_ the result the way it already reads the plates and the crater ladder.

---

## 2. The shape of the answer

Three tiers, each bounded, each a function of the seed.

### 2.1 The drainage graph is a generation product

A body's rivers are a **graph**: nodes on a coarse sphere lattice, each with
an elevation, a receiver (the neighbour it drains to), an upstream area, a
Strahler order and a spill level; segments between them carrying a floor
elevation at each end that never rises downstream. It is built once per body
from the macro landform — the plate, swell and hypsometry bands are cheap at
lattice spacing — and the sea datum, and it lives in the `TerrainSketch`
beside the plate set and the crater ladder, because that is what it is: a
derived, regenerable, per-body structure the field samples.

The build is a fixed sequence, and every step of it is on the CPU in float64,
because the canonical ground has to be computable wherever the contact test
runs and a GPU's atomics do not order themselves:

1. **Lattice.** The cube-sphere at `6 × 128²` — 98,304 nodes, a cell of about
   78 km on Earth and 8 km on a Luna-sized body — sampled from the macro bands
   only. The lattice is the same face-and-cell frame the crater ladder uses,
   so the kernel already knows how to find its cell in integers.
2. **Depressions.** Priority-flood from the sea (Barnes 2014) assigns every
   node a spill level and a receiver; a node under its spill level is a lake
   floor and the spill level is the lake's datum. On a dry world the flood
   starts from the lowest cells and every basin is endorheic, which is what
   Mars looks like. This step is not optional: every stream-power scheme in
   the literature that skips breaching traps its water in pits and erodes only
   at the first cliff (§ 8).
3. **Accumulation.** Upstream area `A` by one pass down the receiver tree;
   Strahler order and discharge `Q = p·A` from it. Hack's law and the Horton
   ratios fall out and are the test.
4. **Incision.** The steady-state stream-power profile, in closed form rather
   than time-stepped: up every river path from its mouth,
   `z(x) = z(0) + ∫₀ˣ u(s) / a(s) ds` with
   `a(s) = k·A(s)^m + (k_h / C)·A(s)^(−h)` — Tzathas et al. 2024, the fluvial
   term and the hillslope term folded in through Hack's law. One pass up the
   tree, order-independent given the tree, tens of thousands of nodes in a
   millisecond. The uplift `u` is the geology's own: the orogens and the
   hotspots are where the ground rises, so the belt and volcanism bands _are_
   the uplift field. The erodibility `k` reads the crust — a hardness field
   from the same sketch, which is also what keeps the network from looking
   self-similar at every scale. Where a body wants a landform still moving
   rather than at equilibrium, a fixed count of Braun–Willett implicit steps
   from that profile is the bounded, deterministic extension; it is not the
   default.
5. **Refinement is Dendry.** A trunk at 78 km spacing is the Mississippi; a
   stream a walker stands beside is not on that lattice. Below the lattice the
   network is Gaillard et al.'s construction: at each level a grid twice as
   fine, a jittered key point per cell, level 0 joining each key point to the
   neighbour that minimises the **control function** — which is the incised
   lattice's own elevation, the case the paper's Figure 15 demonstrates from a
   16×16 downsample — and each finer level joining its key points to the
   nearest existing segment. A segment's slope is Flint's law, its junction
   angle Howard's `cos α = S_m / S_n`. The construction for a cell depends on
   the cell's seed, its ring and its ancestors, never on a sibling: that is the
   quadtree's own order-independence argument. It is cached per
   (body, cell, level) the way tiles are, and what is cached is **segments**,
   so a sample pays a distance to a bounded list rather than the paper's
   per-point tree walk — 40–250 µs a point on a CPU, which is why Dendry as
   written is not a per-sample band and as cached is the crater walk's shape.

The output the field reads is **segments in cells**: for every lattice cell at
every graph level, the bounded list of segments crossing it or its ring, each
with two endpoints, two floor elevations, an order, an upstream area, a
channel width and a valley half-width.

### 2.2 The field reads the graph, and the carve is a floor

`elevationAt` keeps its shape — a pure function of a direction — and the
drainage band changes from a strip to a lookup: the sample's cell at each
graph level from the trunk down to the level its spacing supports, the
segments those cells hold, and for each the distance to the segment, the
floor elevation interpolated along it, and a **profile** of that distance in
the segment's own width. The ground becomes

```
ground = min(landform, floor(s) + profile(d, w, A))   over every segment s in reach
```

which is the change that makes a river run downhill: the floor is the graph's,
and the landform is cut to it rather than lowered by a fraction. The profile
is the valley's cross-section, and its numbers are the hydraulic geometry's:
channel width `w = a·Q^0.5` and depth `h = c·Q^0.4` (Leopold–Maddock, with
`Q = p·A`), a V of Flint's slope at low order, a flat floodplain once the
valley is wider than the meander belt at fifteen to twenty channel widths, a
terrace where a second, lower incision re-cut a floodplain. The profile
reaches zero before the reach bound, so a segment leaving the set is not a
step. That is the crater rule restated, and the plate rule beside it: **never
read a value off the nearest segment**; take the `min`, which is continuous,
over every segment inside the reach.

The lattice and the reach make the per-sample cost a walk of the same shape as
the crater walk — a cell and its ring at a handful of levels, a bounded list
each — and that is what the kernel already does in integers. The port is the
crater ladder's port: a storage buffer of segments per body, a cell-to-range
table, and `terrainBands.gpu.test.ts` holding the band alone to a bound.

Lakes come free. A node under its spill level puts a **water level** into the
sample beside the elevation — the sheet's datum at that vertex — and
`RenderPatch.water` stops being one datum per patch and becomes a field: the
sea where the level is the sea's, the lake's spill where it is not, and the
sheet a `max(seabed, level)` surface the mesh builder already knows how to
make. The coarse macro band itself takes the incised lattice — bicubic on the
same cells — so the divides sharpen and the long profiles concave between the
segments, not only at them.

**What the field does not do is erode per tile.** The literature's GPU
stencil — Schott et al. 2024's flow routing, clamped stream power, thermal
and deposition passes over a tile with a halo — is fast and is the wrong
shape here twice over. A grid pass on a patch's own samples is a different
function at every level, and CDLOD's handover requires a morphed child to be
the parent's function at the parent's spacing; and the canonical field has to
be reproducible on the CPU inside a patch budget of tens of milliseconds,
where a 97² tile at three hundred iterations is a hundred. A stencil pass is
admissible at **one fixed lattice per body**, as a finer incision of step 4,
and the lattice's size is set by what the CPU can build once per body — the
phase 3 measurement, at 128² and 256² a face.

### 2.3 The look is presentational, and it is per pixel

Under the graph's finest level the field is still noise, and that is where
the erosion look lives, in the drawn tail and the material rather than the
canonical field — every one of these is point-evaluable, seed-deterministic
and a handful of noise taps:

- **Slope-damped roughness** is free: the baked noise already carries its
  gradient, so Quílez's accumulation — each octave's amplitude divided by
  `1 + |Σ gradient|²` — flattens the ground where the slope has built up,
  which is what "eroded" reads as, at the cost of one add per octave.
- **Gullies and talus** from a gradient-aligned stripe field in the micro
  band — Johansen's 2026 filter, Grenier et al. 2024's phasor kernels —
  where each octave's stripes follow the slope the coarser one cut and a mask
  keeps them off the ridges; aligned to the graph's flow where a segment is
  in reach and to the landform's own gradient where none is. A slope clamp at
  the angle of repose lays the fan at the foot of a scarp.
- **The riparian corridor** in `biota` and `wet`: the cover reads the nearest
  segment's width and area, so a river is a green line from orbit and a
  floodplain is a wider one. The two spare cover bytes are the channel.
- **The river as a sheet.** Segments in reach of a tile become flow-aligned
  strips in the mesh builder, drawn with `render/water.ts` and a flow uniform
  the waves advect along; one mesh per tile, never one per valley. Below
  hydraulic width at the lens's pixel angle the sheet gives way to the painted
  bed, which stays.
- **The mouth.** A delta where the upstream area at the coast exceeds a
  threshold: the last two segments split into three to five distributaries
  below the delta slope — the downstream rule Génevaux's upstream grammar
  lacks — over a fan of deposition raising the seabed. A ria costs one scalar:
  the graph is built against a base level a drowning depth _below_ the sea,
  drawn per body, and the sea then floods the valley the graph cut.

---

## 3. The performance tradeoffs the liquid made

Each is a measured cost against a measured loss, and each names the condition
under which it is worth revisiting. The frame is the ADR's table: 9.5 fps
before, 18.0 with every octave off.

| Tradeoff                                                    | Bought                                       | Cost                                                                                                                    | Revisit when                                                                            |
| ----------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Octaves cut: macro 3→2, micro 2→1, grain 3→2                | 11.9 → 16.3 fps                              | The micro's second octave was the meter-scale relief in the normal; ground at 3–30 m is smoother than the mesh under it | An authored material set arrives, or the `full` lever re-adds it for a measured machine |
| The noise is RGBA8 with its gradient baked                  | Normals without screen derivatives; no moiré | 8-bit value and gradient — faceting is possible on flat ground at a grazing sun, unmeasured                             | A plate shows it; the fix is a two-texture split or RG16F for the near octave           |
| One four-channel fetch per octave rather than one-channel   | The gradient                                 | A texel fetch at ~4× the cost of a one-channel one, whatever the texture's size                                         | A gradient-free far octave — screen derivatives are fine past the near ground           |
| The sea refracts the frame through `viewportSharedTexture`  | Refraction, the shallows' colour             | A frame copy per frame at nine million pixels, ~1–2 ms, and a pass the harness cannot draw                              | The sea's `plain` lever is the switch; measure the copy alone with the timestamp query  |
| Sea waves at two swell octaves and one chop                 | A moving surface                             | Static foam, no breaking wave at the shore, no wake                                                                     | Shore waves are a phase; the foam band is the seam                                      |
| The sea reflects the sky, not the land                      | No screen-space search                       | A cliff is not mirrored under itself                                                                                    | Screen-space reflection is a pass of its own; the lever is `sea: full`                  |
| The orbital bake is reflectance and a mask at 512 and 256   | The sphere wears the ground                  | A hitch of tens of milliseconds on the arrival frame, and no relief on the sphere                                       | The bake spreads across frames; the normal bake is § 4                                  |
| Rocks with `frustumCulled` off                              | No per-frame bounds                          | ~12 ms of the 82 ms frame at 3 m over the shore, drawn whether in view or not                                           | Per-patch instance ranges, or a GPU cull; the `rocks` lever is blunt until then         |
| 1,227 patches at level 17 at a 3 m stance                   | The refinement the lens asks for             | ~18 ms of extra patches behind and below the horizon                                                                    | A horizon and a back-facing test in the predicate; `terrain: coarse` is the lever now   |
| The deposit stack, the veil, the sky shell and MSAA at 9 MP | The look                                     | 18.0 fps with every octave off — the base cost, and unattributed                                                        | First: a timestamp query per pass. This is the instrument the phase did not build       |

Two tradeoffs are not in the table because they are not performance. The
canonical field is untouched by any of them — every lever is presentational,
`drawnDivergence` is 1.25 m as it was — and the CPU producer keeps the
reference: the WebGPU frame is the one the target applies to.

---

## 4. The defects, ranked

1. **The rivers do not drain.** § 1 and § 2. Everything else on this list is
   smaller than a river that runs uphill.
2. **Inland lakes stand at sea level.** The spill level is the graph's; until
   then a below-datum crater floor is a lake wherever it is.
3. **The base cost is unattributed.** 18 fps with every lever off, and no pass
   has a number. The timestamp query is the first thing to build because every
   row of § 3 is measured against it.
4. **The bake carries no relief.** The heightfield's gradient in the sphere's
   east–north frame, at the same six faces, is the second half of the bake.
5. **A hot world's sea takes its plates with it.** `makeSurface` reads the sea
   against the ground temperature, and the lithospheric weakening reads the
   sea. Proxima Centauri II lost twenty plates. The weakening wants its own
   draw — a world that _had_ a sea — rather than the drawn sea's presence.
6. **The coast has one shape.** Shelf and plain from a remap, with no cliff
   where the landform is steep, no delta, no ria. The graph gives the mouth a
   discharge and a floor; the remap becomes the default and not the rule.
7. **The cover's two spare bytes.** Slope and seat from the canonical field,
   which ends the 4% deposit step at a level boundary and the rock seat's
   0.70 m tail — and the channel the riparian corridor needs.
8. **Biota is a global noise.** 46-cycle patchiness with a 0.35 floor, and no
   relation to water. Once `wet` carries a width, `biota` reads it.
9. **The foam is static and the shore does not break.** A wave band that moves
   with the swell's phase is the cheap half; a breaker is a phase.
10. **Plate worlds carry the liquid with less shoreline variety.** The fixture
    lost its plate world, and the shore was judged on a stagnant lid. Measure
    at the most-plated body before believing the coast.

---

## 5. Constraints that bind

- **Order-independence is the design, not a check.** The graph depends on the
  body's seed and the macro bands; a refinement depends on its cell's seed,
  its ring and its ancestors. Nothing depends on what was evaluated first. The
  analytic profile is a pass up a tree the seed fixes.
- **Every canonical structure is built on the CPU, in float64, once per
  body, in bounded time.** The GPU samples what the CPU built and never
  produces it: a droplet or pipe-model erosion accumulates through unordered
  atomics and its result is a schedule, and a per-tile stencil is a function
  of the tile. The lattice's size is the CPU's budget.
- **A lattice decision is never taken in a float, and the field never reads
  the nearest.** The cell is found in the kernel's integer tile frame; the
  carve is a `min` over every segment in reach, and every profile reaches zero
  before the reach bound. The plate rule and the crater rule, both.
- **The kernel is a port held to a bound.** The band lands on the CPU first and
  in the kernel second, with `terrainBands.gpu.test.ts` holding it alone. A
  segment buffer per body and a cell-to-range table are the storage shape the
  crater ladder's constants already have.
- **It is a version bump.** The drainage band moves the canonical ground on
  every wet world; `TERRAIN_ALGORITHM` goes to 4 and the loader's version
  record says so. `SYSTEM_ALGORITHM` does not move: no rng draw order changes.
- **The sketch grows, and workers get it by value.** A few megabytes per body,
  built once, cloned to each worker as typed arrays. The GPU producer uploads
  it once per body; the WebGL 2 path pays the CPU band and nothing else.
- **A term bounded by the detail tolerance cannot move the mesh.** Gullies,
  talus and the slope-damped grain are presentational and live below
  `CANONICAL_AMPLITUDE_FLOOR`; the segment carve and the incised lattice are
  canonical and live above it. Which side of the floor each new term sits is
  decided before it is written.
- **Read the papers' code; do not vendor it.** Dendry's reference is GPL-3.0
  and Johansen's filter is MPL-2.0. The constructions are the citation; the
  implementation is this repository's.
- **The daylight rule.** Every plate in the review is at the sunlit shore or
  the sunset one. A river judged at night is a river judged by its cover.

---

## 6. Phases

Each phase lands green, on its own, with a plate.

| Phase | Lands                                                                                                         | Done when                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | The timestamp query per pass in the drive rig; four survey sites — a headwater, a confluence, a mouth, a lake | Every row of § 3 has a per-pass number at 3 m and at 2 km; `ir.preset` reaches the four sites in daylight                                                                |
| 1     | The drainage graph in the sketch: lattice, flood, accumulation, incision                                      | Every node reaches the datum or a spill; Horton bifurcation ratio in 3–5; Hack's exponent 0.5–0.6; the build is under 50 ms across the zoo                               |
| 2     | The field reads the graph: the floor carve, the spill levels, `TERRAIN_ALGORITHM = 4`; the kernel port        | `terrainBands.gpu.test.ts` holds the band to a named bound; a walk along any channel never gains height; the flooded craters are lakes at spill                          |
| 3     | Dendry refinement per cell, and the incised lattice at the size the CPU affords                               | A stream at level 17 is on the graph; the divides sharpen; the per-sample cost is within 20% of the crater walk's; the lattice build is measured at 128² and 256² a face |
| 4     | The cover reads the graph: width into `wet`, the corridor into `biota`, slope and seat in the spare bytes     | The green line from orbit; the deposit step and the seat tail gone                                                                                                       |
| 5     | The look: gullies, talus, the derivative-damped grain; river sheets and lake sheets; the mouth                | Plates at the four sites, either side; the frame at the shore within two fps of the ADR's 16.3                                                                           |
| 6     | The tradeoffs revisited against phase 0's numbers, and the relief bake                                        | § 3 rows either closed or carried with a fresh figure                                                                                                                    |

Phase 1 changes nothing anyone sees and is the one that decides the rest. If
the graph cannot be built under the budget, or the refinement is not
order-independent, the plan stops there and the strip stays.

---

## 7. Risks

- **The graph's memory on a walking-scale world.** Refinement to a level the
  walker stands beside is the quadtree's own growth, and it is bounded the
  same way — by what is resident — but it is a second cache with its own
  eviction, and two caches disagree.
- **A segment set that steps.** The reach bound is the rule; a profile that
  does not reach zero, or a refinement whose boundary segments disagree with
  the parent's by more than the floor, is a crease at a cell edge that no
  unit test on a single cell sees. The test is a walk across cells.
- **Dendry's construction is the cost, not its evaluation.** The paper's
  figure is 47 s for 512² on one core, and that is the per-point tree walk
  the cache removes; what remains is a construction per cell per level, and
  the measurement is how many of those a descent to level 17 asks for and
  what each costs in a worker. If it is the patch budget again, the level cap
  per body class is the lever.
- **The cost lands on the CPU producer.** The WebGL 2 path and the worker
  fallback pay the band per sample; the crater walk is most of a patch now and
  this is another walk. The measurement is per job across the zoo.
- **Taste.** Hydraulically correct rivers on a noise landform can read as
  drawn on. The incised lattice is what makes the landform agree with its
  rivers, and it is phase 3, not phase 2 — so phase 2's plate is judged with
  that known.
- **The version bump moves every landed ship on a wet world.** Stated in the
  loader's record; the same shape as v3's.

---

## 8. What the literature says

A research pass over the field, judged against this engine's three
constraints: a point-evaluable canonical field, order-independent generation,
and a GPU that samples but never produces. Each entry carries a verdict.

**Hydrology-first networks.** Génevaux, Galin, Guérin, Peytavie & Beneš 2013,
_Terrain Generation Using Procedural Models Based on Hydrology_, ACM TOG
32(4) ([PDF](https://www.cs.purdue.edu/cgvlab/www/resources/papers/Genevaux-ACM_Trans_Graph-2013-Terrain_Generation_Using_Procedural_Models_Based_on_Hydrology.pdf)).
A grammar grows the network **upstream** from the mouths, parameterised by the
Horton–Strahler index, with three rules — continuation, symmetric junction,
asymmetric junction — and one knob, ζ, between many equal basins and one
dominant one; each node is admitted only under a Lipschitz slope bound. The
terrain is then a blend of primitives with the rivers carved by a replace
operator. 0.1–5 s for the graph over ~3,000 km²; the finished tree is
per-point and order-independent, the growth is global. _Verdict: the right
model for the per-body artefact — a compact vector graph the field closes
over — and it cannot make a delta, which is why § 2.3 adds a downstream
rule._ The readable open implementation is
[dandrino/terrain-erosion-3-ways](https://github.com/dandrino/terrain-erosion-3-ways).

**Stream power on a grid.** Cordonnier et al. 2016, _Large Scale Terrain
Generation from Tectonic Uplift and Fluvial Erosion_, CGF 35(2)
([PDF](https://www.cs.purdue.edu/cgvlab/www/resources/papers/Cordonnier-Computer_Graphics_Forum-2016-Large_Scale_Terrain_Generation_from_Tectonic_Uplift_and_Fluvial_.pdf)):
`∂h/∂t = u − k·Aᵐ·Sⁿ` with `n = 1, m = 0.5`, solved implicitly per node
against its receiver — Braun–Willett's O(N) sweep — with lakes as a
super-graph of passes and slopes over 30° clipped by thermal erosion. Fifty
steps to raise mountains, a few hundred to freeze; `h_max = 2.244 u/k` at
steady state. Deterministic, sequential, GPU-hostile. Schott et al. 2023,
_Large-scale Terrain Authoring through Interactive Erosion Simulation_, ACM
TOG 42(4) ([DOI](https://dl.acm.org/doi/10.1145/3592787),
[code](https://github.com/H-Schott/StreamPowerErosion)) authors in the uplift
domain. Schott et al. 2024, _Terrain Amplification using Multi-scale
Erosion_, ACM TOG 43(4)
([PDF](https://hal.science/hal-04565030v1/file/2024-MultiScaleHydro-Author.pdf))
is the fully local formulation: flow routing `w = s^1.3 / Σ s^1.3` at one
iteration a step, clamped stream power `ẽ = min(Sⁿ, S_maxⁿ)·min(Aᵐ, A_maxᵐ)`,
erodibility `k(1 − ρ)` over a fractal hardness field, thermal
`h += k_γ(α − β)` counting neighbours over a noisy critical slope, and a
deposition pass `d = min(t, k_d·φ)`; 0.06 ms an iteration at 128² on a 3080,
5 ms at 4096², hundreds to thousands of iterations. _Verdict: the local
stencil is admissible at one fixed lattice per body and nowhere per tile
(§ 2.2); the drainage area it needs is global and comes from the graph._

**The analytic profile.** Tzathas, Gailleton, Steer & Cordonnier 2024,
_Physically-based analytical erosion for fast terrain generation_, CGF 43(2)
([PDF](https://www-sop.inria.fr/reves/Basilic/2024/TGSC24/Analytical_Terrains_EG.pdf),
[code](https://gitlab.inria.fr/landscapes/analytical-terrains)). The
method of characteristics on the stream-power equation gives the profile in
closed form — `z(x) = z₀(0) + ∫₀ˣ u/a ds` at steady state, with the hillslope
folded in by Hack's law as `a = k·Aᵐ + (k_h/C)·A^(−h)`, `C ∈ [1.4, 2]`,
`h = 0.6`, `m = 0.4` — at 1.8 s for 512² on a CPU against 555 s for the
simulation it replaces. It needs a stream ordering, so it is global, and it
documents that a GPU scheme without breaching traps its water in pits.
_Verdict: § 2.1 step 4. Order-independent given the tree, bit-exact on the
CPU, and it is what "steady state" means._

**Particles and pipes.** Beyer 2015 (SPH against a level set), Lague's
droplet ([MIT](https://github.com/SebLague/Hydraulic-Erosion)), Mei,
Decaudin & Hu 2007's virtual pipes
([PDF](http://www-evasion.imag.fr/Publications/2007/MDH07/FastErosion_PG07.pdf)),
Šťava et al. 2008 at 20 fps on 2048², McDonald's
[SimpleHydrology](https://github.com/weigert/SimpleHydrology) and its
[meandering rivers](https://nickmcd.me/2023/12/12/meandering-rivers-in-particle-based-hydraulic-erosion-simulations/).
They make gullies, fans and meanders, and every one of them is global
iterative state written through unordered atomics: the result is a schedule.
_Verdict: not adopted. The look they add over a deposition pass and the
per-pixel filters is small and the determinism cost is total._

**Point-evaluable channels.** Gaillard, Beneš, Guérin, Galin, Rohmer & Cani
2019, _Dendry: A Procedural Model for Dendritic Patterns_, I3D
([PDF](https://www.mgaillard.fr/content/publications/pdfs/Gaillard19I3D.pdf),
[DOI](https://doi.org/10.1145/3306131.3317020)). The field is the distance to
a tree built locally: levels of grids each twice as fine, a jittered key
point per cell (jitter ε ≤ 0.5, perturbation Δ ≤ 0.08, cubic splines), level 0
joining each point to the neighbour in a 7×7 window that minimises a control
function, finer levels joining to the nearest existing segment in a 5×5
window. Slope by Flint's law `S = ρ(2μ − 1)^(−0.6)`, junction angle by Howard
1971 `cos α = S_m/S_n`, and the control function **can be a coarse
heightfield** — Figure 15 amplifies a 16×16 downsample of the Alps sixteen
times, at 0.8% depression surface against 24.5% for ridged noise. 40–250 µs a
point on one core, embarrassingly parallel, a function of seed and position
only. _Verdict: the strongest fit in the survey — § 2.1 step 5 — provided the
tree is cached per cell as segments and the sample pays a distance, not the
construction._ The reference is
[mgaillard/Noise](https://github.com/mgaillard/Noise), GPL-3.0: read, do not
vendor.

**Per-pixel erosion look.** Quílez 2008,
[value noise derivatives](https://iquilezles.org/articles/morenoise/): each
octave's amplitude divided by `1 + |Σ∇|²`, one gradient per octave, which the
baked texture already supplies. Johansen 2026,
[a fast and gorgeous erosion filter](https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html)
(MPL-2.0): stripes aligned to the height function's gradient, cascaded so
finer gullies follow the slopes the coarser ones cut, evaluated in isolation
at every point. Grenier, Guérin, Galin & Sauvage 2024, _Real-time Terrain
Enhancement with Controlled Procedural Patterns_, CGF 43
([DOI](https://onlinelibrary.wiley.com/doi/full/10.1111/cgf.14992)):
phasor-noise ravines aligned to the low-resolution gradient. Guérin et al.
2022, _Gradient Terrain Authoring_
([code](https://github.com/eric-guerin/gradient-terrains)), models in the
gradient domain and recovers height by a Poisson solve, which is global.
_Verdict: the first three are § 2.3; the fourth is an authoring tool._

**Planets.** Cortial, Peytavie, Galin & Guérin 2020, _Real-time
hyper-amplification of planets_, The Visual Computer
([DOI](https://link.springer.com/article/10.1007/s00371-020-01923-4)):
low-resolution control maps and subdivision rules that lay the large rivers
connected to the seas first, then tributaries, lakes, ranges and valleys, on
the GPU. Derzapf, Ganster, Guthe & Klein 2011, _River Networks for Instant
Procedural Planets_, CGF 30(7): a coarse planetary network refined by
subdivision in real time. Songs of the Eons builds whole-map basins without
simulation in under two seconds. _Verdict: coarse graph per body, then
amplification per tile, is the published consensus and is what the quadtree
already wants._

**Coasts and profiles.** Seybold, Andrade & Herrmann 2007, _Modeling river
delta formation_, PNAS 104(43)
([PDF](https://www.pnas.org/doi/pdf/10.1073/pnas.0705265104)) — continuity
for water and sediment with a phenomenological deposition law, bird-foot
against multi-island by parameter, avulsion for free. No graphics paper
makes a ria or a barrier island procedurally; a ria is a valley cut before
the sea rose, which is one scalar here. The relations the profiles are built
from:

| Relation                                    | Form                                  | Values                                           |
| ------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| Hack's law                                  | `L = C·A^h`                           | `h ≈ 0.54–0.6`, `C ∈ [1.4, 2]`                   |
| Flint's law                                 | `S = k_s·A^(−θ)`                      | `θ ≈ 0.4–0.5`; Dendry's `ρ(2μ − 1)^(−0.6)`       |
| Hydraulic geometry (Leopold & Maddock 1953) | `w = a·Q^b`, `d = c·Q^f`, `v = k·Q^m` | downstream `b ≈ 0.5`, `f ≈ 0.4`, `m ≈ 0.1`       |
| Discharge from area                         | `Q = p·A`                             | `p` the precipitation, 1 m/yr in Tzathas         |
| Steady-state relief                         | `h_max = 2.244 u/k`                   | Cordonnier 2016, the calibration for `u` and `k` |
| Floodplain onset                            | valley width > 15–20 channel widths   | the meander belt                                 |

**The ranked combination**, which § 2 is: the analytic stream-power profile
on a seeded cube-sphere lattice per body, depression-free by priority-flood;
Dendry's construction below it, cached as segments per cell with the lattice
as its control function; the incised lattice as the macro band; hydraulic
geometry from the graph's area for every width and depth; and the per-pixel
filters for the look. Skipped, each for a named reason: droplets and pipes,
gradient-domain authoring, a per-tile stencil in the canonical field, and any
planet-wide metre grid.

## Related

- [Terrain — what is left](terrain.md) § 2 and § 5 — the seam this fills
- [Perf](perf.md) — the rest of the frame
- [Streaming](../../docs/concepts/streaming.md) — the two fields and the tiles
- [Rendering](../../docs/concepts/rendering.md) — the ground, the sea and the sphere
- [Harness](../../docs/guides/harness.md) — the rig every phase is judged through
