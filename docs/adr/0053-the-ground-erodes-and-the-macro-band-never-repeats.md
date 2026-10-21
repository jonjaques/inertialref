# ADR-0053: The ground erodes per pixel, and the macro band never repeats

Status: accepted · 20 Oct 2026 · amends [ADR-0026](0026-the-liquid.md)'s
"every per-pixel octave is a fetch of one baked texture"

## Context

[ADR-0043](0043-the-rivers-drain.md) made the rivers drain, and under its
finest level the ground is still noise: hillsides with no gully, no talus at
the foot of a scarp, slopes as rough as the plain they run down to. The look
erosion leaves is presentational and per pixel
([erosion plan](../../design/plans/erosion.md) § 2), so it belongs to the
ground material ([ADR-0020](0020-the-face.md)) and the drawn tail, never the
canonical field.

The material's coarsest band had a defect of its own. Every detail octave was
a fetch of the one baked texture ADR-0026 introduced, and the macro band was
fetched with the others at `2π · R / MACRO_METERS` cycles a unit direction.
The `2π` was never divided out, so the "four kilometers" the constant named
was a 637 m cell, and the texture closes on thirty-two cells: the band
repeated every 20.4 km at full strength for any footprint under a kilometer
a pixel — sixteen identical tiles across a frame at 200 m/px — and its fade
let 637 m features through to four kilometers a pixel, where they are noise.
Removing the `2π` gives a real four-kilometer cell and a period of 128 km,
which is still a period a frame at a few hundred meters a pixel holds.

Three rules bind anything added here. A fine lattice coordinate may not come
from an absolute float32 position (`AGENTS.md` rule 58): `anchor + local` is
rounded to half a meter on Earth, differently in every patch. Anything the
ground shades the sphere must shade too, or the eight-pixel gate is a step
(rule 59). And the ground's per-pixel cost is the frame's at a retina stance:
ADR-0026's table is the budget.

## Decision

**The macro band and the gullies are evaluated on a lattice with no period,
from the patch anchor split in float64; the detail under the macro band is
eroded by the slope it lies on; and every one of these terms is zero by the
footprint at which the ground hands the body to its sphere.**

- **The macro band is `latticeNoise`**, the texture's own construction —
  twelve cube-edge gradients, a quintic fade — on an unbounded lattice, at
  two octaves of a true four-kilometer cell. `gradientNoise` in
  `noiseTexture.ts` is the same function with an optional period, so the
  texture and the graph are one construction and the GPU suite holds the
  graph to the CPU. The gradient is picked from the hash's bits rather than
  from a WGSL array: Metal puts a constant array indexed at run time on the
  stack, and twenty-four evaluations a pixel over a megapixel drew in 85 ms
  through the table, 19 ms through the bits and 24 ms as texture fetches.
- **Its coordinate is the grain's trick without the modulo.** The dresser
  splits the unrounded anchor into whole macro cells and a remainder in
  float64 (`macroCell`, `macroOffset` on the wear record); the graph adds
  `positionLocal` to the remainder and floors only small numbers. The gully
  lattices are the macro cell over 128 and 256, so their whole cells are the
  macro cells times an integer, exact.
- **Roughness is damped by slope.** Each octave of the micro band and the
  grain is divided by `1 + |Σ slope|² / tan²(repose)`, Quílez's
  accumulation measured in slopes: half strength at the angle of repose,
  nearly all of it on the flat. The gradient each fetch already carries is
  the cost.
- **Gullies are phasor stripes down the fall line** — Johansen's erosion
  filter and Grenier et al.'s ravines, built from their constructions:
  eight corner waves along the across-slope direction at two stripes a
  cell, each with its hash's phase, blended as phasors and renormalized by
  `2L` clamped at one, so they keep full strength where the corners agree
  and end or fork where they do not. Two octaves, 15.6 m and 7.8 m apart,
  the finer one shallower and following the slope the coarser one cut. They
  are cut before the micro octave, along the landform's own gradient; a mask
  keeps them off ground under 4.6°, off crests, off painted rivers and off
  the seabed under the sheet; the profile is a V at the floor and a round
  spur, pitched at 0.3; floors are up to 8% darker. **The fall line is the
  landform's gradient** because the drainage graph's flow direction does
  not reach the material; `fall` in `render/terrain.ts` is where it goes
  when it does.
- **Talus settles at the angle of repose.** On loose ground the summed
  slope of the detail is clamped to the angle or the landform's own slope,
  whichever is steeper, so the apron under a gullied scarp reads as a scree
  fan rather than as more of the scarp.
- **All of it is shading.** Nothing displaces the mesh, nothing reaches
  `packages/universe`, and `drawnDivergence` is untouched at 1.25 m.
- **None of it crosses the gate.** The streamer draws the ground while its
  relief covers eight display pixels, and at that height no fragment's
  footprint is under `maxElevation · sampleAngle / (8 · displayAngle)`.
  The macro band and the gullies are multiplied by a fade that is zero at
  nine tenths of that footprint, and the damping and the clamp act only on
  bands that are gone by fourteen meters a pixel — thirty times under
  the gate on the far-shore world at a device pixel ratio of two — so the sphere, which wears the orbital bake
  and nothing finer, has nothing to carry. `TerrainPatches` hands the material the display
  angle beside the sample angle for it. The bake measures its footprint from
  the body's center rather than from each patch's anchor, where it fell to
  nothing and drew detail at kilometers a texel, and reads no macro band.
