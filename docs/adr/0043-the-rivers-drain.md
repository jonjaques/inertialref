# ADR-0043: The rivers drain — a per-body graph the field cuts to

Status: accepted · 18 Sep 2026. Supersedes the valley strip of
[ADR-0026](0026-the-liquid.md) and its sea drawn at one datum wherever the
ground is under it; keeps that ADR's sheet, coast, families and levers.

## Context

[ADR-0026](0026-the-liquid.md) put a sea on the ground and valleys in it,
and the valleys were the zero-level strip of a warped noise: a network of
curves that branches, meanders and never ends on a plain, which is what a
river looks like from orbit and why the phase took it. Everything it got
wrong followed from the one thing a strip does not know, which way is
downhill. `drainageCarve` cut a fraction of whatever the plates and the
swell had put under it, so along its own length a river ran uphill and
downhill and uphill again, and from the ground it read as a chain of ponds
in a trench. Its tributaries were a second noise, independent of the first,
crossing trunks and divides alike and the same width at the head as at the
mouth. And a lake was wherever the ground sat under the sea datum, so a
crater floor a thousand kilometers inland held water at sea level — right by
accident, and wrong wherever the accident did not fall.

[The erosion plan](../../design/plans/erosion.md) named the answer: a
drainage graph, built once per body, that the field reads the way it already
reads the plates and the crater ladder. The constraints it had to meet are
the field's own. The canonical ground is a pure function of a direction,
computable in float64 wherever the contact test runs; generation may not
depend on order; the GPU samples what the CPU built and never produces it;
and a lattice decision is never taken in a float where the two processors
could disagree.

## Decision

**A body's rivers are a graph, built once per body on the CPU, and the field
cuts the ground to its floors. The graph is where the water is: the sea
where it reaches, a lake at its spill, a river at its surface.**

- **The lattice is the cube-sphere at 6 × 64², jittered.** A node per cell,
  its position drawn a quarter of a cell from the center off the lattice
  hash so the network is not a grid, and under it the stack's own landform:
  every band before the drainage, read at the cell's wavelength floor rather
  than the canonical eight meters, because an octave finer than a cell is
  relief the routing cannot see and a normalized noise has no mean to lose.
  The crater ladder is walked only over the rungs whose craters span two
  cells, plus the **mean** of the rest. That mean is not a refinement: a
  crater is one-signed, so a ladder saturated at its fine end depresses the
  whole surface by a near constant — on Earth the coarse rung alone folds to
  −76 m through the soft limit and the whole ladder to −610 — and the first
  lattice, without it, held every floor half a kilometer over the ground the
  field has, and 97% of Earth's channel nodes stood in a pond a median of
  592 m deep. With it the median is 2 m and the ninetieth percentile 34.
- **A priority flood from the base level gives every node a receiver and a
  spill level.** The seeds are the sea's nodes on a wet world, the pits at or
  below the drainage datum on a dry one, and the lowest node where there are
  none. Receivers are re-chosen as the steepest descent over the filled
  surface where a strictly lower neighbor exists, and kept from the flood
  where none does; both point at a node popped earlier, so the pop order is
  a topological order of the tree and every later pass is one sweep of it.
  Ties in the heap break by index, which is what makes the graph a property
  of the seed rather than of the walk. Area, Strahler order and the longest
  path come from one pass up the tree.
- **The floor is the lesser of a Flint climb and a capped cut, and it never
  rises downstream.** At a node the floor is `min(spill − cut, from + S(A)·ds)`
  with `S = S₀·A^(−0.45)` and `S₀ = 40 · budget / R`, `cut` growing with the
  area as `(A/64)^0.35` and shallowing to nothing at the node's own base
  level; then clamped to `from`. A trunk with a thousand cells behind it
  climbs at a twentieth of a headwater's rate and cuts a canyon through
  ground that climbs faster; a headwater cuts to the cap. A node under
  standing water keeps the landform as its floor, and the profile climbs
  from the water's level less a ria depth — half the coast width — so a
  river reaches a lake or the sea below its surface and the water floods the
  last of the valley. A lake's outlet is held at the lake's level, because
  the cut below would drain the lake into it.
