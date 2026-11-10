# The weather: clouds, storms and rain

What the air still lacks is everything that moves in it. This plan replaces
the cloud deck — a textured sphere — with a volumetric cloud field that is a
closed-form function of the body, the place and the simulation time, drawn
from one function from geostationary distance to the inside of a cumulus. It
adds what rides on that field: the shadow it casts on the ground, the sea, the
sphere and the air; the light under an overcast; the clouds the sea reflects;
storms, rain, lightning and fog; and the bows and glories its droplets make.

The weather is there to make the picture. It is presentation: nothing in it is
canonical, and under time warp it is allowed to be approximate. What stays
strict is what a viewer would see break — continuity through a descent, one
shadow on the ground and the sphere, light that agrees with the sky it stands
under.

It is a plan, so it promises. When a phase lands, its decision moves into an
ADR and the section here goes; cite the ADR, not this page.

Phase 0 has landed, and ADR-0063 to ADR-0066 hold what it decided;
[the working notes](weather/README.md) say where the work stands and what
phase 1 inherits.

| Reads with                                                                        | For                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [ADR-0056](../../docs/adr/0056-the-air-is-measured-and-its-gain-is-pi.md)         | The air the clouds stand in, its tables and its one march  |
| [The air: what is left](the-air.md)                                               | Its open defects, two of which this plan closes on the way |
| [ADR-0037](../../docs/adr/0037-the-enhanced-camera.md)                            | The camera that compresses what the clouds produce         |
| [ADR-0044](../../docs/adr/0044-the-sensor-reconstructs-the-display.md)            | The scene pass, the reactive attachment and reconstruction |
| [Art direction](../../docs/design/art.md#continuity--the-no-pop-in-specification) | The continuity specification every phase is held to        |
| [Perf](perf.md#the-camera)                                                        | The frame the clouds have to fit in                        |

**Where the numbers come from.** The weather's own costs are measured on the
Mac mini (Mac18,5, Apple M6, 32 GB): the production build, Chrome 157, WebGPU,
at 1920×1080 and at 2880×1800, base and candidate interleaved in one boot. The
frame's passes are in
[ADR-0063](../../docs/adr/0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md)
and the caches' in
[ADR-0064](../../docs/adr/0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md),
each with the commit it was taken at. **Every weather figure is the M6
mini's.** The plan's budget basis is an Apple M5, on which none was measured,
and no factor between the two machines is known. The frame the weather has to
fit in is perf's, taken on that M5 under Chrome 152. A cost in §9 with no ADR beside
it is a target and names the phase that measures it, and every borrowed figure
names its engine and its hardware. Microphysical and climatological figures
carry their source where they are used.

---

## 1. What the tree draws today

- **The deck is a textured sphere.** `createCloudMaterial`
  (`render/planet.ts`) is a second sphere drawn transparent over the body,
  Lambertian with a 4% floor, a terminator wider than the ground's, and a tint
  toward the body's authored sunset as the sun drops. Earth's map is NASA's
  `cloud_combined_2048`, 2048 × 1024 — 19.6 km a texel at the equator — with
  its luminance moved into alpha. It is two days of visible imagery and a third
  of thermal infrared over the poles, with the gaps between orbits near the
  equator filled by hand
  ([NASA](https://science.nasa.gov/earth/earth-observatory/the-blue-marble-true-color-global-imagery-at-1km-resolution/),
  [the map's author](https://science.nasa.gov/blogs/earth-matters/2011/10/06/crafting-the-blue-marble/)).
  It drifts at 25.5 hours against the 23.93-hour day
  (`packages/universe/src/solar/bodies.ts`) and never changes.
- **It stands twice as high as the weather.** The shell is lifted to at least
  0.4% of the radius (`render/bodyUniforms.ts`), 25.5 km over Earth, because a
  shell at the deck's own 12 km shows no parallax at the limb. Real cloud tops
  overhang the limb because they have height; a sphere has none to show.
- **Nothing is overhead on the ground.** Coverage clears over the last quarter
  of the shell's altitude as the eye descends (ADR-0037), so a walker on Earth
  stands under a clear sky at every hour, and `cloudEntry.gpu.test.ts` holds
  the coverage at zero once the eye is under the shell.
- **The shadow stops at the descent gate.** The sphere projects the deck's
  alpha along the sun at 0.55 (`cloudShadow`); `render/terrain.ts` and
  `render/water.ts` carry no cloud term at all. The step is rule 59 the other
  way round: a term on the sphere that the ground does not have.
- **The sea reflects the air, not a sky with weather in it.** `render/water.ts`
  mirrors `skyColor` and `skyOverhead`, uniforms from the air's tables, so no
  cloud could appear in it.
- **No generated world has a cloud.** `packages/universe/src/system.ts` builds
  every generated body with `clouds: null`, so a wet world outside Sol stands
  under a clear sky at every hour, from every height.
- **No night side is moonlit.** The rig stages one star (`scene/CameraRig.tsx`),
  and earthshine lights Luna alone (`render/radiance.ts`). A night cloud is
  black.
- **Venus, Titan and the giants are each something else.** Venus's deck is a
  4.2-day map at 60 km and opacity 1, and the sulfuric family is eight optical
  depths in the air's tables (ADR-0056). Titan has no cloud sphere. A giant's
  bands are its map, sheared by a zonal-jet warp at the measured magnitudes.
- **The air has no temperature and no wind.** It is isothermal and exponential
  (`packages/physics/src/rigidBody.ts`; the roadmap's "no layers, no weather,
  no wind"), so nothing knows a freezing level, a tropopause or which way a
  cloud should move.
- **The sun is occluded only by spheres.** The flare's occluders are analytic
  (`render/flareMath.ts`), and the hull's key light is the star's staged
  sunlight (`scene/CameraRig.tsx`). A cloud dims neither.
- **One march with history exists.** `GalaxyTemporalVolume`
  (`render/galaxyTemporal.ts`) marches interleaved rays at a stride of four —
  a sixteenth of its history's pixels a frame — reprojects them through an
  emission-weighted distance, clamps the history to the current neighborhood
  and is read by the galaxy's own material. It is the template for the clouds'
  temporal pass, and `ir.passes()` already names its two passes.
- **What a march costs here.** Spike 2 measured a single-scattering march of
  32 view by 8 light samples at 1920×1080 at 7.27 ms on this M5, the same
  through TSL as through hand-written WGSL (`docs/spikes.md`): about 13 ps a
  sample. That is the throughput of one arithmetic shader and no bound on a
  texture-bound one. Beside it the repository measured a whole frame at
  19.4 fps with one-channel 3D noise and 11.9 with four
  (`render/noiseTexture.ts`).

## 2. The pictures this is for

Each is a plate the phases are judged on, against a photograph of the real
thing. A plate is a preset — an address, a framing, a lens and a held instant
— so the weather in it is the weather at that instant, every time
(ADR-0033).

| Picture                 | Where                                                        | What it proves                                                                                        | Judged against                        |
| ----------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Cumulus from orbit**  | 400 km, nadir, early afternoon over a continent, a long lens | Cells a kilometer across, each beside its own shadow                                                  | ISS Earth-observation photographs     |
| **Anvils at sunset**    | 400 km, sun 5° up, a squall line under the eye               | Towers to the tropopause and shadows a hundred kilometers long; tops lit after the ground is dark     | ISS photographs at the terminator     |
| **The whole face**      | `blue-marble`                                                | The circulation: the ITCZ, the subtropical clear belts, comma clouds, a stratocumulus deck, a cyclone | DSCOVR EPIC frames                    |
| **The limb at dusk**    | 400 km, the sunset limb                                      | Cloud tops standing into the orange band, and the shadows they lay on the air                         | ISS limb photographs                  |
| **Fair weather**        | Standing at noon, on Earth and on a generated wet world      | Flat bases at one height, bright tops, shadows crossing the ground                                    | Ground photographs                    |
| **Overcast over water** | Standing on a shore under a deck                             | Gray light with no sun, and the deck in the sea instead of a blue sky                                 | Ground photographs                    |
| **Rain**                | Standing under a nimbostratus deck                           | Rain shafts on the horizon, streaks by the shutter, wet ground                                        | Ground photographs                    |
| **Underlit at dusk**    | Standing, sun 2° under the horizon                           | Altocumulus lit orange from below, crepuscular rays                                                   | Ground photographs                    |
| **Over the deck**       | 3 km over stratocumulus, sun behind the eye                  | The glory around the ship's shadow, the cloudbow, the deck's cells                                    | Aircraft photographs                  |
| **Inside**              | Flying through a cumulus                                     | Visibility falls to tens of meters and returns, with no frame that steps                              | Cockpit video                         |
| **A night from orbit**  | 400 km over the night side, a full moon                      | A moonlit deck, cities blurred under it, a storm lit from inside                                      | ISS night photographs                 |
| **Mars**                | Over Tharsis at aphelion, and inside a regional dust storm   | Water-ice clouds on the volcanoes' flanks; a dust front                                               | Mars Express, MRO MARCI, rover images |

## 3. Constraints that bind

- **The weather is a function of time, and the picture converges to it.**
  Every field — climate, cyclones, cells, wind, rain — is evaluated at
  `(body, place, renderTime)` directly. Nothing is stepped, nothing is saved
  (rule 15), and nothing depends on what was evaluated first (rule 4). That is
  what lets a preset hold its weather, a scrub land on the right sky and two
  clients see the same one, for nothing. The caches between the field and the
  frame — the maps, the volume, the shadow, the history, the wetness — may lag
  it: after a cut or a scrub they rebuild, and under warp they may run behind,
  because a picture at 100,000× is a time-lapse, not a measurement.
- **Nothing in the weather is canonical.** It enters no hash and spends no
  version; like a haze, it rides along (ADR-0027). If wind or lightning ever
  acts on a ship, the CPU form of that one quantity becomes canonical then,
  with the drawn and the canonical kept apart (rule 53), and not before.
- **Float64 decides, float32 draws.** The eye's height over each cloud shell
  is resolved on the CPU (`cloudShellAltitude` already does it), shell
  intersections are formed from heights and never from two radii (rule 52),
  noise lattices read a tile-local frame (rule 58), and every time offset is
  reduced by its period on the CPU before upload. Ten years past the epoch a
  float32 clock resolves 32 s, which the giants' 10⁻⁷ turns a second never
  show and a cloud drifting at 10 m/s turns into 320 m steps.
- **The clouds stand in the one air.** They are drawn through the air's own
  tables, they shadow both halves of the air's light, the ground, the sea and
  the sphere read one cloud shadow the same way (rule 59), and the sea
  reflects them. The same field lights the hull and occludes the flare.
- **One field at every distance.** Whatever changes with range — the octaves
  drawn, the step count, the texels the weather is read from, the level of a
  cache — is a change of resolution of one function, faded across a band with
  hysteresis, never a second model
  ([art](../../docs/design/art.md#continuity--the-no-pop-in-specification),
  items 1–3).
- **Physical light first.** Extinction comes from microphysics, first-order
  scattering from Mie theory, and the fast transport is checked against a
  reference wherever a reference is cheap. Where the fast transport misses
  something every photograph shows, a declared term may add it, judged
  against photographs; a fitted gain over the sum is the error ADR-0056
  removed.
- **Never average a density whose transmittance is wanted.** Half a column
  clear and half at optical depth 20 lets half the light through; the same
  water spread evenly, τ 10, lets through 0.0045% of it. Anything that stands
  for unresolved cloud — a coarse level, a far texel, a fine scale faded under
  warp — carries a cloud fraction and an in-cloud optical depth, and mixes
  once per represented segment: one layer's crossing of one column. Inside a
  segment a ray is in the cloudy fraction or out of it for the whole
  crossing, so the depth and the light it meets in cloud accumulate across
  steps, and both mix at the segment's exit by the largest fraction the
  crossing met: `T = (1 − c) + c·e^(−τ_in)`, and the cloud's light enters as
  `c·L_in`. Between segments the overlap is random and the transmittances
  multiply, so a grazing ray that crosses many columns of one layer mixes at
  each. Mixed at every step instead, a half-clear layer at τ 20 crossed in two
  steps lets through 0.25 rather than 0.5. This is the maximum-random overlap
  of climate models.
- **Fields are sums, never a nearest.** A cyclone, a cell or a front
  contributes through a kernel that reaches zero inside its margin, and a
  sample sums every contributor in reach (rule 11). A cellular noise's
  distance is continuous; a property read off its nearest cell is not.
- **One GPU job at a time on this machine,** and figures taken on a quiet one
  (perf's caveats). Compile-ahead goes through `render/warmup.ts` (rule 61),
  and every pass is drawn through `runQuadPasses` so the timeline can name it.

---

## 4. The weather is a function of time

Three layers, each a pure function of `(seed, place, t)`, summed into one
field.

| Layer       | Time scale                  | What it carries                                                 | Form                                                                                        |
| ----------- | --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Climate** | Season and local solar time | Coverage and genus by place, the diurnal cycle, deep convection | Earth: a measured monthly climatology. A generated world: zonal profiles from its record    |
| **Events**  | Days to weeks               | Tropical and extratropical cyclones                             | Sparse convolution in space-time: hashed cells, each a Poisson count of parametric cyclones |
| **Texture** | Minutes to hours            | Cells, convective systems, the edge of a cloud                  | Flow noise under bounded advection, re-seeded every period                                  |

### 4.1 The season is the sun's

The climate is indexed by the season the frame draws — the sub-solar latitude
and its trend, from the sun's direction in body-fixed axes — and the local
solar time by the sun's longitude there. Never by the calendar. A body carries
a tilt and no pole direction (`packages/universe/src/frames.ts` turns it about
+X), so a calendar month and the drawn season can disagree by months; read
from the sun, the ITCZ follows the sun the frame lights, and a winter storm
track arrives in the winter the ground is lit for.

### 4.2 Earth's climate is measured

Earth's coverage and genus come from ISCCP-H: monthly, 1°, 1983–2017, nine
cloud types crossing top pressure at 680 and 440 hPa with optical depth at
3.55 and 22.63, free to use and redistribute
([NCEI](https://www.ncei.noaa.gov/products/international-satellite-cloud-climatology),
[ATBD](https://www.ncei.noaa.gov/pub/data/sds/cdr/CDRs/Cloud_Properties-ISCCP/AlgorithmDescription_01B-29.pdf)).
That one dataset carries the ITCZ near 6°N
([Schneider 2014](https://www.whoi.edu/cms/files/schneider14nat_285505.pdf)),
the clear subtropical deserts, the stratocumulus decks at 40–60% cover five
to ten degrees west of the coasts
([Wood 2012](https://atmos.washington.edu/~robwood/papers/reviews/sc_review_revised.pdf))
and the Southern Ocean overcast. It enters through the ingest pipeline as the
maps do, its license in the manifest. NASA's NEO, the obvious mirror, was
decommissioned in September 2026
([NASA](https://science.nasa.gov/earth/nasa-earth-observations-neo/)); MODIS
Level 3 (CC0) is the alternate.

ISCCP sees each column from above, so a type under higher cover is
undercounted. Between the three levels the overlap is random (§3): a type
seen at `c_seen` under cover `c_above` stands at `c_seen / (1 − c_above)`.
Where `c_above` passes 0.9 — the Southern Ocean overcast — that ratio
diverges and the lower level takes its zonal mean for the month instead.

The diurnal phase is measured too. Rain over land peaks at 15–18 local solar
time and over open ocean at 06–09
([Kikuchi & Wang](https://journals.ametsoc.org/view/journals/clim/21/11/2007jcli2051.1.xml)),
and stratocumulus peaks before sunrise, by over 20%.

The field is held to the measured statistics by tests counted on the CPU over
the sphere and over simulated years, not by eye: global cover 0.67–0.68, 0.72
over the ocean and 0.55 over land
([MODIS](https://ntrs.nasa.gov/citations/20120010368)); the zonal profile,
0.10 under the mean at 20°N, 0.15 under at 20°S and 0.15–0.25 over at 60°S
([GEWEX](https://doi.org/10.1175/bams-d-12-00117.1)); and each ISCCP type's
optical-depth class.

### 4.3 A generated world's climate follows from its record

| Quantity          | Law                                                                                                                          | Source                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud species     | The condensation class by equilibrium temperature: NH₃ under ~150 K, H₂O near 250 K, clear past ~350 K, silicates from 900 K | [Sudarsky 2000](https://arxiv.org/pdf/astro-ph/9910504); the saturation fits of [Gao 2020](https://www.nature.com/articles/s41550-020-1114-3) |
| Zonal jets        | A count of about (2Ωa/U)^½: ~7 for Earth, ~20 for Jupiter and Saturn, 4 for the ice giants                                   | [Showman 2010](https://arxiv.org/pdf/0911.3170)                                                                                               |
| Eddies, cyclones  | The deformation radius L_D = NH/f; a tropical cyclone's size goes as its potential intensity over f                          | Showman 2010; [Chavas 2013](https://dspace.mit.edu/handle/1721.1/82308)                                                                       |
| Hadley extent     | Shrinks with rotation; a slow rotator's cell is near-global, and its air superrotates                                        | [Kaspi & Showman 2015](https://www.weizmann.ac.il/EPS/kaspi/sites/EPS.kaspi/files/publications/Kaspi-Showman-2015.pdf)                        |
| A locked world    | A convective deck under the substellar point                                                                                 | [Yang 2013](https://arxiv.org/pdf/1307.0515)                                                                                                  |
| Tropical cyclones | Only over water above 26 °C, beyond 5° of latitude                                                                           | [WMO](https://cyclone.wmo.int/pdf/Chapter-Four.pdf)                                                                                           |

The first generated world the volume draws needs only a wet surface, a
rotation and a temperature, which every record carries. The temperature
profile lands in phase 4 (§11), and a condensable species beside the haze
family waits for the worlds that need one (§14).

### 4.4 Cyclones are sparse convolution in space-time

Space-time is cut into cells, and each cell hashes to a Poisson count of
cyclones, each with a position, a start, a lifetime, a size and a track
([Lagae 2010](https://www-sop.inria.fr/reves/Basilic/2010/LLCDDELPZ10/LLCDDELPZ10STARPNF.pdf)).
A cyclone is a function of its cell's index, so nothing depends on order and
no property is read off a nearest one (rule 11). The CPU enumerates the
cyclones live at the frame's instant — a bounded list, sized for 64 a body —
and each is splatted into the maps over its own footprint rather than
gathered at every texel; the same list answers the harness and the guide.
Convective cells and systems are not listed: hundreds stand on Earth at any
instant, so they are the texture layer's, at the rate the climatology's deep
convection sets.

| Cyclone       | Size and life                                                                                                              | Placement and motion                                                                                         | Source                                                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tropical      | Eye 32–64 km; radius of maximum wind lognormal, geometric mean 39–47 km; r₁₂ median 303 km, outer radius 881 km; 5–10 days | 80–90 a year, 72% in the north; ~5 m/s westward, recurving at 25–30°N or 20°S; β-drift 1–3 m/s               | [WMO](https://cyclone.wmo.int/pdf/Chapter-Two.pdf), [Willoughby & Rahn](https://journals.ametsoc.org/view/journals/mwre/132/12/mwr2831.1.xml), [Chavas 2016](https://oar.princeton.edu/jspui/bitstream/88435/pr1s35v/1/Observed%20Tropical%20Cyclone%20Size%20Revisited.pdf) |
| Extratropical | Radius 300–400 km over land, over 600 km on the ocean tracks; 18 h to 7 days                                               | On the storm tracks; the comma's warm-conveyor band, cold-conveyor head and dry slot as phases of one kernel | [Rudeva & Gulev](https://journals.ametsoc.org/view/journals/mwre/135/7/mwr3420.1.xml), [Carlson](https://journals.ametsoc.org/view/journals/mwre/108/10/1520-0493_1980_108_1498_atmcat_2_0_co_2.xml)                                                                         |

The comma comes first: a tropical cyclone's spiral bands — log spirals
crossing circles at 25–30° young and 10–15° mature
([review](https://www.kerwa.ucr.ac.cr/server/api/core/bitstreams/9acf3ee8-1fa2-48ce-8d12-c75e21050b92/content))
— are detail the statistics pass long before the picture does.

### 4.5 Texture moves with the wind, and every period is new weather

The cells of a field and the edge of a cloud are flow noise advected with a
bounded displacement. Each of three phases samples at `x − v(x)·T·φₖ`, with
`φₖ = frac(t/T + k/3 + ψ(x))` weighted `½(1 − cos 2πφₖ)`, so the weights sum
to a constant at every point and no displacement exceeds `|v|·T`
([Neyret 2003](http://evasion.imag.fr/Publications/2003/Ney03/neyret161.pdf)).
`ψ` is a smooth field of low frequency, so neighboring regions stand at
different points of the cycle and the planet does not dissolve in lockstep.
Each phase draws a new seed every period, and a phase switches seed only
where its weight is zero, so the field it fades back in is not the one it
faded out: clouds form and dissolve at the period, with no state and no seam.
`T` stays under `L/Δu`, where the flow's shear would stretch the noise
visibly, and each octave's period follows the `L/T ≈ 10 m/s` that holds across
phenomena
([Markowski & Richardson](https://catalogimages.wiley.com/images/db/pdf/9780470742136.excerpt.pdf)).
Every phase and offset is formed on the CPU in float64, modulo the noise's
period, before upload.

The wind is the climatological zonal profile, plus the cyclones' own
circulations, plus a curl perturbation (`v = r̂ × ∇ψ` is divergence-free on
the sphere). A ship does not feel it.

### 4.6 Under warp a scale fades to its own mean

At 100,000× a frame spans 28 minutes and a cumulus lives 30 to 50
([NWS](https://training.weather.gov/wdtd/courses/rac/documentation/rac25-conv-storms-glossary.pdf)),
so the texture layer would strobe. Keyed on the warp factor — the same on every
client and every frame rate — with hysteresis, a layer whose period would span
fewer than four frames at 60 Hz fades to its temporal mean: a cloud fraction
and an in-cloud optical depth, never a mean density (§3). Cyclones still cross
an ocean in seconds, which is the right picture of a week. A held preset is at
1×, so this never touches a plate.

### 4.7 Mars

The aphelion belt, 10°S–30°N at 10–40 km over Ls 30–160: water ice at r_e
3–5 µm, τ 0.1–1, opaque over Tharsis by day; polar hoods at 45–90°, τ 0.5–4
([review](https://insu.hal.science/insu-01814976/file/acrefore-9780190647926-e-114.pdf)).
The Arsia Mons cloud forms before dawn on the volcano's flank and reaches
1,800 × 150 km in about 2.5 h
([ESA](https://www.esa.int/Science_Exploration/Space_Science/Mars_Express/Mars_Express_unlocks_the_secrets_of_curious_cloud)),
which is orography (§4.8). Local dust storms stay under 1.6×10⁶ km² and 3
sols, regional ones exceed both, and a global storm comes in about one year
in four with its onset in Ls 185–315
([Montabone & Forget](http://hdl.handle.net/2346/74226)); Opportunity
measured τ past 10.7 in 2018. The air's tables bake a haze's dust as a
constant, so a storm is extra dust in the volume — albedo 0.70–0.95, radii
1.4–1.8 µm ([Wolff](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2009JE003350))
— over the haze the tables carry, scattering through its own phase class
(§5.3).

### 4.8 The maps, and what feeds them

The field is evaluated into maps the GPU reads, never per sample. A
cube-sphere weather map over the whole body carries synoptic coverage, and a
clipmap of the same quantities is centered under the eye, finer by levels, so
the field a walker stands under and the one a pilot sees from orbit are one
function at two resolutions. A level fades across its boundary as a terrain
patch morphs into its parent. Cells a kilometer across are the noise's, not a
map's.

Each holds sixteen channels in four RGBA8 textures: the three levels' cloud
fraction, their in-cloud optical depth, log-encoded, and their convective
share, cumuliform against stratiform; the middle level's ice share; the rain
rate and the deep-convection rate; the wind's two components; and two spare,
which the clipmap spends on the ground's wetness and its puddles (§7.3). A
level's genus — and with it its height profile, its base and its top — is
read from its convective share, the deep-convection rate and the climate, and
is not stored. The far atlas holds each of three
layers' fraction, in-cloud depth, base and top in one RGBA8, its heights
quantized over that level's own range; the local volume holds in-cloud
density and cloud fraction (§3) in RG8.

The terrain feeds the maps: elevation and its slope against the wind give
cloud on the windward side, clearing in the lee and a lenticular over a peak,
and the drainage graph's valleys hold radiation fog at dawn. The Arsia Mons
cloud is that rule on Mars.

The sizes are the built ones, declared from each texture's dimensions, texel
size and single level and held to the GPU's own figures by a test
([ADR-0064](../../docs/adr/0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md)).
Two figures in a cell are 1920×1080 and 2880×1800.

| Resource                   | Size                                                        | A texel on Earth  | Memory                 | Refresh                                                             |
| -------------------------- | ----------------------------------------------------------- | ----------------- | ---------------------- | ------------------------------------------------------------------- |
| Weather cube               | 6 faces × 514² in one atlas, a one-texel gutter, four RGBA8 | 19.5 km           | 25.36 MB               | A face a frame; six over six frames after a jump                    |
| Clipmap                    | 6 levels × 256² in a 2D array, four RGBA8                   | 250 m to 8 km     | 6.29 MB                | Toroidally, in strips; an eighth of a level a frame for time        |
| Far atlas (§5.4)           | 6 faces × 3 layers × 258², RGBA8                            | 39 km             | 4.79 MB                | One block a frame                                                   |
| Local volume (§6.1)        | 3 levels × 256² × 34 slices, RG8                            | 50, 200 and 800 m | 13.37 MB               | Eight slices a frame; whole after a jump                            |
| Sun's optical depth (§6.1) | 128 × 128 × 32, R16F                                        | 400 m cells       | 1.05 MB                | Four slices a frame; whole when the sun turns 0.05° or after a jump |
| History, at ½              | 48 B a texel                                                | —                 | 24.88 MB, 15.55 MB     | Every frame                                                         |
| Trace and its knots, at ¼  | 72 B a texel                                                | —                 | 9.33 MB, 5.83 MB       | Every frame                                                         |
| Depth copy                 | The scene target's extent, R16F                             | —                 | 4.15 MB, 10.37 MB      | Every frame                                                         |
| Noise                      | 128³ and 32³, R8                                            | —                 | 2.13 MB                | Once, at boot                                                       |
| Droplets' phase (§5.3)     | 1,024 angles × 32 radii, RGBA16F                            | —                 | 0.26 MB                | Once, at boot                                                       |
| **All of the above**       |                                                             |                   | **91.62 MB, 85.01 MB** |                                                                     |
| Reflection probe (§6.5)    | 256² octahedral RGBA16F, a target                           | —                 | 0.5 MB, a target       | Progressively; phase 1 builds and measures it                       |

The trace and the history follow the CSS axes, so at Retina they hold fewer
texels than at 1080p and the depth copy more. What a later phase adds to the
history or the trace — a second beam's accumulators, a class of scatterer — is
measured by the phase that adds it. Under an eye moving 8 km/s in orbit, the
finest clipmap level, 64 km across in 250 m texels, rewrites about half a
column a frame.

---

## 5. The volume

### 5.1 Density is extinction

A cloud's density is its extinction coefficient in m⁻¹,
`σ = 3·LWC/(2ρ_w·r_e)` for droplets far larger than the wavelength
([Stephens 1978, restated](https://amt.copernicus.org/articles/18/6271/2025/)).
From OPAC's microphysics it gives 57 km⁻¹ for continental stratus and 35 for
stratocumulus, where MODTRAN tabulates 57 and 39
([OPAC](https://lweb.cfa.harvard.edu/hitran/HITRAN2012/Aerosols/papers/hess_opac_1998.pdf)):
the formula is the measurement, not a fit.

| Genus                           | In-cloud σ, km⁻¹ | Placement                                                               |
| ------------------------------- | ---------------- | ----------------------------------------------------------------------- |
| Stratus, continental and marine | 57 and 40        | Base 0.33 km, 0.67 km thick                                             |
| Stratocumulus                   | 35               | 200–500 m thick, liquid water path 40–150 g m⁻²                         |
| Cumulus, continental and marine | 68 and 52        | Trade cumulus tops near 1 km; sizes a power law of slope −2.19          |
| Cumulonimbus                    | about 93         | Anvil at the tropopause, 15–16 km in the tropics; overshoots up to 2 km |
| Nimbostratus                    | 92               | Spans all three levels                                                  |
| Cirrus                          | 0.05–0.5         | 5–13 km temperate, 6–18 tropical; ice r_e 34–92 µm                      |
| Fog                             | 8.1              | Visibility 0.48 km by `V = 3.912/σ`                                     |

ISCCP's classes test the column, not the genus. A column's optical depth falls
under 3.6, between 3.6 and 22.6, or over it, and ISCCP's "cumulus" is the low,
thin class rather than the genus: a growing cumulus passes through all three.
The remap from coverage, profile and eroded noise to density is calibrated so
each genus's histogram of column optical depth falls in the classes ISCCP
records for it.

Inside a cumuliform cloud the water rises with height above the base,
`LWC(z) = f_ad·Γ_ad·z`, with `Γ_ad ≈ 2 g m⁻³ km⁻¹` and `f_ad = z₀/(z₀ + z)`,
`z₀ = 500 m` ([Wood 2009](https://doi.org/10.1175/2009jas3072.1)): dense tops
and thin bases from one rule. Droplets number 74 cm⁻³ over the sea and 288
over land, and at fixed water σ goes as `N^⅓`, so a continental cloud is
brighter than a marine one holding the same water. Rain begins where `r_e`
passes 12–14 µm
([Freud & Rosenfeld](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2011JD016457)),
which a marine cloud reaches shallower.

A cloud's shape is the map's coverage and genus, times a genus height
profile, times eroding noise: a 128³ Perlin–Worley base and a 32³ Worley
detail, one channel of R8 each, and a 2D curl field that tears the edges.
They are baked on the GPU at boot into `Storage3DTexture`s with
`generateMipmaps` off — three allocates a 3D texture's mip chain and cannot
fill it — and nothing large ships.

### 5.2 The march

- **It reads the field.** Each step evaluates the maps, the profile and two
  noises: four reads and the arithmetic between them. A local volume baked
  from the same field and read once a step, behind max mips that skip empty
  space, is the cache Nubis³ and Enshrouded use
  ([Nubis³](<https://advances.realtimerendering.com/s2023/Nubis%20Cubed%20(Advances%202023).pdf>),
  [Enshrouded](https://static.graphicsprogrammingconference.com/public/2025/talks/the-fog-is-lifting-volumetric-rendering-enshrouded/Krause-the-fog-is-lifting-volumetric-rendering-enshrouded.pdf)).
  Here it draws a broken-cloud horizon 6.3–6.9% from the field's own picture
  against a gate of 3%, so the march does not read it
  ([ADR-0064](../../docs/adr/0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md)).
  The volume is still baked: the sun's optical depth is summed through it
  (§6.1).
- **The shell is entered from float64 heights.** Each layer has a base and a
  top shell; the eye's height over each comes from the CPU, and the entry and
  exit distances are formed from heights, not radii (rule 52).
- **Steps grow with distance and shrink inside cloud**: from 50 m, growing 1%
  a step to 1 km
  ([takram](https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds));
  inside a cloud near the eye, 3 m plus 60 m per 16 km of distance
  ([Nubis Evolved](https://advances.realtimerendering.com/s2022/SIGGRAPH2022-Advances-NubisEvolved-NoVideos.pdf));
  light taps only inside cloud; an exit once transmittance falls under 1%.
  Each ray's start is jittered by spatiotemporal blue noise, which converges
  faster under a temporal filter than a Bayer phase or a hash
  ([Wolfe 2022](https://research.nvidia.com/publication/2022-07_spatiotemporal-blue-noise-masks)).
- **A step's light is its integral** over constant density,
  `(1 − e^(−σΔ))/σ`, as the air's is (ADR-0056). A layer's partial cover
  mixes once at the layer's exit (§3), and a GPU test holds a layer's
  transmittance unchanged as its steps are split.
- **Detail fades by footprint**, to a cloud fraction and an in-cloud depth
  rather than to a mean density.
- **Every read inside the loop names its level.** three turns WGSL's
  derivative-uniformity check off outside Firefox, so a plain `sample()` in a
  loop compiles on Chrome with an undefined result. `.level(0)`, held by a GPU
  test that fails without it.

### 5.3 Light

- **The sun reaches a sample** through the air's transmittance table at the
  sample's altitude (`sunThrough`) and through the cloud: two to four light
  taps over the first kilometer, and the sun's optical depth (§6.1) past
  them.
- **First-order scattering reads Mie.** The reference evaluates the phase at
  every sample, at that sample's own radius. The shortcut uses the angle
  between the sun and the view, which is fixed along a ray: it accumulates
  first-order light without its phase, per class of scatterer — cloud
  droplets, ice, rain, and on Mars dust — beside that light's mean effective
  radius, each sample weighted by its whole contribution: its scattering, the
  light reaching it and its transmittance to the eye, which a front-to-back
  march carries for nothing. It fetches each class's phase once at the end of
  the ray. A mean radius draws a sharper glory than a mix of radii does, an
  error toward the crisp case photographs record; phase 1 accepts the
  shortcut against mixed-radius cases, and a few radius bins per class are its
  fallback.
- **The tables.** The droplets' is Lorenz–Mie over angle and effective
  radius at one narrow distribution width, generated offline and committed
  ([ADR-0066](../../docs/adr/0066-the-droplets-phase-is-lorenz-mie-at-one-narrow-width-generated-offline.md)),
  which has why a fitted phase function does not serve first order. Phase 1
  convolves it with the star's disk at its own angular diameter: 0.53° from
  Earth, 0.35° from Mars, whatever a generated world's sun subtends. Ice is a
  severely roughened aggregate's bulk phase by effective diameter
  ([Baum 2014](https://doi.org/10.1016/j.jqsrt.2014.02.029)), which carries
  no halos; rain's, at a size parameter near 6,000, is geometric optics with
  Airy's correction rather than a Mie series. Both are phase 1's, in the
  droplets' format. Together the three carry the forward peak and the silver
  lining, and the cloudbow, fogbow, glory and corona with them (§8.1).
- **Higher orders are a measured choice.** Wrenninge's octaves scale
  extinction, scattering and anisotropy by `aⁱ`, `bⁱ` and `cⁱ`
  ([2013](https://fpsunflower.github.io/ckulla/data/oz_volumes.pdf)), and
  their sum does not conserve energy: a thin wisp gains `Σbⁱ`, 1.5 times its
  light at two octaves. So they are fitted to the slab reference of phase 1,
  with no octave's contribution above its attenuation
  ([Frostbite](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016_pbs_frostbite_sky_clouds.pdf)).
  The alternative is that reference itself as the renderer's term: slab
  transport tabulated by optical depth and the sun's and the view's cosines
  ([Bouthors 2008](https://hal.archives-ouvertes.fr/inria-00333007)), which
  is more physical wherever a cloud is a slab. A deck may take one where a
  cumulus takes the other. The octaves carry the HG–Draine blend.
- **The dark edge is a photograph's, and may be declared.** Where a fitted
  transport leaves a cumulus's sunward edges as bright as its core, against
  every photograph of one, a declared term may darken them, judged against
  photographs.
- **The sky lights the cloud** through an irradiance table baked beside Ψ —
  sky irradiance by height and sun — occluded by the column over the sample:
  the clipmap's near the eye and the far atlas's beyond, per layer above the
  sample. The ground under it lights the base with its own albedo and
  irradiance, occluded by the column below. The same table is what the
  ground's skylight wants (§6.2).
- **The moon is a second beam**, with first-order accumulators of its own per
  class at its own phase angle — one more fetch per class a ray. Its
  irradiance by phase is about 0.25 lx at full, three orders over airglow,
  through the same transmittance table at the moon's direction, in the
  march's light and the ground's, the sea's and the sphere's alike
  (rule 59). Under it the clouds take two light taps and no second shadow,
  and the ground takes the cloud column's transmittance, from the clipmap
  near and the far atlas beyond. Beside it, a city lights a cloud's base from
  below (§6.6), and lightning lights a cloud from inside (§7.4).

### 5.4 The far field is a coarse march

From 400 km a pixel at the center of a 60° field at 1080p spans about 0.4 km,
the limb lies 2,290 km off, and a grazing ray crosses some 714 km of a 10 km
shell: no step budget at the fine march's resolution resolves it. The far
field is therefore a coarser march of the same field, not a lookup.

The far field is a three-layer atlas, a cube-sphere of texels baked
progressively from the field: for each of the low, middle and high levels, a
base and a top height, a cloud fraction and an in-cloud optical depth. A far
ray marches the atlas as slabs, mixing each layer's transmittance by its
fraction once per layer (§3), and accumulates along itself the mean and mean
square of its visible depth, so the composite occludes terrain by a
distribution of depths rather than one. Those are Ghost of Yōtei's depth
moments, and they are a camera ray's, not a column's
([2025](https://blog.playstation.com/2025/10/23/ghost-of-yotei-tech-deep-dive/)).
[ADR-0064](../../docs/adr/0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md)
records the choice against density and light cached on spheres at the layers'
heights
([Weinrauch 2023](https://diglib.eg.org/items/2668054e-618d-4fb8-bbf7-d079a3ed4e75))
and against the local volume's coarse levels carried out to the planet, on
four cases a slab test cannot see: cirrus over cumulus, broken cumulus, an
anvil, and a grazing ray at sunset. It also records what the atlas does not
yet do: it lets through more light than the fine march it stands in for.

The two cross-fade by pixel footprint, with hysteresis, and never by
altitude, so a zoom and a descent cross one band by one rule. Baking the far
representation from the field the march reads, rather than authoring it beside
the volume, is what lets the two agree — the art direction's third continuity
item. The deck mesh, its map and the 0.4% lift retire, and the sphere's cloud
material becomes the far march for a body the trace does not serve (§5.5).

### 5.5 Temporal reconstruction

The template is `GalaxyTemporalVolume`, plus what a cloud adds.

- **Trace a quarter, reconstruct a half.** Rays at a quarter of the scene
  target's axes — 480 × 270 at 1080p — every frame, into a history at half,
  so each half-resolution pixel takes a fresh sample every fourth frame. That
  is UE5's default
  ([`r.VolumetricRenderTarget.Mode`](https://indxzero.github.io/ue544cvarwiki/articles/r.volumetricrendertarget.mode));
  a sixteenth at full resolution, HZD's and takram's, refreshes a pixel every
  sixteenth frame, which a reentry outruns. At Retina the ray budget is held
  and the ratio is not: a quarter of the CSS pixels, as the galaxy's history
  holds 960 pixels at 2880 × 1800.
- **Reproject through the cloud's own distance and motion**: the
  transmittance-weighted depth (Frostbite's equation 21), or the depth where
  opacity crosses a half when the ray reaches it, moved by the body's turn
  and by the wind before the camera's reprojection.
- **Reject what the frame contradicts**: the galaxy's parallax and depth
  tests, the trace's end depth against the scene's (a ridge now in front), a
  variance clip of radiance and transmittance over the 3 × 3, and every
  non-finite value — a single NaN in a history blacks out the frame.
- **Two regimes.** Converging, and immediate: no history, and every
  half-resolution pixel traced at fewer steps for the same budget, after a
  cut, a scrub, a resize, a jump in presentation time, or once the camera or
  the wind moves a sample farther than the history can follow. A lightning
  flash is lit in the composite, outside the history, so a stroke does not
  land on a quarter of the pixels.
- **One body's volume a frame.** The trace serves the body the eye is in, or
  the largest by footprint; any other clouded body in the frame draws its far
  march in its sphere material.
- **Convergence is part of settling.** `pictureEpoch` resets the history,
  and `ir.settled()` waits out its phases, the shadow's slices and the cache
  levels in view before a plate is taken.

### 5.6 The composite

The scene already carries the air from the eye to each surface,
`T_a·S + L_a`. The march crosses a span `[t₀, t₁]` of the ray — from where it
enters cloud to where the scene's depth or the layer's top stops it — and
inside it integrates the air and the cloud together. With `T_c` the cloud's
transmittance over the span, `L_j` the light the air and the cloud scatter
together inside it, and `L_a(0, t)` the air's own light from the eye to `t`,
the result is

```
out = T_c · scene  +  L_a(0, t₀)  +  T_a(0, t₀) · L_j  −  T_c · L_a(0, t₁)
```

exact for any cloud inside the span, with no division, on two conditions. The
air in the formula is the air the scene already carries: the surfaces' own march
(`marchAir`) to `t₁`, split at `t₀`, through the same tables and the same cloud
taps (§6.3). And the scene's transmittance is the air's: under Enhanced from
orbit a surface takes `clearedFromOrbit`, which mixes its transmittance toward
one, so there the identity holds approximately.
[ADR-0063](../../docs/adr/0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md)
records the form the composite draws, which adds the cloud to the scene and
equals it bit for bit where there is no cloud, the rule by which it reproduces
each pixel's own air, and both residuals as measured on the scene as built,
Enhanced off and on. The identity's limit as the span shrinks to one depth is
the thin-layer form, `T_c·scene + T_a1·L_c + (1 − T_c)·L_a1`. The rule ADR-0063
records allows the thin form from orbit and nowhere else, where its error
against the identity is 0.1% at the 95th percentile. It draws a second clouded
body's far march; the identity is the default everywhere, orbit included, and
whether orbit takes the thin form is phase 1's. Near the eye the trace stops at
each low-resolution pixel's own scene depth and the upsample takes the
nearest-depth sample, so a hull ten meters off inside a cloud is veiled by ten
meters of it, not by the deck's average.

The composite comes after everything a cloud can stand in front of — the
ground, the sea, the sphere, the shell, the sun's disk — and before the
overlays. The sea is transparent and draws after every opaque, and it writes
the depth the trace stops at (`render/water.ts`). So the scene is drawn in two
passes: everything a cloud can stand in front of, then the cloud passes and
the composite, then everything drawn over the clouds, loaded onto the first
pass's target
([ADR-0063](../../docs/adr/0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md)).
The record has the alternative it beat, a hand-rolled sequence that ends the
scene pass after the sea and resumes it, and what the second pass costs: it
is the largest cloud cost in the frame.

What draws after the composite splits in two. Instruments, the flare and other
lens effects read nothing. World transparency — rings, plumes, entry traces,
near rain — needs the cloud's transmittance to its own depth, which the span's
total and its two ends cannot give through two clouds with clear air between
them. So the trace writes, at its own resolution, four knots of a curve by
depth, each holding the transmittance in front of it and the light the cloud
scatters in front of it. The transmittance alone cannot say where that light
came from: a lit cloud in front of a dark one and a dark one in front of a lit
one draw the same curve. An additive plume is dimmed by the transmittance in
front of it; an alpha-blended ring is blended under the light in front of it,
which its blend must not darken. A GPU test holds a transparent object between
two independently lit cloud layers, lit in front and dark behind, and the
reverse, to the analytic value within 2% (`cloudFront`,
[ADR-0063](../../docs/adr/0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md)).

Under temporal FSR the composite runs at render resolution before the
upscaler and writes the cloud's opacity into `reactive`, where ADR-0044 puts
the deck's alpha. It blends the cloud's own motion — the camera's with the
body's turn and the wind's — into `velocity` by the cloud's opacity, with no
threshold for an edge to flip across from frame to frame. Under Enhanced from
orbit, the air in front of a cloud takes `clearedFromOrbit` as a surface's
does.

---

## 6. What the clouds do to everything else

### 6.1 One shadow

The sun's optical depth is a grid around the eye, 128 × 128 × 32 cells, each
holding the optical depth toward the sun summed through the local volume, the
form Nubis³ reports at 0.1–0.2 ms every eight frames and 40% off its render
time.
[ADR-0064](../../docs/adr/0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md)
records it against sun-space cascades of front depth, mean extinction and
maximum optical depth, UE5's Beer shadow map
([Hillaire 2020](https://blog.selfshadow.com/publications/s2020-shading-course/hillaire/s2020_pbs_hillaire_slides.pdf)):
neither holds a cloud's transmittance to the sun within 3% everywhere, and
the grid is the more accurate, most of all under cirrus at a low sun. The
record also has what the grid costs on a frame that rebuilds it whole.
takram marches its cascades every frame, three of them, 512² at its defaults,
and that is the reason not to draw a shadow whole: an alpha WebGPU port's own
benchmarks put the WebGL original's shadow pass at 3.8–4.7 ms of 7.4–9.7 ms
frames at 1280×720 on an M4 Mac mini under Chrome 154, and the port's at
6.5–8.0 ms of 11.4–13.4, figures the file asks to be re-measured rather than
extrapolated
([three-clouds-webgpu, `docs/BENCHMARKS.md`](https://github.com/johnfewell/three-clouds-webgpu/blob/main/docs/BENCHMARKS.md)).
Past the grid, the far atlas carries the sun's transmittance. Under warp the
shadow may lag the clouds it falls from.

One function reads it, `cloudSunlight(point)`, and the ground, the sea and
the sphere call it alike (rule 59), as do the hull's key light, the march's
far light, the air's march (§6.3) and the flare (§6.4). A GPU test holds the
sphere's cloud shadow and the ground's to one value at the descent gate.

### 6.2 Under a deck

The ground's light under cloud is an energy balance, and the parts are named
so none is counted twice: the beam through the shadow; the clear sky's
diffuse light over the clear fraction, from the irradiance table §5.3 bakes;
the deck's diffuse transmission of everything incident on its top, by a
two-stream form that carries the sun's cosine (delta-Eddington,
[Joseph 1976](<https://doi.org/10.1175/1520-0469(1976)033%3C2452:TDEAFR%3E2.0.CO;2>)),
because a low sun reflects more off a deck than a high one; and the light the
ground returns to the base and the base sends back, `1/(1 − A·R_base)`, which
is what brightens an overcast over snow. The deck's optical depth over a
point is the column's — the clipmap's near the eye, the far atlas's beyond.

The oracle is a seeded Monte Carlo column in Node — the air's gas and aerosol,
a deck, a ground of chosen albedo — at three sun elevations and two albedos.
The renderer's own hemisphere integral is a consistency check beside it, not
the test.

The clear sky's share, read from the table, closes two of the air's defects on
the way: the linear ramp that puts a quarter of the noon sky on the ground
([the air](the-air.md#the-days-skylight-ramp-puts-too-much-sky-on-the-ground))
and the deep sky read from one zenith under the eye
([the air](the-air.md#the-deep-sky-is-one-zenith-under-the-eye)).

### 6.3 The air under the clouds

The air's light has two halves, and a cloud dims both. Each sample of
`marchAir` multiplies its single-scattered sun by `cloudSunlight` at the
sample, and its multiple-scattered light, Ψ — baked for a clear sky — by the
diffuse transmittance of the column above the sample, the clipmap's near the
eye and the atlas's beyond. Dimming only the first leaves the air under a
storm bright and washes the shafts out. That is the dark air under a storm,
crepuscular rays through gaps, and a towering cumulus's shadow laid across
the twilight sky. The composite's air takes the identical taps (§5.6), or its
subtraction leaves the shadowed air's residual as a band around every cloud;
a GPU test holds the two to one value.

The taps are cheap and not free: four per terrain fragment, on a Retina ground
that already misses vsync, and phase 2 measures them A/B. Jittered per pixel
the shafts are noisy, and the scene pass keeps no history under MSAA. If they
band, three candidates are measured against each other: the cloud pass
marching the shadowed air under its own history, epipolar sampling with depth
breaks and shadow cascades
([DiligentFX](https://github.com/DiligentGraphics/DiligentFX/blob/master/PostProcess/EpipolarLightScattering/README.md)),
and a froxel volume for the near field, which IO Interactive's Smolder
presents for its volumetric effects
([SIGGRAPH 2026 Advances](https://advances.realtimerendering.com/s2026/index.html)).
Hillaire's jittered, reprojected 32-sample march costs about 1.0 ms on a
GTX 1080 ([EGSR 2020](https://sebh.github.io/publications/egsr2020.pdf)), a
card with about twice this M5's bandwidth.

### 6.4 The sun, the hull and the flare

The flare's visibility and the hull's key light each take `cloudSunlight` at
their own point, on the GPU, so a sun behind a cloud dims both in the frame
it dims, with no readback. The disk itself is behind the clouds in the
composite.

### 6.5 What the sea reflects

The sea and a wet ground reflect a sky with weather in it, by two reads. Near
the eye a probe — an octahedral map of the clouds' radiance and
transmittance, marched from the eye through the clipmap and refreshed
progressively — stands in front of the air's sky in `render/water.ts`'s
reflected term. From orbit and far off, where one center is wrong — the reason
§13 declines a cached dome — the reflected ray reads the far atlas where it
crosses the cloud layer, which keeps the parallax a probe would lose. That
read is a lit evaluation of three slabs a sea fragment, from the atlas and the
sun's optical depth, not one fetch, and §9 carries it. A sea
under an overcast is the deck's gray, and a lake under broken cloud holds the
nearer clouds at the clipmap's resolution. A GPU test holds the reflected deck
and the deck the trace draws to one radiance, and the overcast-over-water
picture is its plate.

### 6.6 Night

A city under cloud lights the base from below — orange over a city seen from
the ground, a diffuse glow seen from orbit — which is the night map's
emission spread over the base by the cloud's own transport. The moon is the
night's light (§5.3). An overcast night is also the first thing to meet the
meter's dark clamp
([the air](the-air.md#at-night-enhanceds-meter-opens-to-its-dark-clamp)).

---

## 7. Storms, rain and the near field

### 7.1 Rain far off: shafts and virga

Under a raining cloud the field carries rain as an extinction
`σ = a·R^b` — 0.31·R^0.67 km⁻¹ by Atlas's theory, measured fits spanning
a = 0.12–0.33 and b = 0.55–0.82
([Atlas](https://journals.ametsoc.org/view/journals/atot/2/3/1520-0426_1985_002_0331_eovair_2_0_co_2.xml))
— which is 2–3.4 km of visibility at 10 mm/h and under a kilometer at 50. A
shaft is the march carried on under the base where the cloud's rain rate is
positive; virga ends where the rate reaches zero above the ground. RDR2 hangs
its rain fog under rain clouds from the cloud map's density the same way.

### 7.2 Rain near the eye is the shutter's

A drop crosses a pixel in under 1.2 ms and adds its light for that long, so
its contrast scales with the exposure: a millisecond freezes drops into
beads, 30 ms smears them into faint streaks
([Garg & Nayar](https://www.cs.columbia.edu/CAVE/publications/pdfs/Garg_IJCV07.pdf)).
The sensor already has the shutter (ADR-0017). A near streak is `|v|·T` long
with alpha `2a/(|v|·T)`, capped at one: 15 cm at 1/60 s and 9 mm at 1/1000 s
for a 9 m/s fall, 1.7 m at 100 m/s of airspeed. Drops fall at
`v = 9.65 − 10.3·e^(−0.6D)` m/s for D in millimeters
([fall speed](https://journals.ametsoc.org/view/journals/apme/49/4/2009jamc2208.1.xml))
and are Marshall–Palmer, `N(D) = 8000·e^(−ΛD)` with `Λ = 4.1·R^−0.21`
([1948](https://journals.ametsoc.org/view/journals/atsc/5/4/1520-0469_1948_005_0165_tdorws_2_0_co_2.xml)):
at 10 mm/h about 3,200 drops a cubic meter, some 260 of them over a
millimeter. Past about three times `z_m = 2fa` — some 10 m at 1080p through a
60° lens — rain only adds up like fog, which the extinction already carries.

The near drops live in a camera-relative wrapped volume at positions closed
in simulation time — Far Cry 6's cylinder
([GDC](https://gameindustrylibrary.com/documents/simulating-tropical-weather-in-far-cry-6)),
without the lag NVIDIA's particle volume showed behind a fast camera, and
exact under a scrub. A 60° frustum out to 10 m holds about 800 m³, so some
2×10⁵ drops over a millimeter at 10 mm/h; the volume's radius and count are
targets phase 4 measures. Near drops take their own circle of confusion, draw
after the composite reading the cloud's transmittance to their depth, and
splashes spawn from depth.

### 7.3 Wet ground

A wet surface darkens by its porosity and smooths toward water
([Lagarde](https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/)).
Penndorf measured luminous reflectance falling, wet, from 24–31% to 18% for
sand, from 15% to 7.5–9% for clay soil and from 35% to 15–25% for concrete
([1956](https://journals.ametsoc.org/downloadpdf/view/journals/bams/37/4/1520-0477-37_4_142.pdf)).
Puddles take F0 = 0.02 and a flat normal in the terrain's concavities below a
flood level, with ripples while it rains, and reflect the clouds through §6.5.
Wetness is the rain's own history, carried as a channel of the clipmap that
gains with the rain each refresh sees and dries over a time constant, longer
for puddles. After a jump it is rebuilt from the field at a few past instants,
so the ground is right a few frames after a scrub rather than at once. The sea
under rain loses the sharpness of its glint. The ground, the sea and the
sphere take wetness alike (rule 59).

### 7.4 Lightning

Flashes are events of a storm's cells: three intracloud for each to the
ground over the US
([Boccippio 2001](https://journals.ametsoc.org/view/journals/mwre/129/1/1520-0493_2001_129_0108_csasbe_2.0.co_2.xml)),
three to five strokes 40–50 ms apart
([Dwyer & Uman 2014](http://www.lightning.ece.ufl.edu/PDF/Published%20Journals/2014/Dwyer%20&%20Uman%20%282014%29a.pdf)),
and 44 ± 5 a second over the Earth, ten times more over land
([Christian 2003](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2002JD002347)).
Each is integrated over the shutter's interval, so a long exposure catches the
whole flash. From orbit a flash lights 60–70% of its cell's top, and that is
the picture to build first. Inside a cloud the flash's light is evaluated in
the composite, from the cloud's depth and transmittance at the pixel, outside
the history, as Guerrilla's and Far Cry 6's are. The channel comes after: a
walk turning 16° a segment on average from its seed, which matches digitized
strokes
([Glassner](https://www.glassner.com/wp-content/uploads/2014/04/CG-CGA-PDF-00-03-The-Digital-Ceraunoscope-1-Mar00.pdf)),
its width the sensor's point-spread function
([Kim & Lin](https://gamma.cs.unc.edu/LIGHTNING/lightning.pdf)). A first
stroke's measured power spans a hundredfold, 1.3×10⁸ to 1.8×10¹⁰ W, so its
brightness is a calibration with a range, recorded as one against the scene unit
([ADR-0065](../../docs/adr/0065-a-scene-unit-is-the-sun-above-the-air-and-the-sensors-white-is-half-a-stop-under-it.md)).
Thunder lags 3 s a kilometer.

### 7.5 Fog

Fog is the field's lowest genus, a layer whose base is the ground, at
`σ = 144.7·LWC^0.88` km⁻¹
([Kunkel](https://www.mdpi.com/2073-4433/12/12/1666)): radiation fog on clear
calm nights in the valleys the drainage graph holds (§4.8), advection fog
over colder water, each from the climate and the diurnal clock. The march's
3 m steps near the eye carry it, unless the near-field medium of §6.3 does.

---

## 8. What the droplets make

### 8.1 Bows, glories and coronae

A bow, a glory and a corona are features of the phase function, so drawing
first-order light through the tabulated phases draws each where it physically
occurs, from orbit to the ground, with no overlay. A fogbow from droplets
under 50 µm is a broad white bow at 30–45°; a glory's red rings stand at
24/r, 37/r, 56/r and 76/r degrees for r in µm
([Laven](https://philiplaven.com/p2c1.html)); a corona's at 16/r, 31/r and
47/r; mixed droplet sizes near the sun make iridescence. A rain shaft's drops,
near a millimeter, carry the primary bow at 40–42°, the secondary ten degrees
outside it at about 43% of its light, Alexander's band between, and
supernumeraries under a millimeter
([Practical Meteorology](https://www.eoas.ubc.ca/books/Practical_Meteorology/prmet/Ch22-Optics.pdf)).
Over a deck the ship's umbra ends about 107 hull lengths away, and past it the
glory alone marks its antisolar point. A GPU test puts the glory's first ring
and the primary bow at their measured angles for the tables' radii.

### 8.2 Airglow

ADR-0056 names the shortfall: past −15° the measured sky is mostly airglow and
starlight. Airglow is three thin shells — OI 557.7 nm at 96 km (250 R), Na
589 nm at 92 km (30–100 R), OI 630 nm at 250–300 km (60 R) — over a
pseudocontinuum near 900 R. Through V(λ) they sum to about
1.2×10⁻⁴ cd m⁻² at the zenith (computed), the two thirds of La Palma's
measured dark sky that Benn and Ellison assign to airglow
([ING](https://www.ing.iac.es/astronomy/observing/conditions/skybr/skybr.html)).
A ray tangent to the green layer holds about 53 times its vertical column
(computed for an 8 km layer at 96 km), so from orbit the green line is about
13 kR on the limb — the green band in every night photograph from the ISS.
Each layer is a 1D table of a shell's chord column, with no march samples.
Every emitter in §6.6, §7.4 and here converts physical radiance into scene
units by dividing by `SCENE_UNIT_LUMINANCE`, 42,590 cd/m²
([ADR-0065](../../docs/adr/0065-a-scene-unit-is-the-sun-above-the-air-and-the-sensors-white-is-half-a-stop-under-it.md)).

---

## 9. The budget

A row with a figure is measured on the Mac mini (Mac18,5, Apple M6), Chrome
157, production build, and its ADR has the conditions. The targets were set
against this plan's M5, on which no row was measured; an M6 figure over its
target says nothing of how far over the M5's would be. A row without one is a
target, and names the phase that measures it. The targets' basis is published
figures on other hardware — takram on an M3 Max, RDR2 on a PS4 — and none of
them transferred: a step is four reads and not one, and a cloud pass is
texture-bound where spike 2's march was arithmetic.

| Pass                           | Rate                    | 1080p target       | Measured, 1080p | Measured, Retina | Where                    |
| ------------------------------ | ----------------------- | ------------------ | --------------- | ---------------- | ------------------------ |
| Maps and clipmap               | As `t` and the eye move | ≤ 0.05 ms          | 0.06 ms         | 0.05 ms          | ADR-0064                 |
| Far atlas                      | Progressive             | ≤ 0.1 ms           | 0.90 ms         | 0.91 ms          | ADR-0064                 |
| Reflection probe               | Progressive             | within the atlas's | —               | —                | A target; phase 1        |
| Local volume                   | Progressive             | ≤ 0.2 ms           | 0.23 ms         | 0.25 ms          | ADR-0064                 |
| Sun's optical depth            | Four slices a frame     | ≤ 0.3 ms           | 0.43 ms         | 0.43 ms          | ADR-0064                 |
| Trace at ¼ × ¼                 | Every frame             | ≤ 1.2 ms           | 3.72 ms         | 3.09 ms          | ADR-0063                 |
| History at ½                   | Every frame             | ≤ 0.3 ms           | 0.27 ms         | 0.18 ms          | ADR-0063                 |
| Composite, and the second pass | Every frame             | ≤ 0.3 ms           | 1.81 ms         | 4.43 ms          | ADR-0063                 |
| Shadowed air                   | Every frame             | ≤ 0.3 ms           | —               | —                | A target; phase 2        |
| The sea's far reflection       | Every frame, on the sea | ≤ 0.1 ms           | —               | —                | A target; phases 1 and 2 |
| Near rain                      | While it rains          | ≤ 0.5 ms           | —               | —                | A target; phase 4        |
| **On the ground, dry**         |                         | **≤ 2.9 ms**       | **7.12 ms**     | **8.91 ms**      | ADR-0063                 |
| **On the ground, in rain**     |                         | **≤ 3.4 ms**       | —               | —                | A target; phase 4        |
| **From orbit**                 |                         | **≤ 1.6 ms**       | **3.03 ms**     | **5.54 ms**      | ADR-0063                 |
| **On a reset frame**           | After a cut or a scrub  | —                  | **20.30 ms**    | **22.14 ms**     | ADR-0064                 |

A cost is `ir.gpu()` taken A/B in one boot — Apple's timestamps are latency, not
share ([harness](../../docs/guides/harness.md#where-the-gpus-frame-goes)) — and
a pass's figure is its share from `ir.passes()` on the same frames. A pass's row
and the ground's total are `ground`, under cumulus; the reset frame is a cut of
`horizon`, from the retake at `f9746fd3` that ADR-0063 explains. The figures are a generated world's; Earth's are in ADR-0063 with its
deck priced beside them. Retina holds the 1080p ray budget and upsamples, and
its trace is no dearer than at 1080p; what grows with the buffer is the second
scene pass. The weather is not inside §9's totals at either size, and phase 1
carries the budget rows it misses.

---

## 10. Phases

Each phase lands green on its own, with its pictures and its numbers.

| Phase | Lands                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Done when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | **Feasibility.** Landed: [ADR-0063](../../docs/adr/0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md), [ADR-0064](../../docs/adr/0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md), [ADR-0065](../../docs/adr/0065-a-scene-unit-is-the-sun-above-the-air-and-the-sensors-white-is-half-a-stop-under-it.md), [ADR-0066](../../docs/adr/0066-the-droplets-phase-is-lorenz-mie-at-one-narrow-width-generated-offline.md)                                                                   | §9's targets carry figures at 1080p and Retina — steady, on a reset frame and in memory — across a broken-cloud horizon, inside a cloud, two decks, a rapid scrub and two clouded bodies in one frame: **met as figures, and every landed cost but the history pass, and the memory, is over its target**; the history pass is within it, 0.27 and 0.18 ms against 0.3; the figures are the M6 mini's, and the M5's are not measured. In cold compile: **not met** — the `warming the clouds` span is empty in all six boots, the warm-up's difference with the flag is inside the boots' own spread, and the first frames' hitch is not decomposed into compile and build. Each of the four choices made against its alternatives, with the reason: **met**, the placement as an exception to its CPU clause, provisional on that evidence, and the far field provisional at its 800 m default. The glory's first ring at its radius in the table: **met**, as the series' red-band maximum (ADR-0066) |
| 1     | **The volume on a generated wet world**, on analytic weather: the references — the slab against adding-doubling (Prahl's [`ad`](https://omlc.org/software/ad/)) and a seeded Monte Carlo slab, the furnace (a uniform sky, albedo one, no sun: the radiance is the sky's at any density), step convergence, a path-traced isolated cumulus — then the genus density, the march, the phase tables, the higher orders, the irradiance table, the history, the composite, the far field and the reflection probe, and WebGL's far march alone. Earth keeps its deck | The slab within 5% of adding-doubling for τ 5–50 at three sun elevations; the furnace within 2%; a layer's transmittance unchanged as its steps are split; the isolated cumulus beside its path-traced reference with neither silver lining nor edge missing, and the shortcut's glory beside the per-sample reference on mixed radii; each genus's column optical depth in its ISCCP classes; fair weather, inside, over the deck and cumulus from orbit taken; the art direction's descent recording through a deck with no frame that steps; casts at reentry speed; §9 met at both sizes                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2     | **The shadow and the light**: `cloudSunlight` in the ground, the sea, the sphere, the hull and the flare; the energy balance under a deck and its Monte Carlo column; both halves of the shadowed air                                                                                                                                                                                                                                                                                                                                                            | One cloud shadow at the descent gate, within 1%; the composite's air and the surfaces' at one value under a cloud's shadow; downward light under a deck within 10% of the Monte Carlo column at three sun elevations and two albedos; overcast over water and underlit at dusk taken; the air's two skylight defects closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 3     | **Earth**: ISCCP-H with the overlap rule, the diurnal clock and orography. The deck, its map and its lift retire                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Global cover 0.67 ± 0.03, every 10° zonal band within 0.05 of MODIS, each ISCCP type's optical-depth histogram; the whole face, the limb at dusk and the anvils judged against EPIC and the ISS by the look council                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 4     | **Storms**: the temperature profile (§11), cyclones (the comma first), rain shafts, near rain, wet ground, lightning (from orbit first), fog, the warp fade                                                                                                                                                                                                                                                                                                                                                                                                      | 80–90 tropical cyclones a year over ten simulated years, 72% northern, each turning by its hemisphere; visibility under rain and fog within the measured σ–R and Koschmieder relations; the rain picture judged against photographs; near rain at 50 mm/h within its target; casts through a storm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5     | **The night**: the moon, cities under cloud, airglow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The night from orbit taken; airglow's zenith within 30% of Benn and Ellison's measured share of La Palma's dark sky; the `night-side` preset re-scored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6     | **Mars**: the aphelion belt, the polar hoods, the Arsia Mons cloud, dust storms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Mars's picture judged against Mars Express and MARCI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

A generated world
takes the volume before Earth does because it has no clouds to lose; Earth
keeps its deck until the volume can draw it with its shadow and its light, so
no frame on `main` takes Earth's clouds away.

---

## 11. Decisions, and the questions still open

**Decided.** Nothing in the weather is canonical, and the field stays a pure
function of time because that is what makes presets, scrubs and two clients
agree for free (§3). The picture converges to the field and may lag it under
warp. The default native picture keeps its own cloud history, since it has no
reconstruction to borrow one from (§5.5). The far field is baked from the
field the march reads, never authored beside it (§5.4). And three more:

1. **Earth's weather is the climatology's, and it moves.** The Blue Marble
   deck retires in phase 3, once the volume draws Earth with its shadow and
   its light. The map is static and real only as three days stitched
   together, so no instant ever looked like it; the climatology is the
   measured part of the weather, its statistics.
2. **A temperature profile is derived from the record** — a surface
   temperature by latitude and season, a lapse rate and a tropopause — and
   lands in phase 4, where the anvil needs its tropopause and the rain its
   freezing level. It is presentational and derived, so it stores nothing
   (rule 17) and spends no version. Snow, ice over a freezing level and a
   generated world's condensate follow it (§14); the drag model's isothermal
   air stays.
3. **WebGL draws the far march alone**, from phase 1, declared as it declares
   Manual in place of Automatic.

**Open:** the record grows for later work — a pole direction for calendar
seasons and the polar phenomena, a magnetic dipole for aurora, condensables
for generated worlds. Each spends a system version when it lands, and none is
this plan's to spend.

---

## 12. Risks

- **The Retina ground is already late.** It misses vsync at 26.2 ms before
  any weather, and a volume sized by the drawing buffer would add two and a
  half times the 1080p cost. The ray budget is the guard: the trace and the
  history follow the CSS axes, and cost no more at Retina than at 1080p.
- **At Retina the second scene pass is the largest cloud cost in the
  frame.** Drawing the overlays in a pass of their own loads and stores every
  sample of every attachment once more: 3.88–5.32 ms of the clouds' steady
  cost at Retina, where the trace is 0.07–3.09 ms, and 1.52–2.19 ms at 1080p,
  where the trace is the larger on `ground`, `horizon`, `decks` and both
  pairs, up to 4.75 ms
  ([ADR-0063](../../docs/adr/0063-the-weather-draws-between-a-scene-pass-under-the-clouds-and-one-over-them.md)).
  Phase 1 measures leaner forms of it, and a frame with nothing drawn over
  the clouds does not need it at all.
- **The far field's handover.** Where the far march takes over, any
  disagreement with the fine one is a band, and the visible failures are
  blackrack's fade band and KSP2's surface vanishing from orbit. The handover
  cases of §5.4 are the guard.
- **Ghosting.** takram lists ghosting in sparse cloud, disocclusion errors and
  depth errors where distant layers overlap as its own known issues; the
  immediate regime and the trace's end depth are the answers, and casts at
  reentry speed are the check, not stills.
- **Caches lag under warp, by design.** At 100,000× sixteen frames span 7.4
  hours, so a sliced shadow or a progressive atlas can hold storms that have
  moved on. That is accepted for a time-lapse; a cut or a scrub rebuilds
  them.
- **three r185.** A plain read in a loop returns an undefined result; a
  `Storage3DTexture` allocates mips it cannot fill; `r8unorm` storage needs
  Chrome's tier-1 formats, shipped in 142 before the 152 the figures use; TSL
  emits no f16 by reading of its source, untested, so the M5's doubled f16
  rate may be out of reach without `wgslFn`; an MRT holds 32 bytes a sample
  unless `requiredLimits` asks for more; a post-process quad's camera nodes
  describe the quad's camera; and reversed depth reverses the draw list,
  which a composite drawn as a scene object must survive. Compile-ahead goes
  through `warmCompile`.
- **Taste.** Eroded noise reads as cauliflower before it reads as cloud, and
  no number catches that. The look council's blind protocol, against
  photographs, is the instrument ([look council](look-council.md)).
- **One GPU job at a time.** The phase 0 rig, the GPU suite and the plates
  never run together on this machine.

---

## 13. What the literature says

| Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Verdict                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The recipe — a weather map times a height profile times eroding noise ([HZD](https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf), [Nubis](https://advances.realtimerendering.com/s2017/Nubis%20-%20Authoring%20Realtime%20Volumetric%20Cloudscapes%20with%20the%20Decima%20Engine%20-%20Final%20.pdf), [Frostbite](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016_pbs_frostbite_sky_clouds.pdf)) | **Adopted.** Every production system since 2015 is a variant of it                                                                                                                                                                                              |
| A sixteenth of the pixels a frame at full resolution (HZD, takram)                                                                                                                                                                                                                                                                                                                                                                                                                                             | **Declined** for UE5's default, a quarter traced into a half: a reentry crosses a cloud in a few frames                                                                                                                                                         |
| Nubis³'s voxel clouds ([2023](<https://advances.realtimerendering.com/s2023/Nubis%20Cubed%20(Advances%202023).pdf>))                                                                                                                                                                                                                                                                                                                                                                                           | **Split.** Its authored voxels do not fit a procedural planet; its baked density, its occupancy bound and its summed optical-depth grid do, and phase 0 measures them                                                                                           |
| Beer–powder, a max of two lobes (Nubis 2017)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Declined.** A max of normalized lobes integrates above one; a declared dark-edge term, judged against photographs, replaces powder where the transport misses it                                                                                              |
| Octave multiple scattering ([Wrenninge](https://fpsunflower.github.io/ckulla/data/oz_volumes.pdf)) and slab transport ([Bouthors 2008](https://hal.archives-ouvertes.fr/inria-00333007))                                                                                                                                                                                                                                                                                                                       | **A measured choice.** Octaves fitted to the slab, or the slab's own table, per kind of cloud                                                                                                                                                                   |
| HG–Draine ([Jendersie & d'Eon](https://research.nvidia.com/labs/rtr/approximate-mie/))                                                                                                                                                                                                                                                                                                                                                                                                                         | **Adopted for the higher orders**; tabulated phases for the first, which carry the bows and the glory the blend omits                                                                                                                                           |
| Bulk ice phases ([Baum 2014](https://doi.org/10.1016/j.jqsrt.2014.02.029))                                                                                                                                                                                                                                                                                                                                                                                                                                     | **Adopted** for the ice class: a severely roughened aggregate, with no halos                                                                                                                                                                                    |
| Neural transport ([RPNN](https://jannovak.info/publications/DeepScattering/index.html), [MRPNN](https://sites.cs.ucsb.edu/~lingqi/publications/paper_mrpnn.pdf), [neural relighting at HPG 2026](https://www.highperformancegraphics.org/2026/_assets/slides/environmental_volumetric_neural_shading_of_clouds_for_real-time_rendering.pdf))                                                                                                                                                                   | **Declined.** RPNN generalizes from tens of training clouds but takes seconds to minutes an image; MRPNN takes 5 ms for one cloud with a uniform albedo on an RTX 2080; the HPG 2026 relighting works on meshes with triplane features, not a procedural planet |
| Beer shadow cascades (UE5, takram)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **A candidate, sliced**, against the summed grid                                                                                                                                                                                                                |
| Froxels ([Wronski](https://advances.realtimerendering.com/s2014/wronski/bwronski_volumetric_fog_siggraph2014.pdf), Frostbite 2015, UE5, IO Interactive's Smolder 2026)                                                                                                                                                                                                                                                                                                                                         | **A candidate for the near field**: fog, rain mist and shafts near the eye                                                                                                                                                                                      |
| Epipolar sampling ([DiligentFX](https://github.com/DiligentGraphics/DiligentFX/blob/master/PostProcess/EpipolarLightScattering/README.md))                                                                                                                                                                                                                                                                                                                                                                     | **A candidate for shafts** in the smooth air, not for the clouds themselves                                                                                                                                                                                     |
| Textured shells ([SpaceEngine](https://spaceengine.org/manual/making-addons/creating-a-planet/))                                                                                                                                                                                                                                                                                                                                                                                                               | **What retires**                                                                                                                                                                                                                                                |
| A volume near and a 2D layer far ([blackrack](https://www.patreon.com/blackrack/posts/true-volumetric-139879553), [KSP2](https://kerbalspaceprogram.com/news/developer-insights-22-skys-the-limit))                                                                                                                                                                                                                                                                                                            | **Adopted in kind**: a far march over a baked atlas, crossed by footprint rather than altitude, as blackrack's fifth release bakes its layer from its volume                                                                                                    |
| Depth moments ([Ghost of Yōtei](https://blog.playstation.com/2025/10/23/ghost-of-yotei-tech-deep-dive/)), layered spherical caches ([Weinrauch 2023](https://diglib.eg.org/items/2668054e-618d-4fb8-bbf7-d079a3ed4e75))                                                                                                                                                                                                                                                                                        | **Depth moments adopted** on the far march's rays; the spherical caches are the atlas's alternative                                                                                                                                                             |
| A cached sky dome ([GT7](https://s3.amazonaws.com/gran-turismo.com/pdi_publications/GDC2023_GT7_SKY_RENDERING.pdf))                                                                                                                                                                                                                                                                                                                                                                                            | **Declined.** One dome from one center does not survive a camera between orbit and the ground; the sea's probe serves only near the eye                                                                                                                         |
| Live weather data (Flight Simulator's Meteoblue, X-Plane's GRIB)                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Declined.** The simulation's instant is not today; the climatology is the measured part                                                                                                                                                                       |
| Sparse convolution ([Lagae 2010](https://www-sop.inria.fr/reves/Basilic/2010/LLCDDELPZ10/LLCDDELPZ10STARPNF.pdf)), bounded advection ([Neyret 2003](http://evasion.imag.fr/Publications/2003/Ney03/neyret161.pdf))                                                                                                                                                                                                                                                                                             | **Adopted.** Together they are weather as a function of time                                                                                                                                                                                                    |
| Spatiotemporal blue noise ([Wolfe 2022](https://research.nvidia.com/publication/2022-07_spatiotemporal-blue-noise-masks))                                                                                                                                                                                                                                                                                                                                                                                      | **Adopted** for the trace's jitter                                                                                                                                                                                                                              |
| Rain streaks by exposure ([Garg & Nayar](https://www.cs.columbia.edu/CAVE/publications/pdfs/Garg_IJCV07.pdf)), wet surfaces ([Lagarde](https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/))                                                                                                                                                                                                                                                                              | **Adopted**                                                                                                                                                                                                                                                     |
| [takram three-geospatial](https://github.com/takram-design-engineering/three-geospatial) (MIT)                                                                                                                                                                                                                                                                                                                                                                                                                 | **Read, not vendored.** GLSL with local weather and no view from space, which its README lists as planned; its constants are the starting points cited above                                                                                                    |
| [three-clouds-webgpu](https://github.com/johnfewell/three-clouds-webgpu) (MIT, alpha)                                                                                                                                                                                                                                                                                                                                                                                                                          | **Read.** A TSL port of takram's clouds, and its benchmarks are the only published Apple figures for this recipe; it asks for them to be re-measured, not extrapolated                                                                                          |

---

## 14. Not in this plan

Each is real, wanted and its own problem; the data the research found is kept
here so the next plan starts from it.

- **Snow and hail** follow the temperature profile phase 4 lands (§11). With
  it, cover is
  exposure times inclination from the shadow's top-down map, fresh snow's
  albedo is 0.8–0.9 and ages toward 0.5–0.6 when wet
  ([Pomeroy](https://www.inscc.utah.edu/~campbell/snowdynamics/reading/Pomeroy.pdf)),
  and aggregates fall at 0.5–1.4 m/s.
- **Ice halos** need angular patterns per crystal habit — scattering angle by
  azimuth by sun elevation, traced offline for random, plate and
  horizontal-column crystals ([HaloRay](https://github.com/naavis/haloray)) —
  and a bright 22° halo stands in about 6% of cirrus hours
  ([Sassen 2003](https://doi.org/10.1364/ao.42.000332)). They follow cirrus
  that already reads right; the ice class's roughened aggregates carry none.
- **The rest of the upper air is the air's.** Noctilucent clouds are a sheet
  at 82.7 km seen at solar depressions of 6–16° between 50° and 65° of
  latitude in summer
  ([WMO](https://cloudatlas.wmo.int/en/explanatory-remarks-noctilucent-clouds.html));
  nacreous clouds a sheet at 15–25 km in polar winter; refraction is
  Bennett's 34.5′ at the horizon ([astroalgos](https://astroalgos.com/refraction)),
  a bent-ray table per body for the sun, the moon and the stars.
- **Aurora** waits on a magnetic dipole on the record
  ([planetarium](../../docs/design/planetarium.md)). OI 557.7 nm peaks near
  100 km and lives 0.7 s, OI 630 nm stands above 200 km and lives 110 s;
  IBC I–IV are 1 to 1000 kR; the oval's midnight edge sits at 66° geomagnetic
  at Kp 0 and 2° lower per Kp
  ([SWPC](https://www.spaceweather.gov/content/tips-viewing-aurora)); Lawlor
  and Genetti's footprint-times-deposition volume draws it from inside or
  outside the air
  ([2010](https://lawlor.cs.uaf.edu/~olawlor/papers/2010/aurora/lawlor_aurora_2010.pdf)).
- **Dust devils** at Gusev are 2–276 m wide
  ([Greeley 2006](https://doi.org/10.1029/2006je002743)), each an analytic
  column; Mars's picture is its ice clouds and its dust front first.
- **Jackknife transmittance**
  ([Peters 2025](https://momentsingraphics.de/SiggraphAsia2025.html)) reduces
  the bias of the exponential of a jittered optical-depth estimate, but wants
  two independent estimates and handles signed ones; it is worth trying only
  if a bias survives the march's step convergence.
- **The wet window** is the sensor's, declared like its glare: drops pushed by
  gravity and the apparent wind, a drop `d` in front of a lens focused at `D`
  averaging a footprint `D/(D+d)·f/N`
  ([2015](https://doi.org/10.1109/tpami.2015.2491937)).
- **Venus, Titan and the giants** keep what they draw. Venus's decks and
  Titan's methane each need a decision about whether the air's tables or the
  volume owns them, because both drawing them counts the cloud twice; a
  giant's bands are its face.

---

## Related

- [ADR-0056](../../docs/adr/0056-the-air-is-measured-and-its-gain-is-pi.md) — the air the clouds stand in
- [The air: what is left](the-air.md) — the defects §6.2 closes, and the ones it meets
- [ADR-0044](../../docs/adr/0044-the-sensor-reconstructs-the-display.md) — the scene pass, `reactive` and FSR
- [ADR-0033](../../docs/adr/0033-presets-hold-a-photographic-instant.md) — why a plate holds its weather
- [Art direction](../../docs/design/art.md) — the license and the continuity specification
- [The look council](look-council.md) — the protocol the pictures are judged by
- [Perf](perf.md) — the frame this fits in