- **The levers.** `ground: full` is the macro band and all of the eroded
  detail; `lean` is the macro band alone; `flat` is neither.

## Alternatives considered

**The texture at the corrected cell.** One line, and it repeats at 128 km —
the GPU test that holds the band aperiodic reads exactly zero between two
points that far apart on it. A larger texture or a second one at a coprime
period moves the period without ending it, and ADR-0026 measured that a
texture's size is not what its fetch costs.

**Texture bombing or hex tiling of the baked noise.** Three fetches and a
blend a pixel to break a period the lattice does not have, and a blend
across tiles is a crease in the gradient the shading is made from.

**The macro band per vertex.** It is kilometers, and the near ground's cells
are a meter — but the far ground's cells are kilometers too, and a two-kilometer
octave sampled at its own wavelength and interpolated is not that octave.

**The macro band on the direction, as before.** A float32 direction resolves
0.38 m on Earth, which a four-kilometer band survives; a fifteen-meter gully
cut from the same coordinate steps at every patch seam. One split serves both.

**Adding the bands to the sphere.** The planet material would need the
body's radius and the lens's pixel angle from the host, a lattice evaluation
on every pixel of every solid disk, and a guess at the deposit's grain it
cannot see. Ending the bands before the gate is a number instead of a second
copy.

**Gullies in the mesh.** A displaced gully has a silhouette and a shadow; it
also needs a CPU port in `micro.ts`, a kernel port held to a bound, and a
place inside `drawnDivergence`. At the footprints a fifteen-meter gully is
visible from, shading carries it, and the canonical side of the floor is
phase 3's Dendry refinement.

**Vendoring Johansen's filter.** It is MPL-2.0. The construction is cited;
the code is this repository's.

## Consequences

**The look.** On the far-shore world (`g:milky-way/s:P222_1_0_9/b:4`) in
daylight, the crater wall at its `rough` site carries gullies running down it
over a smoother floor, and 29,741 pixels of a 1600×900 plate move by more than
8%. The four survey sites each stand on their water and move by none in their
default framing. **The macro band is at most 3 of 255 in either build**, read
as the difference between `lean` and `flat` over lossless captures straight
down at 200 m and at 50 m a pixel. The old band's 20.4 km repeat does not
survive into a plate — its autocorrelation is under 0.08 at every shift,
because a 637 m cell at 200 m a pixel is three pixels of noise — so the defect
was arithmetic rather than visible. The new band is the four-kilometer mottle
the constant names, correlated 0.67 across 5 px and 0.49 across 20 px at 50 m
a pixel.

**The cost.** Measured under load — the machine's other agents running their
suites on the same GPU — at the Gliese 908 IV shore (latitude 6.6°, longitude
−46.4°, sun 35°), at 1920×1200 over a device pixel ratio of two, by
`ir.passes(30)` with this change switched on and off in one boot. Three
meters over the shore the frame is 44.3 ms against 36.1, and 51.9 against
43.3 in a second boot; two kilometers up, 43.8 against 36.2. The macro band
alone, `lean` on against off, is 4.1 ms of it at both heights: twenty-four
lattice evaluations a pixel over a megapixel draw in 8.5 ms beyond an empty
graph, where the fetches they replace, coherent across a frame, were nearly
free. The frame on a quiet machine is the plan's to take.

**The macro band now leaves on the way up.** It is gone by nine tenths of the
gate footprint, which on a body with little relief is low: 6,948 m on the
far-shore world puts it at 781 m a pixel at a device pixel ratio of one.

**Gullies are on every body with slopes**, airless ones included: a dry
granular flow cuts the same chutes into a crater wall that water cuts into a
hillside, and the mask is the slope's, not the climate's.

**One preset plate moved, and it is the one that stands on slopes.**
Photographed through one rig from this change and from its parent,
`tau-ceti-dusk` — low sun across Tau Ceti II's summit ridges — differs in
17,313 pixels; `far-shore` in 31, under the comparison's floor of 200; the
other five lit pictures, orbital views and Tau Ceti's moonrise, in none. Its
plate is re-captured.

**The micro octave is still patch-local.** Its phase jumps at a patch edge as
before; it fades out by fourteen meters a pixel, and the gullies, which do not
jump, now carry most of what a hillside shows at that range.

## Related

- [ADR-0020](0020-the-face.md) — the material and the seam rule
- [ADR-0021](0021-the-ground.md) — the drawn tail, the grain's split, `drawnDivergence`
- [ADR-0026](0026-the-liquid.md) — the baked noise and the frame's budget
- [ADR-0043](0043-the-rivers-drain.md) — the graph whose flow direction the gullies will follow
- [The erosion plan](../../design/plans/erosion.md) — the phase this is part of