- **The field reads segments in cells.** Every node and its receiver are a
  segment carrying the floor, the channel's half-width and depth at each
  end — `w = a·Q^0.5`, `h = c·Q^0.4`, `Q = p·A`, Leopold and Maddock — and
  the level of whatever drowns the reach. Every cell lists the segments
  whose valley reaches it, rasterized conservatively over nine marks of the
  cell, so the two cells a float could name at a boundary list everything
  within reach of that boundary; a sample takes its cell in a float and
  walks the list. The carve is
  `landform − max cut + max fill − max notch` over the list, where one
  segment's cut is the landform's height over the floor across the valley's
  cross-section, its fill the floor's height over the landform across the
  same, and its notch the channel's depth over the bed. Every term is zero
  for a segment out of reach, so the set a sample sees can change without
  the ground noticing.
- **The fill is alluvium, and it is a valley wide.** The relief and the
  craters are not on the lattice, so along a channel the landform dips under
  the floor wherever a hollow of theirs falls on it. A cut alone leaves the
  hollow, and with the water held at the floor that is a channel of water
  standing over the land beside it; a fill the bed's width is a causeway
  with a cliff for a bank, which put the kernel four meters off the CPU at a
  float32 position. Over the whole cross-section the same height is a fan a
  valley wide, and the floodplain keeps six percent of the landform's relief
  so a great river's plain is not a plane.
- **The lookup is warped by a twelfth of a cell**, two cycles a cell off the
  drainage seed, so a chord between two nodes is a meander. The warp's own
  slope is under a half, which is what keeps the map one to one and a
  monotone floor monotone along the warped channel: three cycles at 0.12
  cells was 2.3, and folded.
- **Standing water is a level per vertex, and the sea is a lake at the datum
  on the nodes it reaches.** A node under its spill puts its level into the
  sample as a kernel-weighted mean over the lake nodes within 1.2 cells, so
  one lake is one level exactly, and a fill spanning fewer than three
  adjacent nodes is a flat rather than a lake — one node's crater filled to
  its spill painted every hollow within a cell at that level, which is the
  flooded-crater field the graph exists to end. The heightfield carries the
  level beside the cover, the worker task is version 7 for it, and
  `buildPatch` builds the sheet at each vertex's own level with no datum
  handed beside it. The canonical clamp reads the same level: a ship stands
  on a river or a lake as it stands on the sea, and a below-datum basin the
  sea never reached is dry ground.
- **The kernel ports the walk.** Two storage buffers — records of nodes and
  segments, words of neighbors, cell starts and cell lists — because a
  compute stage may bind eight on the baseline device and the stack's own
  five plus the water make six. The lake mean, the warp, the cell and the
  walk are the CPU's, and `terrainBands.gpu.test.ts` holds the drainage band
  alone to `2.5 × 10⁻⁵` of the budget plus half a meter; the whole field
  holds at its existing bound on every body at every level.
- **The cover reads the bed and the corridor.** `wet` is the channel's own
  width, a thread for a creek and a kilometer for a trunk; `biota` follows
  the floodplain rather than a strip painted the same everywhere.
- **The survey names four more places.** The mouth of the largest river, its
  source, the junction where its largest tributary joins it, and the largest
  lake — read off the graph, since a search of the field could not find
  "the largest river", and each stood where the field draws the channel by
  pulling the node back through the lookup's warp.

## Alternatives considered

**`min(landform, floor + profile)` alone**, as the plan wrote it. Continuous
and monotone on the lattice's own landform, and a pond in every hollow the
lattice cannot see. The fill is what the plan's formula lacks, and the
wide fill is what a bed-width fill lacked.

**Sampling the whole stack at every node.** The exact landform under each
node costs the crater walk, 5 µs a node against 2 for the bands, and it
still does not see the crater between two nodes. The mean of the fine
rungs is the part that mattered — the DC offset — at 256 walks a body.

