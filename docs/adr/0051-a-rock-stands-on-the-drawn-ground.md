# ADR-0051: A rock stands on the drawn ground, and a deposit reads the floor's slopes

Status: accepted · 20 Oct 2026. Extends the level of detail in
[ADR-0015](0015-terrain-level-of-detail.md), the cover in
[ADR-0019](0019-the-geology.md), the drawn ground and the scatter in
[ADR-0021](0021-the-ground.md), and the sampled water of
[ADR-0043](0043-the-rivers-drain.md). Spends neither of the cover's two spare
bytes.

## Context

The cover is eight bytes a vertex — six channels, four to an attribute — and
the last two are written as zero. The terrain plan proposed spending them on two
defects that come from the same place: the ground is drawn at a level of detail
the selection chooses from the camera, and both the deposits and the rocks were
chosen as if it were not.

**The deposits stepped at every level boundary.** The material chooses bedrock
against mantle, and the flat-ground deposits against both, from the slope of the
mesh normal. A patch's normal is a central difference over its own cell, so a
coarse patch reports the ground smoothed over its cell and draws flatter ground
on average. Measured on the area-weighted tone over sixteen directions a patch,
the mean step at a level boundary is 0.43 to 1.44% of the drawn value on
Iapetus, 0.45 to 1.03% on P222_1_0_9 V and 0.09 to 0.36% on Gliese 908 IV, and
the worst single patch 4.09, 3.36 and 1.33%: a ring of tone at every morph
band. It is a bias, not noise, so widening the bands around the angle of repose
shrinks it and does not remove it.

**A rock stood on the field, not on the ground drawn under it.** A rock is
generated from its address alone, and it was seated on the field at its own
direction and pushed down by a constant `MESH_SEAT` of 12 cm. The field and the
drawn triangle differ by the mesh's interpolation error at whatever level the
selection drew there: at a two-meter stance, over every rock in range, 10.5 to
26.3 cm in the mean and 0.58 to 1.41 m at worst across the zoo, Gliese 908 IV
and P222_1_0_9 V. The tail is larger than the detail floor's own error, 2 to
11 cm in the mean and 79 cm at worst on Miranda, because a rock a hundred meters
off stands on a patch one or two levels coarser, where the worst cell is 1.9 m
off the field.

**No byte of cover can carry a seat.** At every vertex the mesh _is_ the field,
so a per-vertex correction is zero at every vertex and zero everywhere it is
interpolated. The difference exists only between vertices, only for the level
drawn there, and the level is a function of the camera, which the generator
cannot know.

**Nor did the scatter respect standing water.** Its water test compared the
clamped ground against the sea's datum, so on a body that drains every rock on a
lake bed or a riverbed passed at the lake's height and drew through the sheet:
608 of 849 rocks around Earth's largest lake, the deepest 427 m under, and every
rock at the mouths of Gliese 908 IV and P222_1_0_9 V.

## Decision

**Neither defect spends a byte of cover. A rock stands on the triangle the
selection drew under it, read back from the drawn set with its morph; a deposit
reads its patch's drawn slope mapped, per body and per level, onto the
distribution of drawn slopes at the detail floor.**

- **The seat is the drawn triangle.** The streamer indexes its drawn regions
  and answers a direction with the deepest one holding it, its triangle split
  along the index buffer's diagonal and each vertex slid toward its parent's
  grid by its own morph factor, as the material slides it
  (`packages/rendering/src/patchGround.ts`). The scatter layout's signature
  carries an epoch that moves only when the drawn set's regions or morph bands
  do, so a converged stance lays nothing out again. A rock is cut on the field
  first, widened by `GROUND_SLACK` (4 m against a worst cell of 1.86 m in
  range), so the triangle is read only for rocks that can survive the range
  and pixel tests. `MESH_SEAT` is gone; the sink is capped so 15% of every
  rock stands proud.
- **The water test is the clamp's own.** A rock is dropped where the
  heightfield's sampled level (`Heightfield.water`) stands over it — a lake's
  spill, a river's surface, the sea where the sea reaches — and the datum on a
  body whose water is not sampled. A basin under the datum that the sea never
  reached is dry ground and keeps its rocks.
- **The deposits read the floor's distribution.** `depositSlopeTable` in
  `packages/universe/src/depositSlope.ts` probes the drawn field at 1,024 land
  directions on a golden-angle spiral, at every level from the root to the
  floor, with the drawn statistic: the three vertex normals of the triangle
  under the probe, each a central difference over one cell as `buildPatch`
  takes it, interpolated as the material interpolates them. Each level keeps
  the map from its own quantiles to the floor's, as 32 knots on log₁₀ tan²
  from −7 to 1; the floor's row is the identity. Rank is kept, so a coarse
  level's steepest ground is still where its bedrock goes, and the fraction of
  the ground past any threshold is the floor's at every level.
- **The material reads it per patch.** `render/slopeTable.ts` holds one
  float32 texture, a row a level, written in place and read with
  `textureLoad`; a patch reads its own row and its parent's, mixed by its
  morph factor, so a patch slid onto its parent's grid reads its parent's row
  with its parent's normal. A rock's faces and a warm-up dummy carry
  `NO_SLOPE_LEVEL` and read the slope as drawn. `depositSlopeAt` is the same
  arithmetic on the CPU, and `slopeTable.gpu.test.ts` holds the graph to it.
- **A worker measures it, after the ground.** The table is its own task,
  `universe.depositSlopes`, rather than part of preparing the surface,
  because the ground waits on the floor and must not wait on this. The
  material's host asks for it every frame (`GameEngine.depositSlopeTable`), so
  a host with no material never measures; it starts once the surface is
  prepared and no tile waits in the pool's queue, and until it lands the
  deposits read the mesh's slope. The orbital bake waits for it and starts it
  whatever is queued, because the sphere's reflectance is the ground's at
  level 2 and has to wear the same correction.
