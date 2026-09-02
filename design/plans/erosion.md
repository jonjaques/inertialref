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

The build is a fixed sequence:

1. **Lattice.** The cube-sphere at `6 × 128²` — 98,304 nodes, a cell of about
   78 km on Earth and 8 km on a Luna-sized body — sampled from the macro bands
   only. The lattice is the same face-and-cell frame the crater ladder uses,
   so the kernel already knows how to find its cell in integers.
2. **Depressions.** Priority-flood from the sea (Barnes 2014) assigns every
   node a spill level and a receiver; a node under its spill level is a lake
   floor and the spill level is the lake's datum. On a dry world the flood
   starts from the lowest cells and every basin is endorheic, which is what
   Mars looks like.
3. **Accumulation.** Upstream area by one pass down the receiver tree; Strahler
   order and discharge from it. Hack's law and the Horton ratios fall out and
   are the test.
4. **Incision.** A bounded stream-power relaxation on the lattice — the
   Braun–Willett implicit solver, one pass per step from the sea upward,
   `h ← (h + Δt·U + Δt·K·Aᵐ/Δx · h_receiver) / (1 + Δt·K·Aᵐ/Δx)` — for a
   fixed count of steps. It sharpens divides, concaves the long profiles and
   widens the trunk valleys, and it is sequential in an order the graph fixes,
   so it is deterministic to the bit on the CPU. Roughly 10⁷ operations at a
   hundred steps: tens of milliseconds in the worker that already builds the
   sketch, once per body.
5. **Refinement.** A trunk at 78 km spacing is the Mississippi; a stream a
   walker stands beside is not on that lattice. A cell refines on demand into
   a sub-graph seeded by the cell — sixteen by sixteen sub-nodes whose
   boundary conditions are the parent's segments and elevations — and the
   sub-graph is a function of the cell's seed and its ancestors, never of a
   sibling. That is the quadtree's own order-independence argument, and the
   refinement is cached per (body, cell, level) the way tiles are.

The output the field reads is **segments in cells**: for every lattice cell at
every graph level, the bounded list of segments crossing it or its ring, each
with two endpoints, two floor elevations, an order, a discharge, a width and a
valley half-width.

### 2.2 The field reads the graph, and the carve is a floor

`elevationAt` keeps its shape — a pure function of a direction — and the
drainage band changes from a strip to a lookup: the sample's cell at each
graph level from the trunk down to the level its spacing supports, the
segments those cells hold, and for each the distance to the segment, the
floor elevation interpolated along it, and a **profile** of that distance in
the segment's own width. The ground becomes

```
ground = min(landform, floor(s) + profile(d, w, order))   over every segment s in reach
```

which is the change that makes a river run downhill: the floor is the graph's,
and the landform is cut to it rather than lowered by a fraction. The profile
is the valley's cross-section — a V at low order, a U with a flat floodplain
and a terrace at high order, the channel itself a flat of hydraulic width
`w = a·Q^0.5` and depth `h = b·Q^0.4` — and it reaches zero before the reach
bound, so a segment leaving the set is not a step. That is the crater rule
restated, and the plate rule beside it: **never read a value off the nearest
segment**; take the `min`, which is continuous, over every segment inside the
reach.

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

### 2.3 The look is presentational, and it is per pixel

Under the graph's finest level the field is still noise, and that is where
the erosion look lives, in the drawn tail and the material rather than the
canonical field:

- **Gullies on a slope** from a point-evaluable dendritic primitive
  (Dendry-shaped: a branching distance field driven by the local gradient)
  in the micro band, aligned to the graph's flow where a segment is in reach
  and to the landform's own gradient where none is.
- **Talus and sharpened ridges** as slope-dependent shaping of the grain: the
  derivative-damped fBm that reads as eroded, and a slope clamp at the angle
  of repose that lays a fan at the foot of a scarp.
- **The riparian corridor** in `biota` and `wet`: the cover reads the nearest
  segment's width and discharge, so a river is a green line from orbit and a
  floodplain is a wider one. The two spare cover bytes are the channel.