**Ponds with the water at the floor.** Dropping the fill and letting the
water stand over a hollow keeps the walkable surface monotone by
construction and looked like an aqueduct: water above the land beside it,
with no bank. Tried, measured, and put back.

**A stencil erosion per tile** — Schott et al.'s flow routing and clamped
stream power over a tile with a halo. A grid pass on a patch's own samples
is a different function at every level, which breaks the CDLOD handover,
and it cannot be reproduced on the CPU inside a patch budget. Admissible at
one fixed lattice per body, which is the shape this is.

**Droplets and pipes.** They make gullies, fans and meanders, and every one
accumulates through unordered writes; the result is a schedule, and the
rule is that generation may not depend on order.

**Dendry refinement below the lattice**, cached per cell as segments. The
right next step and not in this record: it is a second cache with its own
eviction and a per-tile buffer on the producer, and the plan's own risk
list says two caches disagree. The warp buys the meander at the lattice's
own scale; the tributary a walker stands beside is still the plan's phase
three.

## Consequences

**Terrain is algorithm version 5.** Every wet world's ground moved: the
valleys are in different places, cut to a datum along the channel rather
than by a fraction of the landform, the stage runs after the craters rather
than before them — cut first, a crater dug into the bed is a dam the walk
climbs; cut last, the river takes the rim down and fills the bowl — and a
basin the sea never reached is dry. A dry body, and a wet body's seabed
outside any channel's reach, are untouched to the last bit. `SYSTEM_ALGORITHM`
stays: nothing `system.ts` generates reads the graph.

**The build is 50 to 110 ms a body**, measured cold in Node on an M-series
core over Earth, Titan and eight generated worlds within 25 light years, most
of it the bands at 24,576 nodes and the rest the flood and the rasterizer.
The plan asked for 50. The lattice size is the lever — 32 a face is a
quarter of the cost and 312 km cells on Earth — and the graph is memoized
beside the sketch, so a worker pays it once a body.

**The network has a river's statistics with the lattice's own trait.**
Over the ten bodies: every node reaches the sea, a spill or a sink; no floor
rises along any receiver; Hack's exponent is 0.48–0.74 over nodes of thirty-
two cells and up; Horton's bifurcation ratio is 4.2–8.8 by geometric mean,
because eight-neighbor steepest descent on a smooth landform leaves seven
nodes in ten as sources and `N₁/N₂` sits near seven where a mapped network
reads four. The plan's windows were 0.5–0.6 and 3–5; the tests hold the
measurement, and the reason is in them.

**Earth at this seed is four fifths sea.** The fine rungs' mean lowered the
lattice's land by half a kilometer to where the field already had it, and
19,908 of 24,576 nodes are under the datum. Its land is 4,700 nodes and its
network reaches four orders; the statistics are held on a generated world.

**The plates.** On the shore world of the `far-shore` preset, in daylight: at
the mouth from 60 km the trunk and its tributaries meander to one outlet
and the flooded-crater field is gone except within a cell of the coast,
where the sea reaches; at the confluence from 3 km a great river's bank
curves through a plain that keeps its texture; at the headwater from 300 m
a drowned reach stands at its lake's level. The frame was not re-measured
against ADR-0026's table; that is the plan's phase six.

**The GPU holds.** `terrainKernel.gpu.test.ts` passes on every body at every
level with the water compared beside the elevation; `terrainBands.gpu.test.ts`
measures the drainage band under 0.06 m on Earth at level 0.

**What is not here, and the plan still owes.** Dendry refinement below the
lattice; the delta and the ria as shapes rather than a depth; gullies,
talus and the derivative-damped grain; a river sheet with a flow direction
for its waves; the slope and seat in the cover's spare bytes; and the
per-pass timestamp query that every row of the plan's tradeoff table is
measured against.

## Related

- [ADR-0019](0019-the-geology.md) — the landform the floors are cut into
- [ADR-0023](0023-the-gpu-producer.md) — the kernel that ports the walk
- [ADR-0026](0026-the-liquid.md) — the sheet, the coast and the families
  this keeps
- [The erosion plan](../../design/plans/erosion.md) — what remains
