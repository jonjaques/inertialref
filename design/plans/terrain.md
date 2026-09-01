# Terrain — what is left

The terrain milestone is one heightfield planet that holds together from orbit
to standing at the foot of a mountain. Most of it is landed, and each landed
piece has an ADR that owns its decisions. This page is the remainder: the work
still open, the constraints that bind it, and the risks that are still live.

| Landed                                                        | The record                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| The quadtree — whole-disk selection, borders, the CDLOD morph | [ADR-0015](../../docs/adr/0015-terrain-level-of-detail.md) |
| The lens the refinement predicate reads                       | [ADR-0017](../../docs/adr/0017-the-lens.md)                |
| The instrument the lens is operated from                      | [ADR-0018](../../docs/adr/0018-the-instrument.md)          |
| The geology — grammar, sketch, band stack, crater field       | [ADR-0019](../../docs/adr/0019-the-geology.md)             |
| The face — cover field, palette, one material                 | [ADR-0020](../../docs/adr/0020-the-face.md)                |
| The ground — meter-scale relief and rock scatter              | [ADR-0021](../../docs/adr/0021-the-ground.md)              |
| The GPU producer — heightfield tiles as a TSL compute kernel  | [ADR-0023](../../docs/adr/0023-the-gpu-producer.md)        |

The rig every phase is judged through — the observatory's surface arm, the
derived survey sites, the terrain zoo, `ir.descend`, `ir.terrain` and
`pnpm sim --terrain-baseline` — is in
[the harness guide](../../docs/guides/harness.md).

---

## 1. Scope

**In:** solid bodies — rocky and icy — whose ground is generated from
`SurfaceParameters`. That is every body in the game: terrain has always been
seeded on all of them, mapped ones included.

The carve-out is **appearance**, and it is mechanical rather than a list.
`isMappedSurface` reads `BodyAppearance.texture`, and a body with a vendored map
wears that photograph on its ground as well as on its sphere
([ADR-0020](../../docs/adr/0020-the-face.md)); a body without one is dressed
from the palette derived from its own facts.

**Out, each with its seam named:**

