# The galaxy: the Milky Way from the canopy to the whole disk

One model of the Milky Way — stars, dust, gas — that the sky from inside a
system, the star survey and the view from outside all read, generated at
runtime from published parameters and a seed, with no image anywhere in it,
and continuous from the canopy to the whole disk. This page is the plan for
building it.

What this page is not: the galaxy map's interface, which
[galaxy](../../docs/design/galaxy.md#the-galaxy-map) designs and which draws on
what this builds; nebulae as objects; the zodiacal light, which is dust at a
different scale and gets a seam here rather than a section. Its brightness is
honest only through [the sensor](the-sensor.md) § 4: the band is 22 mag/arcsec²,
which a 1/60 s frame does not record and Composite integrates, and until that
exposure lands the sky draws through a provisional gain that says so.

| Landed                                                              | The record                                                                                          |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The frame: origin at the galactic center, +Y north, the disk in XZ  | `packages/universe/src/catalog/astrometry.ts`, [coordinates](../../docs/concepts/coordinates.md)    |
| ICRS → galactic, the Sun at 8.178 kpc and 20.8 pc north             | `astrometry.ts`, `SUN_POSITION`                                                                     |
| A double-exponential disk, normalized to 0.1 star/pc³ at the Sun    | `packages/universe/src/galaxy.ts`, `stellarDensity`                                                 |
| Procedural stars per 20 ly cell, seeded by cell, catalog subtracted | `galaxy.ts`, `generateCell`, [ADR-0005](../../docs/adr/0005-procedural-seeds.md)                    |
| The survey: a 100 ly cube, catalog first, procedure in a worker     | `engine/GameEngine.ts` `#maybeSurveyStars`, `workers/src/tasks.ts`                                  |
| The star field: 20,000 sprites on a shell                           | `scene/Starfield.tsx`                                                                               |
| The catalog: 7,123 systems to 150 ly, complete to 25 ly             | [catalogue](../../docs/guides/catalogue.md), [spike 3](../../docs/spikes.md#3--catalog-bundle-size) |

Not built: any dust, bulge, bar, arm, halo, or band; anything beyond the survey
cube; the naked-eye stars beyond 150 ly, so Orion's belt is three procedural
stars in the wrong places; the Regional and Galactic tiers
[galaxy](../../docs/design/galaxy.md#scale-tiers) specifies; the planetarium's
ceiling above 100 ly.

---

## Where the numbers come from

A **published** figure carries its source. A **measurement** is from
`design/plans/perf.md`'s rig, an Apple M5 at 1600×900 DPR 1. A **budget** is a
claim a phase measures. Every galactic parameter below is published, and where
two sources disagree the range is given, because the model's job is to be
checkable: a player who knows where Scutum's tangent is will look.

The frame is already right, which is the fact this plan stands on. The universe
origin is the galactic center; `heliocentricToUniverse` puts the Sun at
(−8,178 pc, +20.8 pc, 0) in simulation axes; galactic longitude zero is +X from
the Sun and the north galactic pole is +Y; rotation is clockwise seen from that
pole. Nothing here needs a new frame. Every catalog star is already in this one,
which is what lets the band and Sirius agree by construction rather than by
alignment.

---

## 1. Principles

**One field, every consumer.** `packages/universe/src/galaxy/` holds a pure,
seeded, versioned field over galactocentric parsecs — number density per stellar
population, dust density, H II emission — and three consumers read it: the sky
bake from inside, the volume from outside, and the population sampler. The CPU
is the reference; the GPU kernel is a port held to a measured bound, the way
[ADR-0023](../../docs/adr/0023-the-gpu-producer.md) holds the terrain producer.
A picture of the galaxy that came from a second model would be the two-atmospheres
problem in a bigger coat.

**Never generate a star the catalog would have seen.** `CellContext.completeRadius`
is this rule for a sphere; the horizon of knowledge is not a sphere. It is a
magnitude: a procedural star may exist only where its apparent magnitude is
fainter than the catalog's limit at that distance, and the limit is a property
of the catalog version, carried as an input the way `completeRadius` is. A
property test states it and a Poisson draw cannot break it.

**Measured where measured, generated where not.** The disk, bar, arms and warp
are published parameters. The clouds that shape the band from Earth — the
Aquila and Cygnus rifts, Ophiuchus, Taurus, Perseus, Orion, the Coalsack — are
placed from 3D dust maps as named ellipsoids, because a player can check them
against the sky; below their resolution the dust is seeded noise. The 157
globular clusters are a catalog. The Sun sits in the Local Bubble, which is
published too.

**Brightness is integration.** The field emits in physical units, calibrated
against the integrated starlight the sky actually has, so the band's visibility
is a consequence of the sensor's exposure and not of a slider. Direct at 1/60 s
does not show it. Composite does. That is the bible's thesis, and this is the
first thing in the game that demonstrates it.

**Continuity is a cache, not a cross-fade.** The sky from inside is the same
march as the view from outside, cached at the observer's position while the
observer is within a parallax budget and evaluated live otherwise — the pattern
`Starfield.tsx` already uses for its shell. There is no second representation
to fade to. One field at two costs.

---

## 2. The model

All of it goes in `stellarDensity`'s file, whose comment promises exactly this:
arms, bar and halo change that function and nothing else. Coordinates are
galactocentric parsecs in simulation axes; `R` is the in-plane radius, `z` the
height, `β` the azimuth from the Sun's direction, increasing with rotation.

**Stars, by population.** Each population carries a density, a mean luminosity
and a color temperature, so emission per unit volume is a product and the
population mix is what colors the picture.

| Population | Density                                               | Parameters (published)                                                                                                      | Color                 |
| ---------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Thin disk  | `exp(−R/R_t −                                         | z                                                                                                                           | /z_t)`, arm-modulated | `R_t = 2.6 ± 0.5 kpc`, `z_t = 300 ± 50 pc` (Bland-Hawthorn & Gerhard 2016)                                             | 5,000 K       |
| Thick disk | `exp(−R/R_T −                                         | z                                                                                                                           | /z_T)`                | `R_T = 2.0 kpc`, `z_T = 900 pc`, 4% of the thin disk's local density, 12% of its column                                | 4,600 K       |
| Young arms | thin disk × `A · Σ exp(−d²/2w²)` on the arm ridges, ` | z                                                                                                                           | ` scale 19 pc         | ridges from Reid et al. 2019 (below); `w(R) = 336 + 36 (R − 8.15 kpc) pc`; contrast `A` ≈ 3 in young stars, 0.2 in old | 12,000 K + Hα |
| Bar/bulge  | boxy triaxial `exp(−(x'/a)²…)` in the bar frame       | angle 27° ± 2° to the Sun–center line, half-length 5.0 kpc, axis ratios 0.5 and 0.26, scale height 180 pc, `1.84 × 10¹⁰ M☉` | 4,300 K               |
| Halo       | `(1 + r/r_h)^−3.5` spheroid, flattening 0.6           | ρ ∝ r^−3.5 from the globular distribution (Harris)                                                                          | 4,800 K               |

Normalized so that `stellarDensity(SUN_POSITION)` is exactly `LOCAL_DENSITY`,
0.1 star/pc³, which keeps `generateCell`'s expected counts around Sol where they
are today; the Local arm's width is 310 pc, so its modulation across the 100 ly
survey cube is under 0.1%. Total integrated count lands between 10¹¹ and
4 × 10¹¹, the published range, and a test says so.

**Arms.** Reid et al. 2019, Table 2: log-periodic with one kink,
`ln(R/R_kink) = −(β − β_kink) tan ψ`, with a pitch angle on each side of the
kink and a Gaussian half-width. Norma, Scutum–Centaurus, Sagittarius–Carina,
the Local arm, Perseus and the Outer arm, with the 3 kpc arm inside; Norma–Outer
and Scutum–Centaurus–OSC are single wrapped arms. The test that this is right
is not a picture: from the Sun, the arm tangencies fall at the longitudes
Hou & Han 2014 measure from 815 H II regions — **Scutum 30.5°, Sagittarius
49.3°, Carina 282°, Centaurus 310°, Norma 328°**, the near 3 kpc arm at 24° —
and `arms.test.ts` asserts each within 3°. Beyond 20 kpc the disk warps:
`z = a (R − R_w)^b sin(φ − φ_w)`, line of nodes 17.5° from the Sun–center line
(Chen et al. 2019), which is what makes the outside view's rim lift the way
the real one does.

**Dust.** An exponential disk with two vertical components — scale heights
**81 and 152 pc**, scale length 2.26 kpc (the 2025 two-component fit; Drimmel &
Spergel's single 134 pc disk is the alternative) — normalized to about 1 V
magnitude of extinction per kiloparsec in the plane, with the arm lanes offset
inward of the stellar ridges, and a log-normal multiplicative noise term of
four octaves down to about 1 pc (the GAMER recipe, Groeneboom & Dahle 2014).
Reddening is `τ ∝ λ⁻¹`, three coefficients, so the band goes brown behind the
rift and the bulge reads warm through its foreground. On top of the field, a
table of **local clouds** as ellipsoids with published centers, extents and
column densities, from the Lallement 2022 and Edenhofer 2023 maps: the Aquila
Rift at 225–500 pc, the Cygnus Rift, Ophiuchus at 130, Taurus at 140, Perseus,
Orion, Chamaeleon, Lupus, the Coalsack at 180. And the **Local Bubble**: the
Sun sits inside a cavity about 165 pc across with almost no dust (Zucker et al.
2022), which is why the first ten parsecs of every ray can be skipped and why
the nearest dust anything sees is a hundred parsecs off.

**H II regions.** Along the young-arm ridges only, within 40 pc of the plane,
Poisson-disc clumps seeded from the arm coordinate, each a small Gaussian
emitter at Hα's 656 nm and a shell of OB light. They are the pink knots along
the arms in every photograph of a spiral, they are the primary arm tracer in
the literature (Anderson et al. 2014, over 8,000 of them), and they are the
first thing in the game that emits a narrowband line — which is what the
sensor's filter seam is waiting for.

**Globular clusters.** Not modeled: **cataloged**. Harris 2010 lists 157 with
positions, distances, half-light radii and magnitudes, and Vasiliev & Baumgardt
2021 give 162 accurate distances from Gaia; the ingest packs them like the star
catalog does, and each draws as a sprite whose halo scales with its half-light
radius. Omega Centauri and 47 Tucanae are the two a player will know.

**Two Clouds and Andromeda**, later. The LMC at (280.46°, −32.89°) and 50 kpc,
the SMC at (302.79°, −44.30°) and 62 kpc, M31 at (121.17°, −21.57°) and 770 kpc:
each is the same field with its own parameter record, drawn from outside at its
real direction and size. Named as a phase so the parameter record is designed to
allow it, not scheduled.

**Calibration.** The field's emission constant is fitted so that three
published numbers come out, and three tests hold them:

| Check                                                   | Published                                                           | Tolerance |
| ------------------------------------------------------- | ------------------------------------------------------------------- | --------- |
| Integrated starlight from the Sun, mid-latitude average | 75 nW m⁻² sr⁻¹ ≈ **23.2 mag/arcsec²** (Masana et al. 2021, GAMBONS) | 0.3 mag   |
| On the plane at l = 45°, a rift sightline               | 22.3–23.4 mag/arcsec² (Masana, Table 3)                             | in range  |
| The galaxy's total absolute magnitude                   | **M_V = −21.37**, B−V 0.73 (Licquia & Newman 2015)                  | 0.3 mag   |
| Face-on central surface brightness from outside         | 21.65 B mag/arcsec² (Freeman's law)                                 | 0.3 mag   |

The unit is the sensor's: luminance in cd/m², and 22 mag/arcsec² is
2 × 10⁻⁴ cd/m², thirteen orders below the Sun's disk — which is the range the
sensor plan's pre-exposure exists to carry. The bake stores nW m⁻² sr⁻¹, values
from 10 to 10⁴, because the same numbers in W m⁻² sr⁻¹ sit at 10⁻⁸ and below
half-float's normal range.

**Versioning.** The field is a generation algorithm and changes to it are
versioned through `algorithm()` and `manifest()` like every other one
([ADR-0005](../../docs/adr/0005-procedural-seeds.md)). One consequence is worth
stating plainly: `proceduralCount` reads `stellarDensity`, so any change to the
field moves which procedural systems exist beyond the survey cube and what their
ids are. Nothing persistent references them yet. The model lands once, early,
in one version, and the fitted constants are frozen in the manifest so a later
recalibration is a new version with a diff, not a drift.

---

## 3. From inside: the sky bake

The observer is inside the disk, 20.8 pc off a plane whose dust is 81 pc thick,
and a low-latitude ray runs 25 kpc while everything that matters to its picture
happens in the first few hundred parsecs. So the integrator is not a uniform
march.

**The march.** Per texel direction, log-spaced samples from **10 pc to 30 kpc**
— the first ten parsecs are the Local Bubble and empty — 256 steps at 3.2%
growth, so the step is 6 pc where the clouds are and 900 pc where only the smooth
disk remains; front-to-back with extinction `T ← T·exp(−κ dt)` and emission
accumulated behind it; the smooth exponential terms integrated analytically per
ray where the noise is off, which is most of the way out. The stars the sprite
layer resolves are masked out of the emission — the haze is the light of stars
fainter than the resolved limit, which is how GAMBONS builds its integrated
starlight map — so a star is never drawn twice.

**Where it goes.** A cubemap, six faces of **1024² RGBA half-float, 50 MB**,
on a fine-pointer machine; 512² and 12.6 MB on a coarse one — the same query
`output.ts` already asks to pick a DPR ceiling. At 1024 a texel is 0.088°, a
pixel at the flight lens over 1080 lines is 0.06°, and the dust is diffuse at
that scale; the 2048² alternative is 200 MB and SpaceEngine ships it as an
option for exactly this reason. Drawn as the background — before the star
shell, no depth write, the same custom blend as the star field so alpha never
reaches the canvas — through the sensor's exposure like everything else.

**When.** Six faces at 1024² and 256 samples is 1.6 × 10⁹ field evaluations
(budget: **120 ms** on the M5, **500 ms** on the target laptop), which is a boot
task, tiled — 96 dispatches of about 6 ms behind the boot overlay, registered
with `render/warmup.ts` so the progress total includes it — and a progressive
one: a 128² pass first, 2 ms, so the first frame has a sky, refined over the
following second. The bake goes in the IndexedDB cache keyed on the field's
version and the observer's cell, because it is regenerable content and
[ADR-0007](../../docs/adr/0007-persistence.md) says that is what a cache is for.

**How long it is valid.** The nearest dust is about 100 pc away, so moving one
parsec swings it 0.6°, and a texel is 0.088°: the budget is **0.15 pc**, thirty
thousand astronomical units. No system is that wide. Within a system the bake
is invariant; a jump rebakes at arrival, behind the tunnel; a planetarium fly-to
that leaves the budget hands the sky to § 5's live march until it settles.
This is the `WrittenShell` pattern — a record of what was baked and the budget
it holds under — and `Starfield.tsx` shows the shape.

**Precision.** The kernel takes the observer in galactocentric parsecs as
float32. At 8 kpc that resolves 5 × 10⁻⁴ pc, a hundred astronomical units, and
the finest feature in the field is the 1 pc noise octave — two thousand times
larger. The terrain kernel's split-frame rule
([ADR-0023](../../docs/adr/0023-the-gpu-producer.md)) exists because a crater
is 3 × 10⁻⁷ rad against a float32 direction's 6 × 10⁻⁸; nothing here is within
three orders of that ratio, and importing the machinery would be a comment
nobody could justify. The number is written here so the next reader can check
it rather than reach for it.

**The GPU kernel** `render/galaxyKernel.ts` is a TSL port of the field, and
`galaxyKernel.gpu.test.ts` holds it to the CPU at a few hundred sample points
and holds one full ray's integral to the CPU march within 1%. The calibration
tests run on both.

---

## 4. The population: stars the field resolves

The survey draws every star in a 100 ly cube. The sky needs more than that in
two directions: the bright far stars that make constellations, and the faint
haze that is not stars at all. The haze is § 3. This section is the middle.

**The naked-eye sky is a catalog, not a model.** Betelgeuse is 550 ly out,
Rigel 860, Deneb 2,600: every star that makes a constellation is beyond the
150 ly bundle and is today a procedural star in the wrong place. The ingest
gains a second asset, `stars-sky.irsc`: every HYG row with V ≤ 6.5 beyond
150 ly — about 9,000 stars, **60 KB brotli** at the 16-byte record — at their
published positions, loaded and indexed by cell like the rest. They are catalog
stars in every sense, resolvable by id, and the only thing that distinguishes
them is that the travel survey never reaches them. Orion is then correct, and
a player who checks it against the window finds it so. The extension to V ≤ 8,
about 40,000 stars and 250 KB, is a measurement of the cold download against
its 4 s budget, not a decision made here.

**The completeness rule, as a magnitude.** With the sky asset in, the catalog's
limit is a function of distance: complete to about V 7.5 inside 150 ly (HYG's
histogram peaks at 8), to V 6.5 beyond it. A procedural star exists only if
its apparent magnitude is fainter than that limit at its distance, and the
limit rides on `CellContext` as `completeRadius` does — two numbers, pure in
the catalog version. `population.test.ts` draws ten thousand cells and asserts
no procedural star violates it. This replaces the sphere, and it is what makes
the horizon of knowledge the irregular, class-dependent surface
[galaxy](../../docs/design/galaxy.md#completeness-is-the-real-constraint) says it
has to be.

**Levels.** Gaia Sky's magnitude-space octree is the construction: each level
holds a disjoint band of absolute magnitude, brighter bands at coarser cells.
Here level 0 is the existing 20 ly cell and everything in it; level `k` is a
cell of `20 · 2^k` ly holding only stars brighter than `M_k`, seeded by
`(level, cell)` so the two draws are independent and order-free; a level is
swept to the radius at which its band drops below the resolved limit. The
count is bounded by the sky: to apparent V 8 there are about 40,000 stars in
the whole sky, to V 10 about 350,000. The sprite budget is **200,000**, up from
20,000, and the reason that is affordable is the next paragraph.

**The shell moves to the GPU.** `Render/starfield` is the perf plan's largest
span, 0.62–0.79 ms under warp, because the sprite positions are rewritten on
the CPU whenever the origin leaves a parallax budget that binds on the system's
own sun. With positions uploaded once per survey as cell-relative float32 plus
a per-cell offset, the vertex stage projects each star onto the shell from an
origin uniform, and a translation rewrites nothing; only a re-survey or a
change of anchor frame uploads. That closes the perf plan's item 3 as a side
effect of needing ten times the stars, and it is measured the same way.

**Extinction on the resolved stars.** A star behind the Aquila Rift is
reddened and dimmed by the dust in front of it; the sprite's color and flux
carry `exp(−τ)` per channel, integrated along the line from the observer
through the same dust field, sixteen samples in the vertex stage. Without it
the band's dark lanes would have bright stars sitting in front of them, which is
the giveaway in every additive star field ever drawn.

---

## 5. From outside: the volume

The planetarium's ceiling is 100 ly, an absolute cap so that "zoom out until the
neighboring stars appear" works at a moon as well as at a star. It rises to
100 kly through the three tiers [galaxy](../../docs/design/galaxy.md#scale-tiers)
names, and the tiers are regimes of one renderer, chosen by the camera's
distance `d` from the Sun:

| Regime   | `d`             | The sky                                      | The stars                                                                                |
| -------- | --------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Local    | under 0.15 pc   | the bake                                     | catalog and population sprites                                                           |
| Regional | 0.15 pc – 1 kpc | the live march, camera-centered, quarter res | the same sprites, the near field masked from the march                                   |
| Galactic | over 1 kpc      | the live march over the disk's bounding slab | the population collapsed to its cell counts; clusters, H II knots, the Clouds as sprites |

**The live march** is the same kernel as the bake with different sampling: a
ray–slab intersection with the disk's bounding box, 96 uniform steps between
the two hits with a blue-noise start offset, at **quarter resolution with
temporal reprojection** — one of four pixels per 2×2 block per frame, the
_Horizon Zero Dawn_ cloud construction, which is about 2 ms there for a far
more expensive integrand (budget: **2 ms** at 1080p). The observer and the ray
are in galactocentric parsecs; the result composites through the depth buffer
so a body in front of the galaxy occludes it. Regime boundaries are not
switches: the march's sample density and resolution scale with `d`, and the
bake is what the march converges to as `d → 0`. `galaxyKernel.gpu.test.ts` asserts
that identity at three directions rather than trusting the argument.

**What the picture is.** Face-on, the bar at 27° with the arms wrapping off its
ends, the young-arm ridges blue with pink H II knots, the dust lanes inside the
ridges, the bulge warm, the halo's globulars scattered to 40 kpc; edge-on, a
thin bright plane with the dust lane cutting it, the boxy bulge, the warp
lifting the rim past 20 kpc. Every one of those features is a published number
in § 2, and the outside view is the check on all of them at once — the reason
to build it is that a galaxy that looks wrong from outside is a field that is
wrong from inside.

**Brightness from outside** is not a special case. Surface brightness is
distance-invariant, so the disk from 50 kpc is the same 21.65 mag/arcsec² it is
from inside, and the meter exposes for it as it would for a night sky; the Sun
is a sprite at its magnitude, clipped by the curve. What the galaxy map does —
a pinned exposure, a bounded sprite count — is the map's business, and it is
the one place a fixed gain is honest, because the map is an instrument and says
so.

**Culling** is trivial and named so it is not forgotten: below about 50 px of
subtended size the march is replaced by a sprite of its own last frame, which is
also how the two Clouds and M31 draw at any distance.

---

## 6. Declined, with the reason

- **A panorama.** ESO's and Gaia's all-sky images are what every planetarium
  uses, Stellarium included; Gaia's is CC BY-NC besides. An image is a fixed
  exposure of one viewpoint with the star halos baked in, and it is the thing
  this page exists to not do.
- **A point cloud only** — Celestia's Milky Way, a million sprites sampled from
  a template. It aliases, it has no dust, it saturates toward the center under
  additive blending (Gaia Sky's Figure 17 is the failure), and from inside it
  is a cloud of billboards Gaia Sky had to dither-discard for occlusion until
  it added a volume anyway.
- **A 3D texture of the field for the outside view.** 256³ RGBA half-float is
  134 MB and OpenSpace's 1024×1024×128 is the same idea larger. The analytic
  field is cheap enough to evaluate per sample, and a texture would be a
  second copy of the model to keep in step. If the march measures over budget
  the fallback is a 256×256×64 slab at 17 MB, and it is the same kernel
  sampling a texture instead of a function.
- **A density-wave particle galaxy** — the tilted-ellipse construction of the
  WebGL demos. Pretty, 2D, unrelated to the catalog's coordinates, and it
  cannot be seen from inside.
- **Shrinking the sky bake to save memory** by baking only the smooth part at
  low resolution. Emission behind dust and in front of it do not separate, so
  the product is what has to be stored at the dust's resolution.

---

## 7. Phases

**Phase 0 — the sky catalog.** The `stars-sky.irsc` asset from the ingest,
loaded beside the local one, the constellations real. Gate: Orion's seven
brightest stars at their HYG positions, the bundle within the cold-download
budget, the survey's counts unchanged inside 150 ly. Independent of everything
below and worth landing first.

**Phase 1 — the field.** Arms, bar, thick disk, halo, warp, dust with the
local clouds and the Local Bubble, H II, populations and colors, the calibration
constants, all in `packages/universe/src/galaxy/`, versioned. The CPU reference
march and a `pnpm sim --sky` plate that writes the six faces to a PNG for
looking at. Gate: `arms.test.ts` tangencies within 3°; `stellarDensity` at the
Sun exactly `LOCAL_DENSITY`; the integrated count in range; the four
calibration numbers within tolerance on the CPU; the survey cube's expected
counts moved by less than one star per cell.

**Phase 2 — the bake.** The TSL kernel and its GPU test, the tiled progressive
bake, the cubemap draw, the cache, the parallax budget, boot registration.
Gate: the galactic center at RA 17h45m40s, Dec −29°00′28″ in a captured frame;
the plane's pole at the NGP; the Aquila Rift where it is; the surface
brightness at three sky positions within 0.3 mag on the GPU; bake time
measured on the M5 at 1024² and recorded here; the frame cost of sampling it
measured (budget: **0.05 ms**). And a plate from Earth orbit beside the
reference photograph in `design/inspiration`, for the eye, never shipped.

**Phase 3 — the population.** The magnitude rule, the levels, the GPU-side
shell, extinction on the sprites, the sprite budget. Gate: `population.test.ts`
holds the rule across ten thousand cells; `Render/starfield` under warp
measured against the perf plan's 0.62–0.79 ms with ten times the stars.

**Phase 4 — the outside.** The live march, reprojection, the regimes, the
planetarium ceiling at 100 kly, the globular catalog, the H II knots, the
bake-equals-march identity test. Gate: 2 ms at 1080p measured; the face-on
central brightness within 0.3 mag; a fly-to from Earth to 30 kpc above the
plane with no frame showing a switch, reviewed as a `--cast`.

**Phase 5 — seams.** The two Clouds and M31 as parameter records; the galaxy
map's horizon shell from the per-class limit; the `emission` MRT for the
sensor's narrowband filter, fed by the H II knots; the zodiacal light as the
same integrator over the solar system's dust, at AU scale, a plan of its own.

---

## 8. The order it is worth taking

1. **Phase 0.** Small, independent, and the most checkable thing on this page.
2. **Phase 1 with the sensor's phase 1 beside it.** The field is pure
   TypeScript and needs no renderer; the exposure is what makes its brightness
   mean anything, and the two can land in either order but should land close.
3. **The bake.** The first frame of the band from Earth is the picture this
   whole plan is for, and everything after it is a refinement.
4. **The population**, because it closes a perf item while it grows the sky.
5. **The outside**, last, because it is the check on all of the above and the
   least of the game's minutes are spent there.

---

## Caveats that shape these numbers

- **Every millisecond and megabyte above is a budget until its phase.** The
  bake cost is a flop count against a nominal GPU; the march is a comparison
  to a published figure for a different integrand.
- **The bulge's sky brightness is unverified.** The 21–22 mag/arcsec² toward
  Sagittarius that every description quotes traces to Leinert et al. 1998's
  tables, which could not be read for this page; the calibration stands on
  Masana's mid-latitude and l = 45° figures until it can.
- **Hou & Han's arm fits use their own azimuth origin.** Their tangency
  medians are used as the test; their `(Rᵢ, θᵢ, ψᵢ)` fits are not used until
  their Figure 2 has been read for where the Sun sits.
- **The completeness limit is a claim about HYG.** V 7.5 inside 150 ly is read
  off the magnitude histogram's peak, and the ingest should compute the actual
  per-class limit from the file and write it into the manifest rather than
  carry a constant.
- **The field is normalized at the Sun and calibrated at the sky.** Those are
  two constraints on one constant per population, and if they disagree the
  disagreement is a finding about the population mix, not a tolerance to widen.

## Not in this plan, deliberately

Nebulae as objects with their own emission structure; the aurora, airglow and
zodiacal light, which are emitters at other scales; the galaxy map's
interactions, filters and router; binaries and multiples; any galaxy but this
one and its three neighbors.

## Reproducing

```bash
# the six faces as a plate, from the CPU reference, for looking at
pnpm sim --sky --out sky.png

# the field, the arms and the population rule
pnpm vitest run packages/universe/src/galaxy

# the kernel against the CPU, the bake against the march, the calibration on the GPU
pnpm test:gpu -- galaxyKernel

# the sky from Earth orbit, and the frame cost of the bake's sample
node scripts/drive.mjs --url 'http://localhost:5173/planetarium?at=g:milky-way/s:SOL/b:2' \
  --shot band-from-earth.png --js "await ir.gpu(40)" --down   # ir.gpu is the sensor plan's phase-0 verb
```
