# ADR-0013: A body's figure is a radius grid, and it is a measurement

Status: accepted · 2026-08-25

## Context

Every body the renderer drew was a sphere. Formally it was a unit sphere scaled
by the equatorial radius and squashed along the spin axis by `polarRadius /
radius`, which is a spheroid — the right shape for anything hydrostatic
equilibrium got hold of, and a genuinely important one. Saturn is 9.8% oblate
and reads as wrong long before anybody can say why.

It is not the right shape for the rest of the Solar System.

Phobos is 27 × 22 × 18 km with Stickney, a nine-kilometer crater, taken out of
one end. Bennu is a spinning top with a ridge round its equator that its own
rotation raised. 216 Kleopatra is a dog bone 217 km long. 1P/Halley is a black
peanut. Draw any of those as a sphere and you have not simplified the body, you
have drawn a different object — and `docs/design/art.md` is explicit that what a
player can check has to be true.

The pressure to fix it came from adding the bodies. `packages/universe/src/solar`
carried eight planets and twenty moons, every one of them round. It now carries
those plus fifty-nine dwarf planets, asteroids and comets, and forty-two more
moons — twenty-one of the planets' that are rocks, and twenty-one going round
something that is not a planet. Ninety-two of Sol's hundred and twenty-nine
bodies are not spheroids, and — because generated moons below the rounding
threshold are not either — neither is a large fraction of every other system in
the galaxy.

## Decision

**A body carries a `figure` when it is not a spheroid, and null when it is.**
Null means round; it does not mean unknown. `BodyFigure` holds the second
equatorial half-extent (`radius` is `a`, `polarRadius` is `c`, this is `b`), a
key naming a shipped shape model, and a residual roughness for the generated
case.

**A shape model is a latitude/longitude grid of radii**, shipped as a small
binary in `data/shapes/`, and the renderer builds a mesh from it in exactly the
layout Three.js's `SphereGeometry` uses.

**The generated case and the measured case are the same case.** A body with no
model gets a radius grid out of its own address seed, on its measured
half-extents, through the same mesh builder. The renderer has one code path for
"not a sphere" and it does not know which kind it is holding.

## Alternatives rejected

**A triangle mesh per body.** More general — it can hold an overhang, which a
radius grid cannot. Rejected because the generality is unused and the costs are
not:

- **Every surface map in this project is equirectangular** and was written for
  a sphere with a known UV layout. A grid mesh _is_ that sphere with the radii
  moved, so Phobos takes an albedo map through the same material as Mars, seam
  and poles included. An arbitrary mesh needs a parameterization invented for
  it and a seam split done by hand.
- **Level of detail is subsampling.** Take every second row and column, and the
  coarse mesh is the fine one's own samples rather than a decimation with its
  own error. A body may not change size when it crosses a tier.
- **The file is the data.** Sixteen bytes of header and one `uint16` per
  sample: Phobos at 256 × 129 is 65 KB, and the whole set of twenty-five is
  937 KB. A mesh needs positions, indices and normals.
- **The sources are mostly already grids.** Peter Thomas's satellite models and
  Philip Stooke's small-body atlas both publish latitude, longitude and a
  radius, one sample per line.

The cost is real and is named: a radius grid cannot represent a surface that is
not star-shaped about the body's center. Every published model run through the
ingest is — including the bilobate ones, because a neck is a saddle rather than
a roof — and the ingest _measures_ it, comparing the reconstructed volume
against the source mesh's own and refusing anything that loses more than 6%.
Kleopatra, the shape most likely to break it, reconstructs to 100.6%.

**A displacement in the shader, on the existing sphere.** Cheaper still, and
wrong for the reason every displacement map is wrong: the vertex normals stay
the sphere's, so a crater shades exactly as if it were not there. Recomputing
normals in the shader means differencing the height field per fragment, which is
three extra texture samples on a body that is forty pixels across.

**Keeping `figure` out of the core and doing it all in the renderer.** The
figure of a body is a measurement — it is where the surface _is_ — and it sits
beside `radius` and `polarRadius` for the same reason those do. What is
presentation is the seed the generated field is drawn from, and that stays in
the renderer.

## Consequences

**A third radius exists and three files have to agree about it.** `radius` is
`a`, `figure.intermediateRadius` is `b`, `polarRadius` is `c`, sorted. The
half-extents of a body with a shipped model are _measured off that model_ by the
ingest rather than transcribed beside it, so the number the renderer scales by
and the geometry it scales cannot drift apart.

**`flattening` must not be applied to a body with a figure.** The mesh already
carries the polar squash; applying both squashes it twice. This is the one place
the renderer branches, and it is three lines in `Bodies.tsx`.

**A body may be round and still have a figure.** Haumea is a Jacobi ellipsoid —
1050 × 840 × 537 km, in hydrostatic equilibrium, and tri-axial because it turns
once every 3.9 hours. It is the one body where "round" and "spheroid" come
apart, and it is named in the test that checks the rest of the rule.

**The roughness of a generated body is calibrated, not chosen.** Across the
twenty-five shipped models the residual radial deviation about each body's own
best-fit ellipsoid runs 0.023 to 0.61 with a median of 0.090, and
`irregularFigure` draws from that. The first version of the noise delivered 0.03
when asked for 0.18, because an fBm's standard deviation is a sixth of its
range and nothing divided it out; the property test that would have caught it
now exists.

**Orbit traces had to learn what a small body is.** The planetarium drew a
subject's siblings for context, which was eight ellipses and is now a hundred
and twenty-nine lines with the subject somewhere behind them. `OrbitPath` gained a
`kind` and rubble is drawn only when it is the subject.

**`SYSTEM_ALGORITHM` went to 3.** Generated systems now contain six to eighteen
small bodies each. Nothing a save could already point at moved — that is what
issue ordinals ([ADR-0009](0009-issue-ordinal-addressing.md)) are for — but a
system contains things it did not, and the manifest has to say so.