| Deferred                           | Why now is wrong                                                                                                                                          | The seam that waits for it                                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Macro relief for mapped Sol bodies | Their relief is _published_, and the art doctrine requires using it verbatim ([art](../../docs/design/art.md)) — a DEM-ingest workstream, not a generator | The same band stack with the macro band read from an ingested tile set instead of from noise                                                                                                                  |
| Gas and ice giants                 | No surface. The `surface` LOD tier must never fire for them                                                                                               | The streamer gates on body kind                                                                                                                                                                               |
| Figured bodies at walking distance | A figure's datum is a measured radius grid, not the cube-sphere's near-sphere ([ADR-0013](../../docs/adr/0013-measured-figures.md))                       | The streamer carves them out — a spherical-datum patch floats around the measured ellipsoid, so deep terrain on figures is a projection problem                                                               |
| Caves, overhangs, arches           | A radial heightfield cannot hold two surfaces per ray, and the fix is a bounded volumetric overlay rather than a different planet                         | `density(p) = elevation(seed, d̂) − r`: a cave is an SDF CSG-combined into it, meshed per chunk with [Transvoxel](https://transvoxel.org/), whose 2:1 transition cells assume exactly this restricted quadtree |
| River _networks_, vegetation       | Valley networks need a per-region drainage graph (Génevaux-style); flora needs authored biomes to exist first                                             | § 5                                                                                                                                                                                                           |

One consequence of the appearance carve-out: `elevationAt` is a single canonical
function shared by rendering and the contact test, so a generator version bump
moves the procedural ground under _mapped_ bodies too. Their visual treatment is
unaffected; their ground moves once, with everyone else's, under one version
record ([ADR-0005](../../docs/adr/0005-procedural-seeds.md) § versioning).

---

## 2. Open work

**The orbital albedo bake.** A generated body's `sphere` tier is a flat tint
while its ground carries maria, rays and caps, so the streamer gates terrain on
relief covering eight display pixels (`TERRAIN_RELIEF_PIXELS`) rather than
drawing the level-0–2 shell unconditionally: five flat tinted patches over
Earth's photograph is worse than the sphere they replace. A mapped body has no
such gap. What closes it is a per-face normal and albedo tile generated in a
worker like any patch, cached and regenerable, carrying the octaves below mesh
resolution — after which the shell _is_ the silhouette at every distance and the
gate retires.

**The plate review.** "Reads as a Moon, not as noise" is a taste judgment and
the acceptance test for it is a set of before/after plates of the zoo's survey
sites, captured through the browser. What exists instead is the arithmetic:
crater density ordered Mercury > Luna > Mars > Earth > Venus, the
simple-to-complex transition holding `D·g = 29,000`, and Earth's hypsometry
bimodal at 0.583 against 0.36–0.40 for four stagnant lids. The mechanism the
review will use is `ir.preset` and `Shift+H` — seven pictures of particular
places, each with a vendored plate — but the zoo is a set of _sites_ rather than
pictures, so its own fixture is still `ir.visit` plus the drive rig.

**The crater ladder's cap.** `MAX_CRATER_LEVELS` is 11, so a body's finest
crater is a two-thousandth of its largest and the population stops well above
the canonical floor. Fourteen halvings moves the detail floor by 0 to 2 levels
and costs 13% a patch — and it moves the field the contact test integrates,
which is a version bump rather than a presentational change.

**The cover needs more channels, and two open defects share that fix.**
Deposits and rocks are both chosen from the mesh, and the mesh is level-dependent:

- Deposits step by about 4% of the drawn value at a level boundary, because two
  patches at different levels report different slopes for the same ground.
- A rock reads the field rather than the triangle under it, so it sits 3 to 9 cm
  off in the mean and up to 0.70 m at the worst cell on the coarsest body.
  `MESH_SEAT` buries it 12 cm, which hides the mean and not the tail.

Reading slope and seat from the canonical field through extra cover channels
answers both at once.

**Authored material sets, and the two techniques that wait on them.** The detail
in `render/terrain.ts` is gradient noise on the body-fixed position, which has
neither a period to break nor a projection to choose. Hex-tiling and triplanar
are answers to questions only an authored material set asks, so they land with
the eight sets the design bible commits to
([content § biomes](../../docs/design/content.md#biomes)).

**The normal-tile cache.** The GPU produces heightfield tiles; normal tiles and
the mesh stay on the main thread at 0.25 ms a patch. That is the texture-array
half of Proland's shape, and with tile production off the CPU it is the next
measurement's subject rather than a design question.

**A lens below 20°.** `FOV_MIN` is 20° because the terrain predicate saturates
its patch cap there ([ADR-0017](../../docs/adr/0017-the-lens.md)). Earthrise at
the photograph's framing wants 11.4°, so the geometry is right and Earth is
smaller in the frame than in the photograph — a stated limit rather than a
silent one. A longer lens is a phase of its own: it needs the saturation
answered, not the clamp moved.

**Analytic normals.** Patch normals are central differences over the bordered
field. The border rows already make them exact and equal across patches, so the
gain is cost rather than correctness — and analytic crater derivatives are a
second implementation of every profile that has to agree with the first or the
mesh cracks.

**The zoo has no generated `icy-active` body.** No generated system within 25 ly
of Sol contains one: generated moons come out on orbits too circular for the
eccentricity tide to register. The archetype is covered by a Sol body instead,
so the zoo is a set of bodies rather than one system.

---

## 3. Constraints that still bind

**The early-out is per body, not per patch.** Stopping a patch's band ladder at
its own sample spacing looks like free cost and breaks the CDLOD handover: a
fully morphed child is the child's own field evaluated at the parent's spacing,
and that equals the parent's mesh only if both evaluate the same function.

**The crater walk is about five cells an axis, and that is most of what a patch
costs.** A sample cannot sum a 3×3 neighborhood per level. Two displacements
separate a crater's cell from the sample's and neither fits in one cell: the
ejecta reach is 1.3 cells, because a level's largest crater has an angular
radius of half a cell; and the lattice is cubes in ℝ³ while the field is a shell
cutting through them, so a crater's center sits off the sphere by up to a cell's
width along the radius and is indexed there. A crater the walk cannot see is not
a missing crater — it is a step, full apron height the moment the sample crosses
into a cell that can see it.

**Canonical stops at half a meter of amplitude at 8 m of wavelength; below that,
detail is presentational and may differ between backends by design.** The
divergence is bounded, named and measured at 1.25 m rather than denied, the same
shape of honesty as the figured-body datum. A landing ship spans tens of meters,
so the bound is invisible to flight gameplay. When
[on foot](../../docs/design/onfoot.md) arrives, the floor drops and the
canonical cost is re-measured — a deliberate version bump, named in that phase.

**A term bounded by the detail tolerance cannot move the mesh.**
`TERRAIN_DETAIL_TOLERANCE` _is_ `CANONICAL_AMPLITUDE_FLOOR`, so the refinement
search calls every level of a sub-floor term quiet and stops where it would
have stopped anyway. Buying levels means relief _above_ the tolerance, which is
why the sub-floor crater band cuts up to 0.8 m.

**Precision is bought by anchoring, not by wider floats.** Patch vertices are
anchor-relative in body-fixed axes, every subtraction happens in float64 on the
CPU, and no shader sees an absolute planetary coordinate. At level 22 an
anchor-relative patch spans meters and float32 is comfortable.

---

## 4. Risks still live

- **Per-sample cost.** A bordered 65×65 patch is 22 to 50 ms across the zoo on
  the CPU — 9 to 37 for the canonical field on its own — and the crater walk is
  most of it. [ADR-0023](../../docs/adr/0023-the-gpu-producer.md) moves tile
  production to the GPU and the pool remains the fallback and the WebGL 2 path,
  so the figure is still the one a WebGL 2 session pays. Two levers are
  deliberately unspent: the walk's radial bound, at the cube's full width where
  the worst case measured is 1.36 of 1.73, and `EJECTA_REACH` at 2.6 where the
  continuous deposit is often mapped to 2. Thinning the geology is not one of
  them.
- **Draw calls.** A whole-disk mixed-level selection is several hundred patches.
  Measured before optimized; per-level merging is the known out.
- **The version bump moves the ground.** Every save's landed ship sits on the
  terrain version it was written with. The loader's version record makes that a
  stated migration, and the crater ladder's cap is the next change that would
  spend one.
- **Taste risk.** Craters and plates can be statistically correct and still read
  as texture. The plate review is the control, the published anchors are what
  "correct" means, and the judgment is acknowledged as judgment.
- **Plates rot.** A renderer change turns every vendored thumbnail into a
  picture of the previous renderer, and `presets:check` proves presence rather
  than likeness. Regeneration is one command; noticing is the plate review.
- **The `billboard` threshold is derived from the pixel angle**, so the point at
  which a distant star becomes a billboard follows the lens. That is correct and
  it is visible in exactly the picture nobody diffs — a plate review at two
  lenses, not a unit test.

---

## 5. Named seams, not scheduled work

Hydrology graphs (Génevaux) for valley networks; the density-overlay
cave/overhang layer with Transvoxel meshing; belts as an `o:` population;
collision for scatter, which is [on foot](../../docs/design/onfoot.md)'s; the
DEM workstream that ends the mapped-body carve-out; concurrent binary trees if
draw submission ever dominates.

---

## Related

- [Roadmap § terrain](../../docs/roadmap.md#terrain) — the milestone this sequences
- [Content § terrain](../../docs/design/content.md#terrain) — what it has to produce
- [Streaming](../../docs/concepts/streaming.md) · [Rendering](../../docs/concepts/rendering.md) — the systems it grows
- [Harness](../../docs/guides/harness.md) — the rig every phase is judged through
- [On foot](../../docs/design/onfoot.md) — the mode the canonical floor eventually answers to
- [Art](../../docs/design/art.md) — the sensor fiction the lens implements
- [Planetarium](../../docs/design/planetarium.md) · [UX](../../docs/design/ux.md) — the mode the instrument serves
