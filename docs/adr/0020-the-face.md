# ADR-0020: The ground is a cover field, a palette and one material

Status: accepted · 2026-08-29

## Context

[ADR-0019](0019-the-geology.md) made the ground a geology. What draws it is a
`MeshStandardNodeMaterial` with one flat colour, lit by the scene's ambient
light and nothing else. That was survivable while terrain was nine patches under
a landing ship; since [ADR-0015](0015-terrain-level-of-detail.md) the quadtree
draws the whole disk, so the ground **is** the picture of the planet — and a
rough dielectric sphere under a uniform fill is not what a regolith world looks
like at any phase angle.

Two things have to be true at once. The design bible says a biome is derived,
never authored, from latitude, altitude and slope plus the body's own facts
([content § biomes](../design/content.md#biomes)). The art doctrine says a
published map is not negotiable ([art](../design/art.md)) — Mars really is that
colour and the generator does not get a vote. About sixty of the bodies a player
can land on have a map; every generated world has none.

And the descent has to hold together. Terrain streams only once relief covers
eight display pixels; above that the archive's sphere is drawn instead. A
descent crosses that switch, and this phase's whole claim is that it is not
visible.

## Decision

**Four layers, split by who can answer.**

```
universe/cover.ts   ──►  4 bytes a vertex   ──►  rendering/terrainPalette.ts
(what a shader          (bright, dark,          (what each deposit
 cannot derive)          mineral, ice)           looks like on THIS body)
                                                          │
   the archive's map ─────────────────────────────────────┼──► render/terrain.ts
   latitude · altitude · slope ─────────────────────────► (one material,
                                                            one pipeline)
```

**The cover field carries history, not geometry.** Latitude is the direction
against the spin axis, altitude is the radius, slope is the normal against the
radial: a fragment has all three for free, and shipping them per vertex would be
paying to send the renderer something it is standing on. What a shader cannot
derive is the body's past — whether this plain is flood basalt or the same rock
as the highland beside it, whether this ground was excavated last week or three
billion years ago, which way the crust's composition varies, where the volatiles
have condensed. Those four are the cover, they come out of the same sketch the
landforms do, and they are **four bytes** — each is a fraction read through a
splat weight, and eight bits resolves it finer than anything downstream of a mip
chain can tell from a float.

**Rays are a separate structure on the same lattice.** A young crater's rays are
thin bright ejecta lying on darker mature ground, not a shape; Tycho's cast no
shadow at any sun angle and reach twenty times farther than its apron. So they
are not a term in the height profile, and they are not walked on the crater
lattice either — sixteen radii of reach is a neighbourhood hundreds of cells
wide, which is a whole ladder's cost per sample for a handful of craters.
`rayCraters` enumerates the coarse rungs once per body and keeps the youngest
sixteen; every field on them is read back from the same two hashes
`levelContribution` reads, so a ray system is centred on a bowl the height field
actually digs.

**The cover morphs with the geometry.** A patch already carries where each
vertex goes when it hands over to its parent and the normal it shades with when
it gets there; the cover makes the same journey. Geometry that hands over
exactly while the albedo does not is worse than a pop — every ray edge and mare
margin slides by one child cell across the morph band and keeps sliding as the
camera moves.

**The palette is ratios against the body's own colour, never absolute.** A
palette of absolute colours makes every rocky world the same sandstone and makes
the terrain disagree with the datum sphere, the orbital tier and the dossier's
swatch, all of which read `appearance.colour`. Expressed as ratios, Mars stays
ochre and Callisto stays grey while both get the same internal contrast. Lunar
mare is 0.07 geometric albedo against 0.13 for the highlands, so basalt is 0.54
of the reference.

**A mapped body's ground wears its published map**, sampled by direction in
`SphereGeometry`'s own layout — the same photograph the sphere in front of it is
drawn from. On those bodies the palette holds pure ratios, the material
multiplies the two, and the cover's _invented_ channels switch off: the maria
and the ray systems are in the photograph already, and a second set on top of
them is two disagreeing planets in one frame. The geometric deposits stay on
both paths, because a map is ten kilometres a texel and knows nothing about the
slope under the camera.

**Deposits are layered, not splatted.** Bedrock is what a body _is_ and
everything else lies on it, so the stack is five `mix`es in the order they are
laid down: regolith wherever a slope holds it, basalt in the flooded basins,
wind-sorted fines on the low flat ground, evaporite on the flattest and lowest,
volatiles on top. A six-way normalized splat has to invent a rule for what
happens when three weights all say 0.4; a stack says the ice is on the sand,
which is true. The angle of repose does most of the visible work — 33° is a fact
about friction rather than about a planet, and it is what makes a crater wall
read as a crater wall.

**Everything in the graph is in body-fixed axes.** The normal because the
geometry is, the eye because the morph already needed it, and the sun because
the host rotates one vector on the CPU rather than transforming a normal per
fragment. Nothing in the material mixes two frames.

**Skylight comes out of the direct beam rather than beside it.** Light scattered
into the sky is light that did not arrive along the sun ray. The atmosphere
shell in front of the terrain already carries the inscatter between the camera
and the ground; what it cannot do is put light _on_ the ground, and a Martian
crater floor at low sun is not black in any photograph.

## Alternatives considered

**Bake the biome per vertex on the CPU.** It is where the geology already is,
and it would have been four more bytes on an attribute that exists. Rejected
because three of the four inputs are geometry the fragment stage holds anyway,
and because a per-vertex biome resolves boundaries at the mesh's resolution
rather than the screen's — the ice line on a Martian scarp is a per-pixel fact.

**Authored PBR material sets with hex-tiling and triplanar**, which is what
[TERRAIN-PLAN](../../TERRAIN-PLAN.md) § 7 specifies. Both techniques answer
questions an authored set asks: hex-tiling breaks the visible period of a tiled
texture and triplanar chooses which way to project one onto a curved surface.
The design bible's "few dozen authored assets" do not exist yet, so the detail
is gradient noise on the body-fixed position — which has no period to break and
no projection to choose. When the art budget lands, the detail field is the
seam, and both come back with the textures that need them.

**A per-face baked albedo cube for every body**, which would let a generated
world's _sphere_ show its own maria and ray systems the way a mapped one shows
its photograph. It is the right answer and it is not here: it needs a worker
task, a cube texture with a slot allocator, and a second consumer in
`render/planet.ts`. What it buys is the far half of the descent on bodies with
no map; what is already true is that the near half is the geology and the far
half is a plausible flat tint of the same colour.

**One absolute palette, tuned to look right.** Rejected on the first render: it
made every world sandstone, which is the thing this phase exists to end.

**Reading `BodyAppearance.colour` as a reflectance everywhere.** It is a
reflectance on a mapless body and a _tint_ on a mapped one — its own docstring
says so, and on Luna it is (1, 1, 1). Read as a reflectance it made lunar
regolith 0.88 against a published 0.136, and the lit side blew out to a white
disk.

## Consequences

The two halves of a descent agree. Measured either side of the eight-pixel gate:
Mars 4.6% apart in mean value with contrast inside 5%, Earth 0.02% apart — and
the pictures are the same picture. Luna comes out at 0.136 reflectance with its
mare at 0.073 against a measured 0.07, Enceladus keeps its tiger stripes, Mars
keeps its cap with bedrock showing on the scarps.

**Altitude may not be a difference of two planetary radii.** `length(anchor +
local) − datumRadius` puts both terms at 6.4 × 10⁶ on Earth where one float32
step is half a metre, so the water test — a band four metres wide — read a
quantized value, and the morph walked it across those steps every frame. Two
kilometres above an island chain that is the coastline visibly warping several
times a second. The algebraic form `(2(a·l) + l·l)/(|p| + |a|)` never lets the
large numbers meet.

**Nothing may take a screen-space derivative of a planetary position.** The map
UV did, and its mip level then changed at every patch boundary; the detail fade
did, and since `local` is linear across a triangle its derivative is constant
over the whole triangle, so the fade stepped per polygon. Both are analytic now
— the UV gradient from the tangential part of a precise step, the fade from
distance times the lens's own pixel angle.

**A varying may not take an attribute's name.** `varying(vec4(), 'terrainCover')`
beside `attribute('terrainCover')` is a redeclaration in the generated WGSL,
which surfaces as `[Invalid ShaderModule "vertex"]` with the real message on a
channel the page console does not carry, and a planet that draws nothing.

**Shading terrain with a real light exposes the mesh's own normals.** The
selection refines to about a pixel of error by design, so a low sun on saturated
ground aliases where a flat ambient fill could not show it. At device pixel ratio
2 the same frame is clean. The levers are the renderer's supersampling factor
and an LOD-aware normal filter.

**Deposits chosen from the mesh step at a level boundary.** Two patches covering
adjacent ground at different levels genuinely report different slopes for it, so
a weight read off the normal steps by the selection's own error — about 4% of the
drawn value on Earth's coastal plain. Widening the flatness bands to reach the
angle of repose takes near-flat ground out of the transition and does not account
for all of it. The fix is for the deposits to read the canonical field rather
than the mesh, which means more channels on the cover.

**The cover costs 0.55 to 1.0 ms a patch** against 8.2 to 36.9 before — 2.4% on
the atmosphered world that was already the most expensive, 6.7% on the cheap one.
Vertex memory is up 16.6%: eight bytes a vertex for the cover and its morph
target, against 203 KB of geometry.

## Related

- [ADR-0019](0019-the-geology.md) — the shape this puts a face on
- [ADR-0015](0015-terrain-level-of-detail.md) — the quadtree it is drawn over
- [ADR-0017](0017-the-lens.md) — the pixel angle the detail fades against
- [Content § biomes](../design/content.md#biomes) — what it has to produce
- [Art](../design/art.md) — the doctrine that the published map wins
- [TERRAIN-PLAN](../../TERRAIN-PLAN.md) § 7 — the phase this closes
