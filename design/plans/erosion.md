# Erosion — what the rivers still owe

[ADR-0043](../../docs/adr/0043-the-rivers-drain.md) made the rivers drain: a
per-body graph on a jittered cube-sphere lattice, flooded from the sea, with
a floor that never rises downstream, segments in cells the field cuts the
ground to, standing water as a level per vertex, and the sea a lake at the
datum on the nodes it reaches. That record holds the decision, the numbers
and the plates. This page is what the erosion phase still owes: the
**tradeoffs** the liquid made for the frame, each with what it cost and when
to revisit it; the **defects** that remain, ranked; and the **phases** not
yet landed, with what each one is done when.

It is a plan, so it promises. When a phase lands, its decision moves into an
ADR and the section here goes; cite the ADR, not this page.

| Reads with                                                | For                                                |
| --------------------------------------------------------- | -------------------------------------------------- |
| [ADR-0043](../../docs/adr/0043-the-rivers-drain.md)       | The graph, the carve and the water, as landed      |
| [Terrain — what is left](terrain.md)                      | The milestone this is a phase of, and its § 5 seam |
| [Perf](perf.md)                                           | The frame's figures outside the two surfaces       |
| [ADR-0019](../../docs/adr/0019-the-geology.md)            | The band stack the graph sits in                   |
| [ADR-0023](../../docs/adr/0023-the-gpu-producer.md)       | The kernel every canonical band is ported to       |
| [Content § terrain](../../docs/design/content.md#terrain) | What the bible asks a river to be                  |

**Where the numbers come from.** The frame figures are the drive rig at
1920×1200 over a device pixel ratio of 2 — 9.2 million pixels — on Gliese
908 IV at the sunlit shore (latitude 6.6°, longitude −46.4°), in daylight,
which is the rule for judging terrain. The band figures are `pnpm test:gpu`
and the unit suites. Run-to-run variance on the frame is about two frames a
second; a figure taken beside a test run is a figure about the test run.

---

## 1. What the graph does not do yet

The graph is 6 × 64² nodes — a cell of 156 km on Earth, 43 km on Luna — and
below its own cell the network is the lattice's chord bent by a warp of a
twelfth of a cell. Everything below is a consequence of that scale or of
what the phase deliberately left for the next one.

- **A stream a walker stands beside is not on the lattice.** The finest
  channel is one cell's catchment: 140 m wide on Earth, a kilometer of
  floodplain. Below it the ground is the relief band's noise, with no
  gully and no tributary. The plan for it is Dendry's construction — at
  each level a grid twice as fine, a jittered key point per cell joined to
  the nearest existing segment, cached per (body, cell, level) as segments
  so a sample pays a distance to a bounded list — and its cost is the
  construction per cell, not the evaluation, measured at how many a descent
  to level 17 asks for.
- **The mouth is a ria and nothing else.** A river reaches the sea half a
  coast width below its datum and the sea floods the last of the valley,
  which is a drowned mouth on every river whatever its discharge. A delta
  where the upstream area at the coast exceeds a threshold — the last two
  segments split into three to five distributaries over a fan raising the
  seabed — is the downstream rule Génevaux's upstream grammar lacks.
- **The river is painted, and its waves do not flow.** The sheet stands at
  the floor over the bed and the material draws it as it draws the sea, with
  the swell's phase and no flow direction; a flow uniform the waves advect
  along wants the segment's own direction in the sample, which the walk has
  and does not return.
- **A lake is a kernel over its nodes.** The level a sample reads is a
  kernel-weighted mean over the lake nodes within 1.2 cells, so a lake's
  edge is wherever the ground rises through that level inside the shore
  cell, and a hollow within a cell of a lake's shore that sits under its
  level floods with it. Right where the hollow is the lake's own basin and
  wrong across a ridge the lattice did not sample.
- **The confluence lays a cone.** Where two valleys overlap the taller fill
  wins, so a tributary's floodplain is laid over the trunk's near the
  junction and thins downstream faster than the trunk's floor drops. It
  reads as a fan and it is not one.
- **Between the channels the slopes are still noise.** No gullies on a
  hillside, no talus at the foot of a scarp, ridges rounded the way a noise
  crest is rounded rather than sharpened the way running water leaves them.
  The erosion look is a per-pixel matter and it lives in the material.
- **Rocks stand in lakes.** The scatter's water test is the sea's datum, so
  a rock seated on a lake bed or a riverbed shows through the sheet wherever
  it is taller than the water. On Gliese 908 IV at two meters over a lake
  the surface is dotted with them. The test wants the sample's own level,
  which the heightfield now carries.

---

## 2. The look is presentational, and it is per pixel

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
- **The river as a sheet with a flow.** The sheet is drawn; what it lacks is
  a flow uniform the waves advect along, which is the segment's direction at
  the sample. Below hydraulic width at the lens's pixel angle the sheet gives
  way to the painted bed, which stays.
- **The mouth.** A delta where the upstream area at the coast exceeds a
  threshold: the last two segments split into three to five distributaries
  below the delta slope over a fan of deposition raising the seabed.

---

## 3. The performance tradeoffs the liquid made

Each is a measured cost against a measured loss, and each names the condition
under which it is worth revisiting. The frame is ADR-0026's table: 9.5 fps
before, 18.0 with every octave off. The drainage walk is not in it: the one
figure taken since the graph landed — 23.5 fps at ADR-0026's latitude and
longitude, which now stands 117 m up over land with 1,128 patches at level
16 — is a different picture, and the like-for-like figure at the new shore
is phase 6.

| Tradeoff                                                    | Bought                                       | Cost                                                                                                                    | Revisit when                                                                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Octaves cut: macro 3→2, micro 2→1, grain 3→2                | 11.9 → 16.3 fps                              | The micro's second octave was the meter-scale relief in the normal; ground at 3–30 m is smoother than the mesh under it | An authored material set arrives, or the `full` lever re-adds it for a measured machine                                                                              |
| The noise is RGBA8 with its gradient baked                  | Normals without screen derivatives; no moiré | 8-bit value and gradient — faceting is possible on flat ground at a grazing sun, unmeasured                             | A plate shows it; the fix is a two-texture split or RG16F for the near octave                                                                                        |
| One four-channel fetch per octave rather than one-channel   | The gradient                                 | A texel fetch at ~4× the cost of a one-channel one, whatever the texture's size                                         | A gradient-free far octave — screen derivatives are fine past the near ground                                                                                        |
| The sea refracts the frame through `viewportSharedTexture`  | Refraction, the shallows' color              | A frame copy per frame at nine million pixels — unmeasured on its own — and a pass the harness cannot draw              | `sea: plain` does not remove it — `refraction` is a build option of `createWaterMaterial` and the lever sets a uniform, so the switch is a second material, measured |
| Sea waves at two swell octaves and one chop                 | A moving surface                             | Static foam, no breaking wave at the shore, no wake                                                                     | Shore waves are a phase; the foam band is the seam                                                                                                                   |
| The sea reflects the sky, not the land                      | No screen-space search                       | A cliff is not mirrored under itself                                                                                    | Screen-space reflection is a pass of its own; the lever is `sea: full`                                                                                               |
| The orbital bake is reflectance at 512 and relief at 256    | The sphere wears the ground and its relief   | A hitch of tens of milliseconds on the arrival frame                                                                    | The bake spreads across frames                                                                                                                                       |
| Rocks with `frustumCulled` off                              | No per-frame bounds                          | ~12 ms of the 82 ms frame at 3 m over the shore, drawn whether in view or not                                           | Per-patch instance ranges, or a GPU cull; the `rocks` lever is blunt until then                                                                                      |
| 1,227 patches at level 17 at a 3 m stance                   | The refinement the lens asks for             | ~18 ms of extra patches behind and below the horizon                                                                    | A horizon and a back-facing test in the predicate; `terrain: coarse` is the lever now                                                                                |
| The deposit stack, the veil, the sky shell and MSAA at 9 MP | The look                                     | 18.0 fps with every octave off — the base cost, and unattributed                                                        | First: a timestamp query per pass. `render/measure.ts` is wall clock over a drained queue, whole-frame; the per-pass instrument does not exist                       |
| The drainage graph at 6 × 64²                               | Rivers that drain, lakes at spill            | 50–110 ms a body on the CPU, once per worker; a walk of two to nine segments a sample                                   | The lattice at 128² is four times both, and the plan's phase 3 measures it beside the refinement                                                                     |

Two tradeoffs are not in the table because they are not performance. The
canonical field is untouched by any of them — every lever is presentational,
`drawnDivergence` stays at 1.25 m — and the CPU producer keeps the
reference: the WebGPU frame is the one the target applies to.

---

## 4. The defects, ranked

1. **The base cost is unattributed.** 18 fps with every lever off, and no pass
   has a number. The timestamp query is the first thing to build because every
   row of § 3 is measured against it, and the drainage walk's own cost in the
   frame is unknown until it exists.
2. **A hot world's sea takes its plates with it.** `makeSurface` reads the sea
   against the ground temperature, and the lithospheric weakening reads the
   sea. Proxima Centauri II lost twenty plates. The weakening wants its own
   draw — a world that _had_ a sea — rather than the drawn sea's presence.
3. **The coast has one shape, and the mouth has one.** Shelf and plain from a
   remap, a ria at every river. The graph gives the mouth a discharge and a
   floor; the delta is § 2's last item.
4. **The cover's two spare bytes.** Slope and seat from the canonical field,
   which ends the 4% deposit step at a level boundary and the rock seat's
   0.70 m tail.
5. **The network's sources.** Eight-neighbor steepest descent on a smooth
   landform leaves seven nodes in ten as sources, so `N₁/N₂` sits near seven
   where a mapped network reads four; the tests hold Horton's ratio at 3–9
   and Hack's exponent at 0.45–0.75 for it. The refinement is what fills the
   headwaters in, and the statistic is re-measured when it lands.
6. **The foam is static and the shore does not break.** A wave band that moves
   with the swell's phase is the cheap half; a breaker is a phase.
7. **Plate worlds carry the liquid with less shoreline variety.** The fixture
   lost its plate world, and the shore was judged on a stagnant lid. Measure
   at the most-plated body before believing the coast.
8. **The macro band tiles.** Every detail octave is one baked texture, and
   the macro band is fetched from it with the others: it repeats every
   `NOISE_CELLS` — 32 — cells, about 20 km of ground, at full strength for
   any footprint under a kilometer a pixel — sixteen identical tiles across
   a frame at 200 m/px — and the bake evaluates it unfaded at 20 km a texel.
   Beside it, the "four kilometers" `MACRO_METERS` names is 637 m a cell in
   practice: `macroFrequency` is `2π · R / MACRO_METERS` applied to a unit
   direction, a 2π the period arithmetic never divides out. Either that one
   band goes to an aperiodic evaluation, or the period is fixed at a real
   4 km cell and the bake's detail bands are set flat; both change the look,
   so a plate decides.
9. **A lava sea glows on the ground and not on the sphere.** The sheet emits
   the liquid's glow and the sphere takes only the liquid's color
   (`planet.oceanColor`), so a magma world is red at the gate and dark from
   orbit at night. One uniform, and the boot warm-up graph with it.
10. **The bake's ninety-six tiles queue ahead of the streamer.** On the pool
    path the source is a FIFO the two share, so a bake starting on a descent
    delays the ground the descent is about to need. A priority lane in the
    producer and the pool is the fix; residency stops the thrash, not the
    ordering.

---

## 5. Constraints that bind

- **Order-independence is the design, not a check.** The graph depends on the
  body's seed and the macro bands; a refinement depends on its cell's seed,
  its ring and its ancestors. Nothing depends on what was evaluated first.
- **Every canonical structure is built on the CPU, in float64, once per
  body, in bounded time.** The GPU samples what the CPU built and never
  produces it: a droplet or pipe-model erosion accumulates through unordered
  atomics and its result is a schedule, and a per-tile stencil is a function
  of the tile. The lattice's size is the CPU's budget.
- **A lattice decision is never taken in a float where the two processors
  could disagree, and the field never reads the nearest.** The cell a sample
  names is a float decision the rasterizer makes safe: both cells at a
  boundary list every segment within reach of it, and every profile reaches
  zero before the reach bound. The plate rule and the crater rule, both.
- **The kernel is a port held to a bound.** A band lands on the CPU first and
  in the kernel second, with `terrainBands.gpu.test.ts` holding it alone.
- **A term bounded by the detail tolerance cannot move the mesh.** Gullies,
  talus and the slope-damped grain are presentational and live below
  `CANONICAL_AMPLITUDE_FLOOR`; the segment carve and any refinement of it
  are canonical and live above it, and spend a version. Which side of the
  floor each new term sits is decided before it is written.
- **Read the papers' code; do not vendor it.** Dendry's reference is GPL-3.0
  and Johansen's filter is MPL-2.0. The constructions are the citation; the
  implementation is this repository's.
- **The daylight rule.** Every plate in the review is at the sunlit shore or
  the sunset one. A river judged at night is a river judged by its cover.

---

## 6. Phases

Each phase lands green, on its own, with a plate. Phases 1 and 2 are
[ADR-0043](../../docs/adr/0043-the-rivers-drain.md), with the four survey
sites of phase 0 and the cover's channel and corridor of phase 4.

| Phase | Lands                                                                                       | Done when                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | The timestamp query per pass in the drive rig                                               | Every row of § 3 has a per-pass number at 3 m and at 2 km                                                                                           |
| 3     | Dendry refinement per cell, and the lattice at the size the CPU affords                     | A stream at level 17 is on the graph; the per-sample cost is within 20% of the crater walk's; the lattice build is measured at 128² and 256² a face |
| 4     | Slope and seat in the cover's spare bytes                                                   | The deposit step and the seat tail gone                                                                                                             |
| 5     | The look: gullies, talus, the derivative-damped grain; a flow on the river sheet; the mouth | Plates at the four sites, either side; the frame at the shore within two fps of the ADR's 16.3                                                      |
| 6     | The tradeoffs revisited against phase 0's numbers                                           | § 3 rows either closed or carried with a fresh figure                                                                                               |

---

## 7. Risks

- **The graph's memory on a walking-scale world.** Refinement to a level the
  walker stands beside is the quadtree's own growth, and it is bounded the
  same way — by what is resident — but it is a second cache with its own
  eviction, and two caches disagree.
- **A segment set that steps.** The reach bound is the rule; a profile that
  does not reach zero, or a refinement whose boundary segments disagree with
  the parent's by more than the floor, is a crease at a cell edge that no
  unit test on a single cell sees. The test is a walk across cells, and
  `drainage.test.ts` makes it.
- **Dendry's construction is the cost, not its evaluation.** The paper's
  figure is 47 s for 512² on one core, and that is the per-point tree walk
  the cache removes; what remains is a construction per cell per level, and
  the measurement is how many of those a descent to level 17 asks for and
  what each costs in a worker. If it is the patch budget again, the level cap
  per body class is the lever.
- **The cost lands on the CPU producer.** The WebGL 2 path and the worker
  fallback pay the walk per sample; the crater walk is most of a patch now and
  this is another walk. The measurement is per job across the zoo.
- **Taste.** Hydraulically correct rivers on a noise landform can read as
  drawn on. The fill is what makes the valley agree with its river, and the
  refinement is what makes the hillside agree with the valley.

---

## 8. What the literature says

A research pass over the field, judged against this engine's three
constraints: a point-evaluable canonical field, order-independent generation,
and a GPU that samples but never produces. Each entry carries a verdict.

**Hydrology-first networks.** Génevaux, Galin, Guérin, Peytavie & Beneš 2013,
_Terrain Generation Using Procedural Models Based on Hydrology_, ACM TOG
32(4) ([PDF](https://www.cs.purdue.edu/cgvlab/www/resources/papers/Genevaux-ACM_Trans_Graph-2013-Terrain_Generation_Using_Procedural_Models_Based_on_Hydrology.pdf)).
A grammar grows the network **upstream** from the mouths, parameterized by the
Horton–Strahler index, with three rules — continuation, symmetric junction,
asymmetric junction — and one knob, ζ, between many equal basins and one
dominant one; each node is admitted only under a Lipschitz slope bound. The
terrain is then a blend of primitives with the rivers carved by a replace
operator. 0.1–5 s for the graph over ~3,000 km²; the finished tree is
per-point and order-independent, the growth is global. _Verdict: the right
model for the per-body artifact — a compact vector graph the field closes
over — and it cannot make a delta, which is why § 2 adds a downstream
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
`h += k_γ(α − β)` counting neighbors over a noisy critical slope, and a
deposition pass `d = min(t, k_d·φ)`; 0.06 ms an iteration at 128² on a 3080,
5 ms at 4096², hundreds to thousands of iterations. _Verdict: the local
stencil is admissible at one fixed lattice per body and nowhere per tile;
the drainage area it needs is global and comes from the graph._

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
_Verdict: the shape of ADR-0043's floor — a Flint climb from the receiver,
capped — bit-exact on the CPU, and it is what "steady state" means._

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
joining each point to the neighbor in a 7×7 window that minimizes a control
function, finer levels joining to the nearest existing segment in a 5×5
window. Slope by Flint's law `S = ρ(2μ − 1)^(−0.6)`, junction angle by Howard
1971 `cos α = S_m/S_n`, and the control function **can be a coarse
heightfield** — Figure 15 amplifies a 16×16 downsample of the Alps sixteen
times, at 0.8% depression surface against 24.5% for ridged noise. 40–250 µs a
point on one core, embarrassingly parallel, a function of seed and position
only. _Verdict: the strongest fit in the survey — phase 3 — provided the
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
_Verdict: the first three are § 2; the fourth is an authoring tool._

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

## Related

- [ADR-0043](../../docs/adr/0043-the-rivers-drain.md) — the graph as landed
- [Terrain — what is left](terrain.md) § 2 and § 5 — the seam this fills
- [Perf](perf.md) — the rest of the frame
- [Streaming](../../docs/concepts/streaming.md) — the two fields and the tiles
- [Rendering](../../docs/concepts/rendering.md) — the ground, the sea and the sphere
- [Harness](../../docs/guides/harness.md) — the rig every phase is judged through
