# ADR-0021: The drawn ground goes below the field the ship lands on

Status: accepted · 2026-08-30

## Context

[ADR-0019](0019-the-geology.md) made the ground a geology and
[ADR-0020](0020-the-face.md) gave it a face. Both stop at the same line:
`elevationAt` carries every band down to about half a metre of amplitude at
eight metres of wavelength, and nothing below that exists. Standing at two
metres, that line is the whole picture.

The arithmetic is worth writing out, because it explains why the ground was flat
and why nothing about the renderer could have fixed it.
`surfaceDetailFloor` refines a patch while the middle of one grid cell differs
from the bilinear interpolation of its corners by more than
`TERRAIN_DETAIL_TOLERANCE`, and that tolerance **is**
`CANONICAL_AMPLITUDE_FLOOR` — the same constant, deliberately, so that the
level past which refinement stops buying detail is the level past which the
field stops having any. Measured across the zoo, the floor landed at cells of
1.75 to 5.66 m. One of those cells, seen from a two-metre stance, is four
hundred display pixels across, and there is nothing inside it.

The loop is closed: **a term bounded by the tolerance cannot move the floor,
however fine its wavelength.** Adding relief below the canonical floor and
leaving its amplitude under half a metre — which is the obvious reading of
"below the floor" — produces a field the mesh will never go and get.