- **The river as a sheet.** Segments in reach of a tile become flow-aligned
  strips in the mesh builder, drawn with `render/water.ts` and a flow uniform
  the waves advect along; one mesh per tile, never one per valley. Below
  hydraulic width at the lens's pixel angle the sheet gives way to the painted
  bed, which stays.
- **The mouth.** A delta where discharge is high and the shelf is shallow — a
  fan of deposition raising the seabed and splitting the last segment — and a
  ria where the incised valley's floor runs below datum, which the graph knows
  and the coast remap replaces rather than flattens.

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
  body's seed and the macro bands; a refinement depends on its cell's seed and
  its ancestors. Nothing depends on what was evaluated first. A stream-power
  step is sequential, and its sequence is fixed by the receiver tree, which
  the seed fixes.
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
- **The sketch grows, and workers get it by value.** Tens of milliseconds and
  a few megabytes per body, built once, cloned to each worker as typed arrays.
  The GPU producer uploads it once per body; the WebGL 2 path pays the CPU
  band and nothing else.
- **A term bounded by the detail tolerance cannot move the mesh.** Gullies and
  talus are presentational and live below `CANONICAL_AMPLITUDE_FLOOR`; the
  segment carve is canonical and lives above it. Which side of the floor each
  new term sits is decided before it is written.
- **The daylight rule.** Every plate in the review is at the sunlit shore or
  the sunset one. A river judged at night is a river judged by its cover.

---

## 6. Phases

Each phase lands green, on its own, with a plate.

| Phase | Lands                                                                                                         | Done when                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | The timestamp query per pass in the drive rig; four survey sites — a headwater, a confluence, a mouth, a lake | Every row of § 3 has a per-pass number at 3 m and at 2 km; `ir.preset` reaches the four sites in daylight                                       |
| 1     | The drainage graph in the sketch: lattice, flood, accumulation, incision                                      | Every node reaches the datum or a spill; Horton bifurcation ratio in 3–5; Hack's exponent 0.5–0.6; the build is under 50 ms across the zoo      |
| 2     | The field reads the graph: the floor carve, the spill levels, `TERRAIN_ALGORITHM = 4`; the kernel port        | `terrainBands.gpu.test.ts` holds the band to a named bound; a walk along any channel never gains height; the flooded craters are lakes at spill |
| 3     | Refinement per cell, and the incised macro band                                                               | A stream at level 17 is on the graph; the divides sharpen; the per-sample cost is within 20% of the crater walk's                               |
| 4     | The cover reads the graph: width into `wet`, the corridor into `biota`, slope and seat in the spare bytes     | The green line from orbit; the deposit step and the seat tail gone                                                                              |
| 5     | The look: gullies, talus, the derivative-damped grain; river sheets and lake sheets; the mouth                | Plates at the four sites, either side; the frame at the shore within two fps of the ADR's 16.3                                                  |
| 6     | The tradeoffs revisited against phase 0's numbers, and the relief bake                                        | § 3 rows either closed or carried with a fresh figure                                                                                           |

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
- **The cost lands on the CPU producer.** The WebGL 2 path and the worker
  fallback pay the band per sample; the crater walk is most of a patch now and
  this is another walk. The measurement is per job across the zoo, and the
  lever is the graph's level cap per body class.
- **Taste.** Hydraulically correct rivers on a noise landform can read as
  drawn on. The incised macro band is what makes the landform agree with its
  rivers, and it is phase 3, not phase 2 — so phase 2's plate is judged with
  that known.
- **The version bump moves every landed ship on a wet world.** Stated in the
  loader's record; the same shape as v3's.

---

## 8. What the literature says

_Filled from the research pass; see the commit that closes this section._

---

## Related

- [Terrain — what is left](terrain.md) § 2 and § 5 — the seam this fills
- [Perf](perf.md) — the rest of the frame
- [Streaming](../../docs/concepts/streaming.md) — the two fields and the tiles
- [Rendering](../../docs/concepts/rendering.md) — the ground, the sea and the sphere
- [Harness](../../docs/guides/harness.md) — the rig every phase is judged through
