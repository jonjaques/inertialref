# ADR-0015: Terrain is a restricted, morphing quadtree over a measured detail floor

Status: accepted · 2026-08-27

## Context

The streamer drew a 3×3 block of patches at one level around the point under the
camera. That is a few kilometers of ground on a body ten thousand kilometers
across: the horizon was the datum sphere, every cube-face edge was a hole
(five patches of nine over a corner, where three faces meet), and the whole set
faded out an octave above the ground because a lone raised tile on a sphere is a
sticker rather than a planet.

Worse, the rules that chose the level and the fade were handed `distance −
radius`. For a camera standing on the ground that is `groundElevation + height`,
not `height`. [The terrain rig](../../CONTEXT.md) measured what followed: a
summit streamed one level coarser than a basin at the same height above the
ground; a level pass at fixed height coarsened and re-refined as the ground rose
and fell beneath it; and a summit above `radius · 2^(5.5 − maxLevel)` was not
drawn **at any altitude, including zero** — two of Miranda's six survey sites
were ground that could not be looked at.

The milestone this serves is "one continuous space, orbit to on foot", so the
representation has to be one representation at every distance rather than two
with a fade between them.

## Decision

**A quadtree walked once per frame from the six cube faces**, with four rules,
each of which was chosen against a measurement rather than a preference.

**The error is a patch's grid spacing, not its height deviation.** Ulrich's
screen-space-error predicate wants the mesh's true vertical deviation from the
surface. On a planet that number is startlingly small — Earth's relief is two
parts in a thousand of a cube face and a patch's 64 quads cut it by another 64 —
so a height-error metric alone says a 156 km patch is close enough to stand on.
Cesium's shipping tiles carry a geometric error equal to their own sample
spacing for the same reason, and that is the number used: the size of the
smallest thing a patch can express. Refine while one grid cell subtends more
than 16 px.

**Refinement stops where the field stops, measured per body.** Past some level a
patch is a bilinear upsample of its parent. On Mercury a level-9 patch differs
from one by 12 cm and levels 10 through 12 by nothing a float can hold — so the
old rule's saturation at level 12 was asking for sixteen times the patches of
level 10 to produce identical output, at 12.8 ms of worker apiece.
`surfaceDetailFloor` measures the residual from the field itself — 24
golden-angle probes, five samples each, memoized, about five milliseconds,
counting a quiet level only when its stencils touched dry ground, because the
sea clamp manufactures exact zeros over open water — and lands at level 9 or 10
across the zoo. It lives beside `elevationAt` because it is a property of those
bands: when Phase 2's geology puts detail at scales they do not currently
reach, it reports a deeper floor the same day.

**Distance is measured to the ground.** A node is a cone of directions crossed
with the shell `[radius − relief, radius + relief]` that ground can occupy, and
the distance is to the nearest point of that. An eye inside the shell is at
zero, which is what standing on the ground means, and the three defects above
are gone with the datum they came from.

**Levels are morphed and the tree is restricted to 2:1.** Each vertex slides
toward the position its parent's grid holds for it and arrives there before the
parent takes over (CDLOD, Strugar 2009). That is exact rather than approximate:
a child covers half its parent's side, 64 quads halved is 32, so every even
index of the child lands on a parent grid point, and the field is a pure
function of direction. The morph therefore closes a one-level gap perfectly —
and a two-level gap not at all, because the finer patch arrives on a grid the
coarser one has no vertex on. Unrestricted, that was 30 of 468 patch edges on
Miranda with a gap of two or more and a worst case of six, drawn as dashed black
arcs along every level ring. The tree is restricted.

**Terrain is not drawn where the sphere is the honest picture.** A body's relief
must cover more than eight pixels first. Past that the mesh and the datum sphere
are the same picture, and the sphere already carries a normal map and, on four
bodies in Sol, a photograph.

## Alternatives considered

**Geometry clipmaps.** Viewer-centric nested grids, no tree, no per-patch
bookkeeping. They fight tile addressing: a clipmap's rings are not regions, so
nothing they draw has an address, and addresses are what regions, seeds, scatter
and the save format all hang off. Rejected.

