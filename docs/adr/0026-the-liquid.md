# ADR-0026: The liquid — a sea is a sheet, a valley is a strip, and a world is drawn in families

Status: accepted · 2 Sep 2026

## Context

[ADR-0019](0019-the-geology.md) made the ground a geology and
[ADR-0021](0021-the-ground.md) took it below the canonical floor, and every
generated world came out of both the same two colours: a rocky one in the
class's brown and an icy one in the class's grey, with a sea — where the
generator drew one — painted onto ground clamped flat at the datum. A shore
seen from a landed ship was the seabed's own shape wearing blue. A world at
900 K had an ocean. Nothing ran downhill anywhere, and nothing grew.

[The terrain plan](../../design/plans/terrain.md) deferred river networks to
a drainage graph and flora to authored biomes, both correctly; what it did
not say was how much of a world's _look_ is the liquid rather than the rock.
The brief for this phase named four things — a shoreline, river valleys,
water that reflects and refracts, and colour that is not brown and grey — and
one constraint: the frame at the tail of the planet scale was 20–30 fps, and
on a retina window 9.5.

## Decision

**A sea is a liquid the ground temperature admits.** `liquidKind` names three
— water between 238 and 395 K, hydrocarbons around a hundred kelvin, magma
above the basalt solidus — and `makeSurface` reads the sea draw against it:
the draw is still taken in its place in the stream, so `SYSTEM_ALGORITHM`
does not move, and a datum on ground outside every window is dry. Twenty of
the thirty-nine seas within twenty light years sat on ground between 400 and
1,200 K. The grammar gains `liquid`, `drainage` and `biota`, each gated on
air as well as temperature, because a puddle in a vacuum boils on the spot.

**A valley is the zero-level strip of a warped noise.** `valleyField` is
`1 − |n| · sharpness` over a three-octave fBm bent by a warp, and the strip
where a noise crosses zero is a network of closed curves at every octave: it
branches, it meanders where a finer octave bends the crossing, and it never
ends in the middle of a plain. `drainageCarve` cuts a V inside a shallow
floodplain into the landform the plates and the swell made, capped at 13% of
the budget and — smoothly, through `1 − e^(−x)` — at 85% of the ground's
height above the drainage datum, so a valley shallows toward the shore and
its floor meets the sea at the datum whichever way it ran to get there.
Tributaries are the same construction at 3.1× the frequency on their own
seed. Nothing here knows which way is downhill; a network that drains is the
graph the plan still defers, and what this buys is the look at every scale
the mesh reaches for the cost of a stateless field.

**The coast is a remap.** `coastRemap` pulls the landform toward the datum
over a band either side of it — a shelf a fifth as steep under the water and
a plain two fifths as steep behind the beach, C¹ where the band lets go, with
a kink at the waterline itself, which is what a beach is. The band is a tenth
of the hypsometry share, the scale the datum is set on: 240 m on Gliese
908 IV.

**The cover grows to six channels in eight bytes.** `wet` marks the floored
riverbed; `biota` what grows — the biosphere's window read against the same
latitude term the frost uses, a treeline, a rainfall, a province-scale
patchiness. A vertex attribute is four lanes, so the record is one
`InterleavedBuffer` with an attribute object per name at its own offset,
through `terrainAttributes.ts` for every geometry that wears the material,
warm-up dummies included. The two spare bytes are where the canonical slope
the deposits still want will go.

**The heightfield is the seabed, and the sea is a sheet over it.**
`drawnGroundElevation` leaves the sea clamp off; `drawnElevation` keeps it
for the two readers that stand on the water rather than look through it, the
stance and the detail-floor search. `buildPatch` emits a second grid for any
patch the sea reaches — the datum sphere on the patch's own vertices, with
the water depth over each and a morph target for both — and
`render/water.ts` draws it: Fresnel between what comes up through the water
and what reflects off it; the seabed read from the frame the opaque pass
just drew, displaced by the wave slope and attenuated by
`e^(−absorption · path)` along the refracted ray, so a shelf is turquoise
and the deep is the liquid's own colour; the sky and a two-lobe sun in the
reflection; a swell and a chop; foam where the sea is shallower than a wave
is high. Magma is the same graph with a glow. A river is painted on its bed
rather than drawn as a sheet, because a sheet per valley is a mesh per
valley.

**A world is drawn in families off its own seed.** `appearance.ts` replaces
the class colour with eleven rock families and five ice ones weighted by the
ground temperature — the iron oxides, the basalts, the feldspars, olivine,
sulfur, the tholins — with a little value and chroma of the world's own;
seven haze compositions gated by temperature, from Rayleigh blue through
dust, sulfuric glare, tholin orange and methane teal; six photosynthetic
pigments, chlorophyll weighted as the common answer; and a
`LiquidAppearance` with the deep colour, the per-meter absorption and the
glow. Forked from the surface seed so every other draw on the body stays
where it was. The families are more saturated than the class means were on
purpose: a generated world is drawn from this at every distance, and its
deposits contrast against it.

**Every per-pixel octave is a fetch of one baked texture.** `noiseTexture.ts`
evaluates a periodic gradient lattice once into a 128³ single-channel 3D
texture — four texels a cell over thirty-two cells — and `fbmFetch` samples
it at each octave's scale. The macro, micro and grain bands of the ground and
the swell and chop of the sea are eight fetches where they were eight lattice
evaluations of eight hashes and eight dot products each, and the field is
periodic by construction, which is the property the sub-meter bands needed
anyway. The octaves also sit inside branches on their own fades and on the
quality lever: a noise multiplied by a zero fade was a noise evaluated.