- **It is presentational.** Nothing canonical reads the table or the seat. The
  heightfield record and the cover are unchanged, so `TERRAIN_ALGORITHM`, the
  heightfield task's version and `TERRAIN_KERNEL_REVISION` do not move.

## Alternatives considered

The tone figures are deterministic arithmetic over the drawn field — the step
between adjacent levels is the mean of the area-weighted tone a level draws
against its parent's over the same ground, sixteen directions a patch, the
largest of any level; "per vertex" is the mean disagreement between a level's
vertex and its parent's at the same point. The costs were taken while other
agents' suites ran and are labeled under load.

| Option                                                                  | Largest mean step: Iapetus / P222 V / Gliese 908 IV | Worst patch         | Per vertex                    | Cost                                                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------- | ------------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| The mesh's own slope                                                    | 1.44 / 1.03 / 0.36%                                 | 4.09 / 3.36 / 1.33% | 1.9–3.1 / 0.8–2.5 / 0.5–1.0%  | none                                                                                 |
| **A.** A fixed-baseline slope from the field, in a cover byte           | 0.1–0.5%                                            | —                   | 8–10% at coarse levels        | 8,450 extra samples a patch, 2.3 to 3 times a patch's; a byte                        |
| A on a 17×17 sub-lattice, bilinear between                              | —                                                   | up to 3.5%          | 5–9%                          | 578 extra samples, 12% of a patch; a byte                                            |
| **B.** The same slope from a new ring of samples carried with each tile | not measured                                        | —                   | —                             | a new ring in the tile record: the task version, every archived tile, a byte         |
| **C.** The per-body, per-level slope table (this decision)              | 0.28 / 0.29 / 0.16%                                 | 2.49 / 2.55 / 0.84% | 1.9–3.8 / 1.6–3.95 / 0.8–1.8% | no byte; a worker 9 to 38 s a body on one thread, under load (machine load 35 to 44) |
| **D.** The seat alone, the deposits left on the mesh's slope            | as the mesh                                         | as the mesh         | as the mesh                   | none                                                                                 |

**A, a slope at a fixed baseline, gets the mean right and nothing else.** A
slope taken over a few meters and read at a coarse vertex a hundred meters from
the next is a point sample of a field that varies faster than the vertices do,
so it aliases: every coarse vertex draws a different random answer, 8 to 10%
from the level beside it, three times the mesh's own disagreement, at two to
three times a patch's samples. The sub-lattice is affordable and aliases
almost as badly. What a coarse patch should draw is the floor's _distribution_
of slopes, not any one of them.

**B is A's statistic with a record change on top.** Carrying a ring of samples
with every tile so the baseline slope is read from the tile itself saves A's
extra field samples and keeps its aliasing, and it changes the tile record:
the heightfield task's version moves and every archived tile misses. It was
not measured.

**C was tried in four forms before this one.** A table measured on the vertex
normals rather than the interpolated triangle left 0.50% of mean step on
Iapetus where the drawn statistic leaves 0.28%, and 0.25% on the shore world
where it leaves 0.29%: interpolation is itself a smoothing at each level's own
scale, and the drawn statistic is the one that holds on both. 256 probes left
0.4 to 1.0% from one body to the next, sampling noise in the tail the
thresholds sit in — the mantle sheds from 25° and is gone by 49°, the upper
tenth of an airless body's slopes. A quantile map at every probe in place of 32
knots measured no better, 0.35 and 0.39% against 0.28 and 0.29%. A per-level
gain on tan², fitted so the mean mantle over the probes is the floor's — the
literal reading of "a variance per level" — matches the mean and not the tail:
on a coarser four-direction measure its worst patch on Iapetus was 5.19%,
against the quantile map's 3.43% and the mesh's 4.45%.

**D was the fallback**, had C not beaten the mesh. It does on every body and
every figure but one: per-vertex disagreement rises on the two smoother bodies,
because a coarse level now draws the floor's spread of slopes rather than a
smoothed one. That is the correction working, and it stays under half of A's.

**A constant seat** is what `MESH_SEAT` was, and it hides the mean and not the
tail. **A per-vertex seat byte** is zero at every vertex, which is where the
mesh is the field.

## Consequences

- **Both spare bytes stay free** — bytes 6 and 7 of the record, the second
  cover word's high sixteen bits. The next presentational channel the material
  needs from the generator has them.
- **The deposits are a model of the floor, not the floor.** A region rougher or
  smoother than its body's average draws its level's correction regardless,
  which is the spread that remains: a worst patch of 0.84 to 2.55% where the
  mesh's was 1.33 to 4.09%.
- **A table costs seconds of a worker per body**, unmeasured on a quiet
  machine. On a pool of one or two workers that is felt as the first tiles
  after it waiting, which is why it starts only once the queue is empty. The
  bake does not wait for an empty queue, so a bake that asks first pays the
  measurement in its own latency.
- **The ground's tone moves once, when the table lands** — up to the mesh's own
  step, about a percent at coarse levels — and not at all on a host with no
  pool, which keeps the mesh's slope.
- **A rock's seat reads the drawn set**, so its placement depends on the camera
  where its generation does not: 0.9 µs a rock unmorphed and 3.8 µs in a morph
  band, headless under load, for the rocks that survive the field cut, and a
  layout pass whenever the drawn set's regions or bands change.
- **A rock is never under water**, lake, river or sea, and a basin the sea never
  reached keeps its rocks.