**Concurrent binary trees** ([arXiv:2407.02215](https://arxiv.org/abs/2407.02215),
KSP2's terrain). The end-game, and the right answer once generation itself lives
on the GPU. Rejected now, with a revisit condition: if draw submission ever
dominates the frame rather than generation does.

**An unrestricted tree, with the morph carrying the transitions.** This was the
plan of record, and it is wrong. The morph closes one level. Stated honestly the
choice is between a wide LOD band, which balances the tree by construction, and
a restriction pass — measured, the tree balances itself once a level's band is
3.7 patches wide, and that costs 500 to 1,000 patches for one disk against 300
to 600. The band stays narrow and the pass runs, in packed integer keys with no
allocation because the readable version cost 1.8 ms, sixteen times the traversal
it was correcting.

**Per-node cube-face distortion correction**
([Zucker & Higashi, JCGT 2018](https://jcgt.org/published/0007/02/01/)). The
gnomonic map is not equal-area — a cell at the middle of a face covers over
twice the ground of one at a corner — so measuring each region describes a patch
better than its level does. It also breaks the thing the phase is for. The
crack-free argument needs a patch and its coarser neighbor to agree on one
number, and those two are measured at different points on the face, where the
scale differs by up to 22% at level 2: the finer patch ends up 15% short of its
neighbor's grid, which is a lit gap. The distortion is smooth in position and
the level is not, and no per-node number can be both. The metric is nominal per
level; what the distortion costs is over-tessellation near the cube's eight
corners rather than a seam.

**Keeping the opacity fade.** It existed because a 3×3 window is not a planet.
With whole-disk coverage there is nothing to fade, and the fade was also hiding
a real bug: the surface tier reaches more than eight radii while `NEAR_LIMIT` is
two thousand kilometers, so patches placed at true meters against a compressed
sphere are a different object at a different distance. Terrain now rides the
body's own render compression.

**Switching terrain off for mapped bodies**, as the terrain plan's scope
carve-out reads. `surfaceRadius` is one function and the contact test lands a
ship on procedural elevation whether or not the body has a photograph — Mars's
is ±14.7 km against a sphere drawn 29.4 km under the datum, so a mapped body
with no streamed ground is a ship parked fifteen kilometers above a smooth
planet. The carve-out is about what may be _claimed_ of a mapped surface, not
about whether the ground under the landing gear is drawn.

## Consequences

**The three datum defects are gone**, and every one of the zoo's twenty-four
survey sites bottoms out at its own detail floor. The tests that pinned them
assert their opposites.

**A frame selects a few hundred patches where it drew nine.** Measured at 16 px
a cell: 236 patches on Earth at two meters, 435 on Miranda, 474 on the zoo's
11,536 km world, and 623 at the worst step of a descent onto it. Selection is
0.11–0.31 ms against a 0.5 ms line. Standing on Miranda's summit the whole frame
is 2.04 ms at 63.9 fps with 3.59 M triangles selected.

**Terrain's memory is now the notable cost.** 203 KB a patch, so 45–126 MB of
vertex buffers. Packing the four attributes below float32 is worth about half
and frustum-culling the selection about half again; neither is done, and both
are named in [the roadmap](../roadmap.md#terrain).

**A cache smaller than the working set oscillates rather than degrading.** The
streamer holds two selections — the drawn one and the request one, taken from
where the eye is going. At a flat 512 against a working set of six hundred,
terrain strobed at every altitude.

**The selection's ceiling is not what sizes those caches, and reading it that way
is how the second one was set too small.** What must be resident is the set the
evictor promises to keep, which is the whole pyramid under the request
selection — and a quadtree's ancestors are a third again as many as its leaves,
so that floors at ~1.33× the selection cap before the starved rung is counted.
Geometry sized at the selection plus a slack of 128 sat under that floor: the
streamer built four patches a frame and dropped four it had wanted a moment
earlier, and every twenty-sixth frame the eviction took a patch the traversal
was refining through and the disk snapped from 760 patches at level 7 to four at
level 1.

**No multiple of the selection cap bounds that keep set, and the cap in force is
a measurement rather than a proof.** The request set is _two_ independently
capped selections — the drawn one and the one taken at the look-ahead eye — so
its ceiling is around 2.3× the selection cap in the limit, which is more than
the geometry cache holds. The two coincide at a hover and separate as the
camera's ground track lengthens, so what moves the keep set is the camera's
speed as much as the drawing buffer: measured over Luna, Ganymede and Triton it
runs from 957 at a hover over 1600×900 to 1,824 at a 20 km lead over 5120×2880.
Twice the cap clears everything measured, by about 11%. Anyone retuning either
number wants that sweep again rather than the arithmetic.

**Phase 3 owes the sphere-tier shell a material.** The plan's unconditional
level-0–2 shell wants a per-face normal and albedo bake underneath it; without
one it is flat tinted ground, and drawn over a mapped body it replaces a
measured picture with an invented one. The eight-pixel threshold is where that
bake goes when it arrives.

---

## Related

- [Streaming](../concepts/streaming.md#terrain-streaming) — the four rules in practice
- [Rendering](../concepts/rendering.md#terrain-meshing) — the morph, and why the shader's share is one `mix`
- [ADR-0003](0003-render-coordinates.md) — the compression terrain now rides
- [ADR-0005](0005-procedural-seeds.md) — the versioning the detail floor answers to
- [ADR-0017](0017-the-lens.md) — the lens the predicate reads, and every patch count above re-measured through it
- [TERRAIN-PLAN](../../TERRAIN-PLAN.md) — the milestone this is Phase 1 of