**The aerial veil's view leg is the lesser of two paths.** The flat-atmosphere
`1/μ` is a statement about looking down from space; from a standing camera it
put the ground forty meters away behind eleven atmospheres. The distance over
a scale height takes over exactly where the orbital term stops being true,
and above the eight-pixel gate the distance is hundreds of scale heights, so
the seam with the disk is untouched.

**The surface has four levers, and they are named costs.** `render/quality.ts`
carries the refinement threshold, the ground's octaves, the sea's refraction
and waves, and the rocks, as one persisted record the frame loop reads and a
driving script can set. Not a ladder: each is one measured term, so a frame
rate can be reported against the setting it was taken at.

## Alternatives considered

**A drainage graph.** The right answer and a phase of its own: a per-region
graph of flow directions with the valleys carved along it, which is what
makes a network drain. The strip field is what a stateless per-sample function
can do, and at every scale the mesh reaches it reads as valleys; what it
cannot do is join them. Deferred with its seam named, as before.

**Painting the sea on the clamped ground, better.** Depth-tinted, with a
Fresnel term and a wave normal. It cannot make a shoreline: a shore is a flat
surface meeting a slope, and a mesh clamped to the datum is the seabed's shape
in blue. Rejected on the first plate from two meters.

**Reading the scene depth for the water's path length.** More exact than the
vertex depth — it would see the ship's hull in the water — and a second
texture the sheet would read every pixel. The vertex depth is the seabed's
depth, which is what the absorption is about; the hull can wait for the water
to matter to gameplay.

**A screen-space reflection of the land.** The one thing missing from the
sheet. A march through the depth buffer per pixel of sea, on the frame this
phase is trying to make cheaper. Named in the plan.

**Drawing the seabed's detail under deep water.** It is drawn: the sheet is
transparent, so the seabed under it is shaded in full and then attenuated to
nothing. A branch on the depth would skip it; measured, the sea's own terms
were the larger cost and the levers cover the rest.

**A colour wheel.** A hue drawn uniformly makes every world the same unlikely
pastel; the families are the surfaces that exist.

**Keeping the octaves as lattice evaluations and cutting their count.** Fewer
octaves is less detail; a fetch is the same detail for a tenth of the
arithmetic, and the texture is the seam an authored material set will use.

## Consequences

**Terrain is algorithm version 3.** Every wet world's ground moved and every
hot world's sea went, and `drawnDivergence` is unchanged. The kernel ports
all of it: `terrainBands.gpu.test.ts` isolates the drainage and the coast
over the hypsometry alone, and the worst gap is 9.8 × 10⁻⁶ of the budget on
Earth at level 0 — a warped fBm raised to the sixth power in float32 — against
a bound of 2.5 × 10⁻⁵.

**The frame at a retina size, measured at 1920×1200 over a device pixel ratio
of 2, standing two meters over the sea on Gliese 908 IV with 1,227 patches
at level 17:**

| Change                                  | fps  |
| --------------------------------------- | ---- |
| Before this phase                       | 9.5  |
| The octaves branched on their fades     | 12.2 |
| The noise baked                         | 19.4 |
| … and the ground's octaves off (`flat`) | 21.9 |
| … and the sea's waves off (`flat`)      | 20.2 |

At two kilometers over the same shore with 1,232 patches: 17.9 before, 19.1
branched, and the baked figure is in the build log. The ground's octaves cost
25 ms of the 82 ms frame as lattice evaluations and about 3 ms as fetches.

**The fixture's plate world lost its plates.** Proxima Centauri II drew a sea
on ground at 491 K; read against its temperature the sea goes, and with it
the ocean that weakens a lithosphere into plates. `geology.test.ts` finds the
most-plated solid body in the fixture rather than naming one.

**A generated world is a ball of one colour from orbit until relief covers
eight display pixels, and then it is blue and green.** The sphere has no sea
and no pigment, because it has no cover; the orbital albedo bake the plan
names is the most visible open item on the page now, and the kernel already
produces everything it needs.

**The harness cannot draw the sea.** `viewportSharedTexture` copies the
framebuffer once a frame, ending the render pass and beginning it again, and
the harness has neither a swap chain to copy nor a pass that survives being
re-begun around its single draw. The frame read is a build option;
`materials.gpu.test.ts` compiles the graph without it, and the copy is
exercised where it runs.

**The rocks are worth twelve milliseconds at a two-meter stance**, drawn with
`frustumCulled` off at the field's whole population. They have a lever;
culling them is the next thing to measure.

## Related

- [ADR-0019](0019-the-geology.md) — the landform the valleys are cut into
- [ADR-0020](0020-the-face.md) — the cover this extends, and the seam rule
  the veil's second path had to respect
- [ADR-0021](0021-the-ground.md) — the drawn field the seabed is
- [ADR-0023](0023-the-gpu-producer.md) — the kernel that ports the new bands
- [Content § biomes](../design/content.md#biomes) — the pigment's place in
  the biome table
- [The terrain plan](../../design/plans/terrain.md) — what is still open