The other half of the problem is that a heightfield is not a place. A dozen
instanced rocks with a rotation and a scale apiece do more for standing on a
world than another octave of terrain
([content § scatter](../design/content.md#scatter)), and the `o:` address
segment has existed for them since [ADR-0004](0004-universe-addressing.md).

## Decision

**The drawn field and the canonical field are two functions, and the difference
between them is a published number.**

```
groundElevation(surface, d)      ─►  the contact test, saves, survey sites
        │                                  canonical · terrain algorithm v2
        ├── + microRelief ──────►  drawnElevation(surface, d)
        │                                  the mesh, the material, the stance
        └── |difference| ≤ drawnDivergence(surface) = 1.25 m
```

`packages/universe/src/micro.ts` is the tail: the crater ladder continued from
`CANONICAL_DETAIL_FLOOR` down to `MICRO_DETAIL_FLOOR`, plus two octaves of
regolith grit. `generateHeightfield`, `surfaceDetailFloor` and the observatory's
stance read the drawn field; `elevationAt`, `surfaceRadius` and everything
physics touches read the canonical one. Nothing is versioned, because nothing
canonical moved.

**The tail's amplitude is above the tolerance, and that is the point.** An
eight-metre crater is 1.6 m deep because that is what an eight-metre crater is.
Folded through `softLimit` at `MICRO_CRATER_CEILING`, the tail's own bound is
0.8 m — over the half-metre a cell is refined against, so the floor moves, and
under the depth of one fresh crater, because a **saturated** population is in
equilibrium and its members destroy each other. Measured RMS slope at a
one-metre baseline afterwards: Luna 12.3°, Mars 8.4°, Mercury 15.6°, against a
published 5–20° for lunar regolith and the MER landing sites — and against
**0.2° on Luna canonically**, which is what a flat plane measures.

**The rungs are numbered from a fixed base, not continued from the canonical
ladder.** Numbering them by position needs a largest crater to count down from,
and `grammar.largestCrater` is zero on every surface `young` deletes — Miranda,
Enceladus, Europa, three of the most interesting places to stand. Anchored at
`MICRO_RUNG_BASE`, the tail is a property of the body's size and air alone and
its hashes cannot collide with any canonical rung. `young` does not enter it: a
resurfacing event deletes a crater population, and retention at a metre is
geologically instantaneous, so the moon that was paved last week is saturated at
a metre by the afternoon. Air enters harder — an atmosphere screens the small
impactor and then fills the hole in — and `(1 − air)⁴` orders Luna 1, Mars 0.14,
Earth 0.012, Venus 0.

**One field at every level, unchanged.** The tail is a pure function of the
direction and every patch evaluates all of it, so the CDLOD morph endpoint is
untouched — a fully morphed child is still the child's own field at the parent's
spacing, and that still equals the parent's mesh. Evaluating it only on patches
fine enough to resolve it is the saving that would break that, and
[ADR-0019](0019-the-geology.md) carries the argument.

**Rocks are addresses.** `regionScatter(surface, region, slots?)` answers "does
`r:…/o:837` hold a rock" with a hash: 1,024 candidate slots over a 256 m region,
gated by the cover the vertex already carries. `slots` is a half-open range
because resolving one candidate is a field sample and a whole region is eight and
a half milliseconds — a caller streams it a slice at a time, and slot 837 is slot
837 whichever call resolves it.

**And a rock wears the ground's own material.** `render/terrain.ts` builds one
graph; `ScatterRocks` draws `InstancedMesh`es with it, because Three's node
material inserts the instancing _before_ `positionNode` runs, so the graph reads
the instanced position and every term it derives — altitude, latitude, the map's
UV, the footprint — is right for the rock rather than for the field's anchor. A
rock is then bedrock on its steep faces and regolith on its top, in the palette
of the ground it lies on, by the same slope term that decides the ground.

## Consequences

**Every terrain number moves, and the direction is up.** The detail floor goes
from 15/16/12/10 to 19/17/14/12 across the zoo — cells of 0.35, 0.87, 1.10 and
1.41 m against 5.54, 1.75, 4.40 and 5.66. A patch costs 6 to 15 ms more —
43.4/43.2/49.8/21.6 against 32.5/37.2/35.0/8.7 — because the tail is four more
rungs of the crater walk. A whole-disk selection peaks at 1,077 patches against
862, so `DEFAULT_MAX_PATCHES` is 1,280 and its corner case is 282 MB of vertex
buffers. Generation was already the binding constraint before this phase and is
more so now, which is [TERRAIN-PLAN](../../TERRAIN-PLAN.md) § 11's Phase 5
stated as a measurement rather than a plan.

**The contact test and the drawn ground are 1.25 m apart at worst.** A landing
ship spans tens of metres, so it is invisible to flight; a person will notice,
and [on foot](../design/onfoot.md) is where the floor drops and the number is
re-measured. The observatory's stance moved to `drawnSurfaceRadius` for the same
reason: a two-metre stance against the contact test's radius puts the eye inside
a crater rim.

**A world with Earth's air keeps its canonical floor and gets its metre scale
from the scatter and the material.** `(1 − air)⁴` at air 0.602 leaves 2.5% of
cells holding a sub-floor crater — far too few to move a residual — so that
body's floor stays where the canonical field put it, at 3.66 m cells, while an
airless one of the same size goes to 0.90. That is the right answer rather than
a gap: an atmosphered world's metre scale is soil, ripples and loose rock, which
is `scatter.ts` and the grain band rather than a band of craters that are not
there.

**The tail asks for an exact chord and the canonical ladder does not.**
`2 − 2 cos θ` from one dot product cancels: at a one-metre crater on a 1,700 km
body it is 4 × 10⁻¹⁴ against a float64 ulp of 2 × 10⁻¹⁶, which is a millimetre
on the crater's own depth and a millimetre that differs between two patches
computing the same direction by different routes. The sum of squared component
differences is the same number with nothing cancelling. `ChordForm` is the
parameter, and the canonical ladder keeps the cheap form deliberately: changing
it would move `elevationAt` in its last bits on every body.

**The grain band's domain is reduced on the CPU.** The material's sub-metre
octaves cannot use `positionLocal` — patch-local, so the phase jumps at every
boundary, invisible at seven metres of wavelength and a straight line across the
ground at seventy centimetres — and cannot use the body-fixed position, which is
1.7 × 10⁶ on Luna where float32 resolves 0.1 m. So the anchor is reduced modulo
`GRAIN_PERIOD` wavelengths in float64 and the noise is periodic over it: exact,
continuous, and repeating every 45 m of ground, which is more than the band
survives to.

## Alternatives

**Deepen the canonical crater ladder instead.** `MAX_CRATER_LEVELS` is 11 and
the canonical floor would allow 16 to 19, so a body whose largest basin is
2,170 km has canonical craters down to 2.1 km and then nothing until eight
metres. Measured, raising it to 14 moves the detail floor by 0 to 2 levels and
costs 13% a patch — it works, and it moves the field the contact test
integrates, which is terrain algorithm v3 and every save's landed hull.
[TERRAIN-PLAN](../../TERRAIN-PLAN.md) § 5 says the ground moves under saves
once; this is not the phase that spends it.

**Synthesize the tail per vertex only at deep levels.** Free detail control, and
it breaks the morph: a fully morphed child is the child's own field at the
parent's spacing, and two patches with different fields differ by every feature
between their two floors. Closing it means reading the morph target from the
_parent's_ heightfield, which makes a patch's geometry depend on its parent
being resident — a real design, and a larger one than this phase.

**Leave the mesh where it is and put everything below it per pixel.** A bump
map has no silhouette, and at two metres the silhouette is most of the frame:
the ground meets the sky four hundred metres away and every rise between here
and there is a shape. The material's grain band is that argument's _other_ half
and is here as well — below a mesh cell, per pixel is the only option there is.

**Give the rocks their own material.** A third surface for "never add a shading
term to the ground without adding it to the sphere" to police, drifting from the
first the next time either was touched.

## Related

- [ADR-0019](0019-the-geology.md) — the field this extends, and the morph
  argument it must not break
- [ADR-0020](0020-the-face.md) — the material the grain band is added to
- [ADR-0015](0015-terrain-level-of-detail.md) — the quadtree the floor sets the
  depth of
- [TERRAIN-PLAN](../../TERRAIN-PLAN.md) § 5, § 7, § 11 — the plan this is
  Phase 4 of
- [On foot](../design/onfoot.md) — where the divergence stops being invisible
- [Content § scatter](../design/content.md#scatter) — what the rocks are for
