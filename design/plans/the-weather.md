# The weather: clouds, storms and rain

What the air still lacks is everything that moves in it. This plan replaces
the cloud deck — a textured sphere — with a volumetric cloud field that is a
closed-form function of the body, the place and the simulation time, seen
through one representation from geostationary distance to the inside of a
cumulus, and it adds what rides on that field: the shadow it casts on the
ground, the sea, the sphere and the air; the overcast light under it; storms,
rain, lightning and fog; and the optics its droplets and crystals make.

It is a plan, so it promises. When a phase lands, its decision moves into an
ADR and the section here goes; cite the ADR, not this page.

| Reads with                                                                        | For                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [ADR-0056](../../docs/adr/0056-the-air-is-measured-and-its-gain-is-pi.md)         | The air the clouds stand in, its tables and its one march  |
| [The air: what is left](the-air.md)                                               | Its open defects, two of which this plan closes on the way |
| [ADR-0037](../../docs/adr/0037-the-enhanced-camera.md)                            | The camera that compresses what the clouds produce         |
| [ADR-0044](../../docs/adr/0044-the-sensor-reconstructs-the-display.md)            | The scene pass, the reactive attachment and reconstruction |
| [Art direction](../../docs/design/art.md#continuity--the-no-pop-in-specification) | The continuity specification every phase is held to        |
| [Perf](perf.md#the-camera)                                                        | The frame the clouds have to fit in                        |

**Where the numbers come from.** Frame figures are perf's: the production
build on an Apple M5, Chrome 152, WebGPU, at 1920×1080 and at 2880×1800. A
cost this plan cannot have measured yet is written as a budget, or as another
engine's published figure on its own hardware, and says which. Microphysical
and climatological figures carry their source in the row that uses them.

---

## 1. What the tree draws today

- **The deck is a textured sphere.** `createCloudMaterial`
  (`render/planet.ts`) is a second sphere drawn transparent over the body,
  Lambertian with a 4% floor, a terminator wider than the ground's, and a tint
  toward the body's authored sunset as the sun drops. Earth's map is NASA's
  `cloud_combined_2048`, 2048 × 1024 — 19.6 km a texel at the equator — with
  its luminance moved into alpha. It is two days of visible imagery and a
  third of thermal infrared over the poles, with the gaps between orbits near
  the equator filled by hand
  ([NASA](https://science.nasa.gov/earth/earth-observatory/the-blue-marble-true-color-global-imagery-at-1km-resolution/),
  [the map's author](https://science.nasa.gov/blogs/earth-matters/2011/10/06/crafting-the-blue-marble/)).
  It drifts at 25.5 hours against the 23.93-hour day (`solar/bodies.ts`) and
  never changes.
- **It stands twice as high as the weather.** The shell is lifted to at least
  0.4% of the radius (`render/bodyUniforms.ts`), 25.5 km over Earth, because a
  shell at the deck's own 12 km shows no parallax at the limb. Real cloud tops
  overhang the limb because they have height; a sphere has none to show.
- **Nothing is overhead on the ground.** Coverage clears over the last
  quarter of the shell's altitude as the eye descends (ADR-0037), so a walker
  on Earth stands under a clear sky at every hour, and `cloudEntry.gpu.test.ts`
  holds the coverage at zero once the eye is under the shell.
- **The shadow stops at the descent gate.** The sphere projects the deck's
  alpha along the sun at 0.55 (`cloudShadow`); `render/terrain.ts` and
  `render/water.ts` carry no cloud term at all. The step is rule 59 the other
  way round: a term on the sphere that the ground does not have.
- **No generated world has a cloud.** `system.ts` builds every generated body
  with `clouds: null`, so a wet world outside Sol stands under a clear sky
  at every hour, from every height.
- **Venus, Titan and the giants are each something else.** Venus's deck is a
  4.2-day map at 60 km and opacity 1, and the sulfuric family is eight optical
  depths in the air's tables (ADR-0056). Titan has no cloud sphere. A giant's
  bands are its map, sheared by a zonal-jet warp at the measured magnitudes.
- **The air has no temperature and no wind.** It is isothermal and exponential
  (`physics/rigidBody.ts`; the roadmap's "no layers, no weather, no wind"), so
  nothing knows a freezing level, a tropopause or which way a cloud should
  move.
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
  through TSL as through hand-written WGSL (`docs/spikes.md`). That is about
  12 ps a sample when the sample is arithmetic. A cloud sample is a 3D texture
  read, and the figure is a floor for it rather than an estimate.

## 2. The pictures this is for

Each is a plate the phases are judged on, against a photograph of the real
thing. A plate is a preset — an address, a framing, a lens and a held instant
— so the weather in it is the weather at that instant, every time
(ADR-0033).

| Picture                | Where                                                        | What it proves                                                                                        | Judged against                        |
| ---------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| **Cumulus from orbit** | 400 km, nadir, early afternoon over a continent, a long lens | Cells a kilometer across, each beside its own shadow                                                  | ISS Earth-observation photographs     |
| **Anvils at sunset**   | 400 km, sun 5° up, a squall line under the eye               | Towers to the tropopause and shadows a hundred kilometers long; tops lit after the ground is dark     | ISS photographs at the terminator     |
| **The whole face**     | `blue-marble`                                                | The circulation: the ITCZ, the subtropical clear belts, comma clouds, a stratocumulus deck, a cyclone | DSCOVR EPIC frames                    |
| **The limb at dusk**   | 400 km, the sunset limb                                      | Cloud tops standing into the orange band, and the shadows they lay on the air                         | ISS limb photographs                  |
| **Fair weather**       | Standing at noon, on Earth and on a generated wet world      | Flat bases at one height, bright tops, shadows crossing the ground                                    | Ground photographs                    |
| **Overcast and rain**  | Standing under a nimbostratus deck                           | Gray light with no sun, rain shafts on the horizon, wet ground                                        | Ground photographs                    |
| **Underlit at dusk**   | Standing, sun 2° under the horizon                           | Altocumulus lit orange from below, crepuscular rays                                                   | Ground photographs                    |
| **Over the deck**      | 3 km over stratocumulus, sun behind the eye                  | The glory around the ship's shadow, the cloudbow, the deck's cells                                    | Aircraft photographs                  |
| **Inside**             | Flying through a cumulus                                     | Visibility falls to tens of meters and returns, with no frame that steps                              | Cockpit video                         |
| **A storm at night**   | 400 km over the night side                                   | Lightning lighting a cloud from inside; cities blurred under cloud                                    | ISS night photographs                 |
| **Mars**               | Over Tharsis at aphelion, and inside a regional dust storm   | Water-ice clouds on the volcanoes' flanks; a dust front                                               | Mars Express, MRO MARCI, rover images |

## 3. Constraints that bind

- **The weather is a function of time, never a state.** Every field — climate,
  storms, cells, wind, rain — is evaluated at `(body, place, renderTime)`
  directly. Nothing is stepped, nothing is saved (rule 15), and nothing
  depends on what was evaluated first (rule 4). A warp is a faster `t`, a
  planetarium scrub is a new `t`, a preset is a held `t`, and two clients
  agree because they evaluate the same function.
- **The weather is presentation until physics reads it.** It enters no hash
  and spends no version; like a haze, it rides along (ADR-0027). The day wind
  or lightning acts on a ship, the CPU form becomes canonical and the GPU's a
  port held to a bound, as the terrain kernel is (ADR-0023), with the drawn
  and the canonical kept apart (rule 53).
- **Float64 decides, float32 draws.** The eye's height over each cloud shell
  is resolved on the CPU (`cloudShellAltitude` already does it), shell
  intersections are formed from heights and never from two radii (rule 52),
  noise lattices read a tile-local frame (rule 58), and every time offset is
  reduced by its period on the CPU before upload. Ten years past the epoch a
  float32 clock resolves 32 s, which the giants' 10⁻⁷ turns a second never
  show and a cloud drifting at 10 m/s turns into 320 m steps.
- **The clouds stand in the one air.** They are drawn through the air's own
  tables, they shadow the air's own march, and the ground, the sea and the
  sphere read one cloud shadow the same way (rule 59). The same field lights
  the hull and occludes the flare.
- **One field at every distance.** Whatever changes with range — the noise
  octaves drawn, the step count, the texels the weather is read from — is a
  change of resolution of one function, faded across a band with hysteresis,
  never a second model ([art](../../docs/design/art.md#continuity--the-no-pop-in-specification),
  items 1–3).
- **Measured light.** Extinction comes from liquid water content and droplet
  size, the phase function from Mie theory for the droplet population, and the
  fast march is held by a test to a reference that resolves the multiple
  scattering it approximates. A fitted gain is the error ADR-0056 removed.
- **Fields are sums, never a nearest.** A storm, a cell or a front contributes
  through a kernel that reaches zero inside its margin, and a sample sums
  every contributor in reach (rule 11). A cellular noise's distance is
  continuous; a property read off its nearest cell is not.
- **One GPU job at a time on this machine,** and figures taken on a quiet one
  (perf's caveats). Compile-ahead goes through `render/warmup.ts` (rule 61),
  and every pass is drawn through `runQuadPasses` so the timeline can name it.

---

## 4. The weather is a function of time

Three layers, each a pure function of `(seed, place, t)`, summed into one
field. None is stepped; each is evaluated at the frame's presentation instant.

| Layer       | Time scale                  | What it carries                                    | Form                                                                                      |
| ----------- | --------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Climate** | Season and local solar time | Coverage and genus by place, and the diurnal cycle | Earth: a measured monthly climatology. A generated world: zonal profiles from its record  |
| **Events**  | Hours to weeks              | Cyclones, fronts, convective systems               | Sparse convolution in space-time: hashed cells, each a Poisson count of parametric events |
| **Texture** | Minutes                     | The cells of a field, the edge of a cloud          | Flow noise under bounded advection, re-seeded every period                                |

### 4.1 The season is the sun's

The climate is indexed by the season the frame draws — the sub-solar latitude
and its trend, from the sun's direction in body-fixed axes — and the local
solar time by the sun's longitude there. Never by the calendar. A body carries
a tilt and no pole direction (`frames.ts` turns it about +X), so a calendar
month and the drawn season can disagree by months; read from the sun, the
ITCZ follows the sun the frame lights, and a winter storm track arrives in the
winter the ground is lit for.

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
maps do, its license in the manifest. NASA's NEO service, the obvious mirror,
closed in September 2026; MODIS Level 3 (CC0) is the alternate.

The diurnal phase is measured too. Rain over land peaks at 15–18 local solar
time and over open ocean at 06–09
([Kikuchi & Wang](https://journals.ametsoc.org/view/journals/clim/21/11/2007jcli2051.1.xml)),
and stratocumulus peaks before sunrise, by over 20%.

The tests hold the field to the measured statistics, counted by the CPU over
the sphere and over simulated years rather than judged by eye: global cover
0.67–0.68, 0.72 over the ocean and 0.55 over land
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

What the record lacks for these is a surface temperature and a lapse rate —
which give a freezing level, a tropopause and the phase of a condensate — a
condensable species beside the haze family, and a marine or continental
droplet regime. Each derives from what a body already carries — temperature,
density, sea level, composition family — and none is a dial.

### 4.4 Events are sparse convolution in space-time

Space-time is cut into cells, and each cell hashes to a Poisson count of
events, each with a position, a start, a lifetime, a size and a track
([Lagae 2010](https://www-sop.inria.fr/reves/Basilic/2010/LLCDDELPZ10/LLCDDELPZ10STARPNF.pdf)).
A point sums the kernels of every event in reach — the window spans the
longest lifetime and the radius the largest displacement plus a size — so an
event is a function of its cell's index, nothing depends on order, and no
property is read off a nearest event (rule 11). The CPU enumerates the events
live at the frame's instant, a few dozen on a planet, and uploads the list;
the GPU sums kernels from it when it builds the maps (§4.8). The same list
answers the harness and the guide.

| Event                 | Size and life                                                                                                              | Placement and motion                                                                                         | Source                                                                                                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tropical cyclone      | Eye 32–64 km; radius of maximum wind lognormal, geometric mean 39–47 km; r₁₂ median 303 km, outer radius 881 km; 5–10 days | 80–90 a year, 72% in the north; ~5 m/s westward, recurving at 25–30°N or 20°S; β-drift 1–3 m/s               | [WMO](https://cyclone.wmo.int/pdf/Chapter-Two.pdf), [Willoughby & Rahn](https://journals.ametsoc.org/view/journals/mwre/132/12/mwr2831.1.xml), [Chavas 2016](https://oar.princeton.edu/jspui/bitstream/88435/pr1s35v/1/Observed%20Tropical%20Cyclone%20Size%20Revisited.pdf) |
| Its bands             | Log spirals crossing circles at 25–30° young and 10–15° mature; inner bands 5–13 km wide, living 1–2 h                     | `s = θ − cot α · ln r` in the storm's frame, turning by hemisphere                                           | [Rainband review](https://www.kerwa.ucr.ac.cr/server/api/core/bitstreams/9acf3ee8-1fa2-48ce-8d12-c75e21050b92/content)                                                                                                                                                       |
| Extratropical cyclone | Radius 300–400 km over land, over 600 km on the ocean tracks; 18 h to 7 days                                               | On the storm tracks; the comma's warm-conveyor band, cold-conveyor head and dry slot as phases of one kernel | [Rudeva & Gulev](https://journals.ametsoc.org/view/journals/mwre/135/7/mwr3420.1.xml), [Carlson](https://journals.ametsoc.org/view/journals/mwre/108/10/1520-0493_1980_108_1498_atmcat_2_0_co_2.xml)                                                                         |
| Convective system     | Over 100 km, over 6 h; supercell mesocyclones 2–10 km                                                                      | On the diurnal clock, at a rate from the deep-cloud climatology                                              | [Houze](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029%2F2004RG000150)                                                                                                                                                                                             |

### 4.5 Texture moves with the wind, and every period is new weather

The cells of a field and the edge of a cloud are flow noise advected with a
bounded displacement. Each of three phases samples at `x − v(x)·T·φₖ`, with
`φₖ = frac(t/T + k/3)` weighted `½(1 − cos 2πφₖ)`, so the weights sum to a
constant and no displacement exceeds `|v|·T`
([Neyret 2003](http://evasion.imag.fr/Publications/2003/Ney03/neyret161.pdf)).
Each phase draws a new seed every period, so the field it fades back in is
not the one it faded out: clouds form and dissolve at the period, with no
state. `T` stays under `L/Δu`, where the flow's shear would stretch the noise
visibly, and each octave's period follows the `L/T ≈ 10 m/s` that holds across
phenomena
([Markowski & Richardson](https://catalogimages.wiley.com/images/db/pdf/9780470742136.excerpt.pdf)).
Every phase and offset is formed on the CPU in float64, modulo the noise's
period, before upload.

The wind is the climatological zonal profile, plus the events' own
circulations, plus a curl perturbation (`v = r̂ × ∇ψ` is divergence-free on
the sphere). It is presentation; a ship does not feel it.

### 4.6 A scale is drawn only where the frame resolves its time

At 100,000× warp a frame spans 28 minutes and a cumulus lives 30 to 50
([NWS](https://training.weather.gov/wdtd/courses/rac/documentation/rac25-conv-storms-glossary.pdf)),
so the texture layer would strobe. A layer whose period is shorter than four
frames of simulated time fades to its own temporal mean — a cell field to its
climatological cover — as an octave finer than the pixel fades to its mean in
space. Cyclones still cross an ocean in seconds, which is the right picture of
a week. The cloud history weighs its samples by the same rule (§5.5).

### 4.7 Other worlds

| Body   | What its weather is                                                                                                                                                                                                                                                                                                                                                                                                                              | Source                                                                                                                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mars   | The aphelion belt, 10°S–30°N at 10–40 km over Ls 30–160: water ice at r_e 3–5 µm, τ 0.1–1, opaque over Tharsis by day. Polar hoods at 45–90°, τ 0.5–4. The Arsia Mons cloud, forming before dawn and reaching 1,800 × 150 km in about 2.5 h. Local dust storms under 1.6×10⁶ km² and 3 sols; regional ones beyond both; global ones in about one year in four, onsets in Ls 185–315. Dust devils 2–276 m wide, about 50 a km² a sol, 09:30–16:30 | [Review](https://insu.hal.science/insu-01814976/file/acrefore-9780190647926-e-114.pdf), [ESA](https://www.esa.int/Science_Exploration/Space_Science/Mars_Express/Mars_Express_unlocks_the_secrets_of_curious_cloud), [Montabone & Forget](http://hdl.handle.net/2346/74226), [Greeley 2006](https://doi.org/10.1029/2006je002743) |
| Venus  | Three decks: 56.5–70 km at τ 6–8, 50.5–56.5 at 8–10, 47.5–50.5 at 6–12, under hazes. Features lap in about 4.7 days; the Y is a Kelvin and a Rossby wave                                                                                                                                                                                                                                                                                         | [Knollenberg & Hunten](https://www.astrobio.k.u-tokyo.ac.jp/imamura/wp/wp-content/uploads/2020/08/Knollenberg_Hunten_1980.pdf), [Del Genio](https://www.giss.nasa.gov/pubs/abs/de00200p.html)                                                                                                                                     |
| Titan  | Convective tops rising from 20 to 42 km in about 35 min, then raining out; south-polar fields 100–400 km across with 16 km tops; a polar ethane cloud at 30–60 km                                                                                                                                                                                                                                                                                | [Barth](https://www.sciencedirect.com/science/article/abs/pii/S0019103509000591), [Turtle](https://doi.org/10.1029/2010gl046266)                                                                                                                                                                                                  |
| Giants | Bands from the measured jets in closed form, `Δλ = u(φ)·t/(a cos φ)`; the Great Red Spot at 22.5°S, 14,750 × 10,500 km in 2023, drifting west 0.36° a day; Saturn's hexagon at 78°N, wavenumber 6; outbursts at their measured recurrence                                                                                                                                                                                                        | [Kaspi 2020](https://doi.org/10.1007/s11214-020-00705-7), [Simon 2018](https://iopscience.iop.org/article/10.3847/1538-3881/aaae01/pdf), [Sayanagi](http://arxiv.org/pdf/1609.09626)                                                                                                                                              |

A giant keeps its map, and the volume does not descend into one: its clouds
are its face, and its air has no floor for this plan to stand on.

### 4.8 The maps

The field is evaluated into maps the GPU reads, never per sample. A
cube-sphere weather map over the whole body carries coverage, genus weights,
base and top heights, rain rate and wind, refreshed as `t` moves a texel's
worth of weather. A clipmap of the same quantities is centered under the eye,
finer by levels, so the cumulus field a walker stands under and the one a
pilot sees from orbit are one function at two resolutions; a level fades
across its boundary as a terrain patch morphs into its parent. The sizes are
phase 0's.

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

| Genus                           | σ, km⁻¹   | Optical depth                       | Placement                                                               |
| ------------------------------- | --------- | ----------------------------------- | ----------------------------------------------------------------------- |
| Stratus, continental and marine | 57 and 40 | Over 22.6                           | Base 0.33 km, 0.67 km thick                                             |
| Stratocumulus                   | 35        | 3.6–22.6                            | 200–500 m thick, liquid water path 40–150 g m⁻²                         |
| Cumulus, continental and marine | 68 and 52 | Under 3.6, to over 22.6 as it grows | Trade cumulus tops near 1 km; sizes a power law of slope −2.19          |
| Cumulonimbus                    | about 93  | Over 22.6                           | Anvil at the tropopause, 15–16 km in the tropics; overshoots up to 2 km |
| Nimbostratus                    | 92        | Over 22.6                           | Spans all three levels                                                  |
| Altostratus                     | 128       | 3.6–22.6                            | 2–7 km, temperate                                                       |
| Cirrus                          | 0.05–0.5  | Subvisual under 0.03, thin to 0.3   | 5–13 km temperate, 6–18 tropical; ice r_e 34–92 µm                      |
| Fog                             | 8.1       | —                                   | Visibility 0.48 km by `V = 3.912/σ`                                     |

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
One channel, because a four-channel fetch costs about four times a
one-channel one here whatever the texture's size (`render/noiseTexture.ts`);
the two are 2 MiB and 32 KiB. Both are baked on the GPU at boot into
`Storage3DTexture`s with `generateMipmaps` off — three allocates a 3D
texture's mip chain and cannot fill it — and nothing large ships.

### 5.2 The march

- **The shell is entered from float64 heights.** Each layer has a base and a
  top shell; the eye's height over each comes from the CPU, and the entry and
  exit distances are formed from heights, not radii (rule 52).
- **Steps grow with distance and shrink inside cloud**: from 50 m, growing 1%
  a step to 1 km
  ([takram](https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds));
  inside a cloud near the eye, 3 m plus 60 m per 16 km of distance
  ([Nubis Evolved](https://advances.realtimerendering.com/s2022/SIGGRAPH2022-Advances-NubisEvolved-NoVideos.pdf));
  cheap steps until a hit and one step back
  ([HZD](https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf));
  light taps only inside cloud; an exit once transmittance falls under 1%.
- **Empty columns are skipped** by the atlas's column optical depth (§5.4) and
  a max-mip of the coverage.
- **A step's light is its integral** over constant density,
  `(1 − e^(−σΔ))/σ`, as the air's is (ADR-0056). The exponential of a
  jittered optical-depth estimate overestimates transmittance, and Peters'
  jackknife estimator removes most of that bias for the price of a second sum
  ([2025](https://momentsingraphics.de/SiggraphAsia2025.html)) — which the
  air's own four- and twelve-sample marches want as well.
- **Detail fades by footprint.** An octave finer than the pixel's footprint
  at the sample fades to its mean, the rule the ground's grain already keeps.
- **Every read inside the loop names its level.** three turns WGSL's
  derivative-uniformity check off outside Firefox, so a plain `sample()` in a
  loop compiles on Chrome and returns zeros under Dawn: an unofficial TSL port
  of takram's clouds saw its cloud shadow fall from 21% of the frame to 2%.
  `.level(0)`, held by a GPU test that fails without it.

### 5.3 Light

- **The sun reaches a sample** through the air's transmittance table at the
  sample's altitude (`sunThrough`) and through the cloud: two to four light
  taps over the first kilometer, and the shadow (§6.1) past them.
- **First-order scattering reads Mie.** The droplet population's Lorenz–Mie
  phase function, integrated over a gamma size distribution, over the sun's
  0.53° disk and over each channel's CIE 1931 lobe as the ozone
  cross-sections are, is a table of 1024 warped angles by 16 effective radii,
  131 KB in RGBA16F. The sun's direction and the view's are fixed along a
  ray, so the lobe costs one fetch per pixel, not per sample. It carries the
  forward peak and the silver lining, and the cloudbow, fogbow, glory and
  corona (§8.1) with them. Jendersie and d'Eon's HG–Draine blend matches 95%
  of the Mie phase function and, by its authors' account, none of the
  back-scattered features
  ([2023](https://research.nvidia.com/labs/rtr/approximate-mie/)). The table
  is computed offline and committed as generated data, as the sky's
  calibration is.
- **Higher orders are octaves, fitted to the slab.** Wrenninge's octaves
  scale extinction, scattering and anisotropy by `aⁱ`, `bⁱ` and `cⁱ`
  ([2013](https://fpsunflower.github.io/ckulla/data/oz_volumes.pdf)), and the
  sum does not conserve energy: a thin wisp gains `Σbⁱ`, 1.5 times its light
  at two octaves. So the coefficients are fitted to the slab reference of
  phase 0, with no octave's contribution above its attenuation
  ([Frostbite](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016_pbs_frostbite_sky_clouds.pdf)),
  and never by eye. The octaves carry the HG–Draine blend.
- **The sky lights the cloud** through an irradiance table baked beside Ψ —
  sky irradiance by height and sun — occluded by the column over the sample,
  which the atlas carries. The ground under it lights the base with its own
  albedo and irradiance, occluded by the column below. The same table is what
  the ground's skylight wants (§6.2).
- **At night** the base takes the night map's cities from below, and
  lightning lights a cloud from inside (§7.5). Nothing else lights a night
  side today.

### 5.4 One field, the march and the atlas

From 400 km through a 60° lens at 1080p a pixel at nadir spans about 0.43 km,
the limb lies 2,290 km off, and a grazing ray crosses some 714 km of a 10 km
shell: no step budget resolves it. So the field has two consumers, both
reading the one function.

- **The march**, with footprint detail, wherever the body is large in the
  frame.
- **The atlas**: a cube-sphere of texels baked progressively from the same
  function — column optical depth, base and top height, transmittance-weighted
  depth, sun transmittance. It draws the limb's grazing rays, the far disk and
  the planet-scale shadow, and it tells the march which columns are empty.

The two cross-fade by pixel footprint, with hysteresis, and never by
altitude, so a zoom and a descent cross one band by one rule. Baking the far
representation from the volume rather than authoring it beside the volume is
what lets the two agree, which is the art direction's third continuity item;
a GPU test holds the atlas's slab to the march's at the handover footprint.
The sphere's cloud material, the deck mesh and the 0.4% lift retire with the
map.

### 5.5 Temporal reconstruction

The template is `GalaxyTemporalVolume`, plus what a cloud adds.

- **Trace a quarter, reconstruct a half.** Rays at a quarter of the scene
  target's axes — 480 × 270 at 1080p — every frame, jittered, into a history
  at half, so each half-resolution pixel takes a fresh sample every fourth
  frame. That is UE5's default and the mode it recommends from the ground into
  space and through cloud
  ([UE5](https://dev.epicgames.com/documentation/en-us/unreal-engine/volumetric-cloud-component-properties-in-unreal-engine));
  a sixteenth at full resolution, HZD's and takram's, lags a reentry. At
  Retina the ray budget is held and the ratio is not: a quarter of the CSS
  pixels, as the galaxy's history holds 960 pixels at 2880 × 1800.
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
  the wind moves a sample farther than the history can follow (§4.6).
  `pictureEpoch` resets it, and `ir.settled()` waits out the converging
  regime's phases.

### 5.6 The composite

The scene already carries the air from the eye to each surface,
`T_a·S + L_a`. Splitting that path at the cloud — `T_a1` and `L_a1` the air
between the eye and the cloud, `T_c` the cloud's gray transmittance and
`L_c` its light — the exact result is

```
out = T_c · scene  +  T_a1 · L_c  +  (1 − T_c) · L_a1
```

the scene dimmed by the cloud, the cloud's light seen through the air in
front of it, and the air in front put back where the cloud dimmed it. It is
exact for one split, which the march places at the transmittance-weighted
depth, and `T_a1` and `L_a1` are one `airToward` per reconstructed pixel,
through the tables every surface reads. Upsampling to the scene target takes
the nearest depth.

The composite comes after everything a cloud can stand in front of — the
ground, the sea, the sphere, the shell, the sun's disk — and before the
overlays: rings, plumes, flares, traces and instruments. The sea already
splits the scene pass to read the frame behind it (`SeaFrameNode`, the
timeline's `scene after copy`), so the first candidate is a node at that
split that runs the trace and composites into the multisampled target,
keeping the overlays drawn after it multisampled. If three does not tolerate
a quad pass inside a node's `updateBefore` there, two scene passes do it,
the overlays in their own over the composite. Phase 0 decides.

Under temporal FSR the composite runs at render resolution before the
upscaler, writes the cloud's opacity into `reactive` — where ADR-0044 already
puts the deck's alpha — and leaves `velocity` alone. Under Enhanced from
orbit, the air in front of a cloud takes `clearedFromOrbit` as a surface's
does.

---

## 6. What the clouds do to everything else

### 6.1 One shadow

Sun-space cascades of optical depth, centered on the eye's footprint on the
ground, scrolled as it moves and refreshed a slice a frame. Each texel holds
the front depth, the mean extinction and the maximum optical depth along the
sun's ray, so any point on the ray reads its transmittance — UE5's Beer
shadow map
([Hillaire 2020](https://blog.selfshadow.com/publications/s2020-shading-course/hillaire/s2020_pbs_hillaire_slides.pdf)).
The atlas's sun transmittance takes over past the last cascade. takram draws
three 512² cascades with 50 steps every frame, and the unofficial TSL port
measures that at about 3.7 ms on an Apple GPU, the largest single cost of the
effect; RDR2 refreshes a sixteenth a frame
([2019](https://advances.realtimerendering.com/s2019/slides_public_release.pptx)).
Sliced, the cascades rebuild whole in sixteen frames after a jump.

One function reads it, `cloudSunlight(point)`, and the ground, the sea and
the sphere call it alike (rule 59), as do the hull's key light, the march's
far light, the air's march (§6.3) and the flare (§6.4). A GPU test holds the
sphere's cloud shadow and the ground's to one value at the descent gate.

### 6.2 Under a deck

Overcast is the light a deck lets through. For a conservative slab,
two-stream theory gives reflectance `R = (1−g)τ / (2 + (1−g)τ)` and diffuse
transmittance `1 − R`
([Stephens' notes](https://reef.atmos.colostate.edu/~odell/AT622/stephens_notes/AT622_section15.pdf)):
at g = 0.85, 0.73 of the light comes through τ = 5, 0.57 through 10, 0.40
through 20 and 0.21 through 50. The ground under cloud takes the clear sky's
irradiance over its clear fraction and the deck's diffuse transmission over
the rest, and no beam where the shadow says so. The deck's τ over a point is
the atlas's column.

The clear sky's share comes from the irradiance table §5.3 bakes, which
closes two of the air's defects on the way: the linear ramp that puts a
quarter of the noon sky on the ground
([the air](the-air.md#the-days-skylight-ramp-puts-too-much-sky-on-the-ground))
and the deep sky read from one zenith under the eye
([the air](the-air.md#the-deep-sky-is-one-zenith-under-the-eye)).

### 6.3 The air under the clouds

Each sample of `marchAir` multiplies its sun by `cloudSunlight` at the
sample — the shell's twelve and each surface's four. That is the dark air
under a storm, crepuscular rays through gaps, and a towering cumulus's shadow
laid across the twilight sky. Jittered per pixel the shafts are noisy, and
the scene pass keeps no history under MSAA; if they band, the cloud pass
marches the shadowed air at a quarter resolution under its own history, at
16 steps or fewer, and the composite carries the difference. Hillaire's
jittered, reprojected 32-sample march costs about 1.0 ms on a GTX 1080
([EGSR 2020](https://sebh.github.io/publications/egsr2020.pdf)).

### 6.4 The sun, the hull and the flare

The flare's visibility and the hull's key light each take `cloudSunlight` at
their own point, on the GPU, so a sun behind a cloud dims both in the frame
it dims, with no readback. The disk itself is behind the clouds in the
composite.

### 6.5 Night

A city under cloud lights the base from below — orange over a city seen from
the ground, a diffuse glow seen from orbit — which is the night map's
emission spread over the base by the cloud's own transport. An overcast night
is also the first thing to meet the meter's dark clamp
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
with alpha `2a/(|v|·T)`, capped at one: 15 cm at 1/60 s and 9 mm at
1/1000 s for a 9 m/s fall, 1.7 m at 100 m/s of airspeed. Drops fall at
`v = 9.65 − 10.3·e^(−0.6D)` m/s for D in millimeters
([fall speed](https://journals.ametsoc.org/view/journals/apme/49/4/2009jamc2208.1.xml))
and are Marshall–Palmer, `N(D) = 8000·e^(−ΛD)` with `Λ = 4.1·R^−0.21`
([1948](https://journals.ametsoc.org/view/journals/atsc/5/4/1520-0469_1948_005_0165_tdorws_2_0_co_2.xml)).
Past about three times `z_m = 2fa` — some 10 m at 1080p through a 60° lens —
rain only adds up like fog, which the extinction already carries.

The near drops live in a camera-relative wrapped volume at positions closed
in simulation time: Far Cry 6's cylinder
([2022](https://gameindustrylibrary.com/documents/simulating-tropical-weather-in-far-cry-6)),
without the lag NVIDIA's particle volume showed behind a fast camera, and
exact under a scrub. At 10 mm/h that is about 60,000 drops over 1 mm. Near
drops take their own circle of confusion, and splashes spawn from depth.

### 7.3 Wet ground

A wet surface darkens by its porosity and smooths toward water
([Lagarde](https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/)).
Penndorf measured luminous reflectance falling, wet, from 24–31% to 18% for
sand, from 15% to 7.5–9% for clay soil and from 35% to 15–25% for concrete
([1956](https://journals.ametsoc.org/downloadpdf/view/journals/bams/37/4/1520-0477-37_4_142.pdf)).
Puddles take F0 = 0.02 and a flat normal in the terrain's concavities below a
flood level, with ripples while it rains. Wetness is the rain's own history in
closed form, `W(t) = ∫ R(t′)·e^(−(t−t′)/τ) dt′`, sampled from the weather at a
few past instants with a longer τ for puddles, so a jump rebuilds nothing.
The sea under rain loses the sharpness of its glint. The ground, the sea and
the sphere take wetness alike (rule 59).

### 7.4 Snow, and the temperature it needs

Snow needs a freezing level, which needs the air to have a temperature: a
surface temperature by latitude and season and a lapse rate — Earth's mean is
6.5 K/km — to a tropopause near 18, 13 and 8 km over the tropics, the
middle latitudes and the poles
([WMO-407](https://cloudatlas.wmo.int/docs/wmo_407_en-v1.pdf)). The same
profile makes cirrus ice, stops a cumulonimbus at its anvil and picks a
generated world's condensate. Aggregates fall at 0.5–1.4 m/s; cover is
exposure times inclination from the same top-down map; fresh snow's albedo is
0.8–0.9 and ages toward 0.5–0.6 when wet, both closed-form in time
([Pomeroy](https://www.inscc.utah.edu/~campbell/snowdynamics/reading/Pomeroy.pdf)).
Whiteout — overcast over unbroken snow, sky and snow equally bright — then
needs no case of its own.

### 7.5 Lightning

Flashes are events of the storm's cells (§4.4): three intracloud for each to
the ground over the US
([Boccippio 2001](https://journals.ametsoc.org/view/journals/mwre/129/1/1520-0493_2001_129_0108_csasbe_2.0.co_2.xml)),
three to five strokes 40–50 ms apart
([Dwyer & Uman 2014](http://www.lightning.ece.ufl.edu/PDF/Published%20Journals/2014/Dwyer%20&%20Uman%20%282014%29a.pdf)),
and 44 ± 5 a second over the Earth, ten times more over land
([Christian 2003](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2002JD002347)).
Each is integrated over the shutter's interval, so a long exposure catches
the whole flash and a scrub lands on the same strokes. A channel is a walk
turning 16° a segment on average from its seed, which matches digitized
strokes ([Glassner](https://www.glassner.com/wp-content/uploads/2014/04/CG-CGA-PDF-00-03-The-Digital-Ceraunoscope-1-Mar00.pdf)),
and the sensor's point-spread function gives it its width
([Kim & Lin](https://gamma.cs.unc.edu/LIGHTNING/lightning.pdf)). Inside a
cloud the flash is an emitter the primary march reads, outside the history,
as Guerrilla's and Far Cry 6's are; from orbit it lights 60–70% of its cell's
top. A first stroke's measured power spans a hundredfold, 1.3×10⁸ to
1.8×10¹⁰ W, so its brightness is a calibration with a range, recorded as one
and measured against a scene unit that is settled first (§8.4). Thunder lags
3 s a kilometer.

### 7.6 Fog

Fog is the field's lowest genus, a layer whose base is the ground, at
`σ = 144.7·LWC^0.88` km⁻¹
([Kunkel](https://www.mdpi.com/2073-4433/12/12/1666)): radiation fog on
clear calm nights in the valleys, advection fog over colder water, each from
the climate and the diurnal clock. The march's 3 m steps near the eye carry
it.

### 7.7 Dust

The air's tables bake a haze's dust as a constant, so a Martian dust storm is
extra dust in the volume — albedo 0.70–0.95, radii 1.4–1.8 µm
([Wolff](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2009JE003350))
— over the haze the tables already carry. Opportunity measured τ past 10.7
in the 2018 global storm. A dust devil is an analytic column, 2–276 m wide,
its dust reaching 20 km from orbit
([HiRISE](https://hirise.lpl.arizona.edu/ESP_026394_2160)).

### 7.8 On the window

The canopy is a sensor behind a window, and a wet window is part of the
picture: drops pushed by gravity and the apparent wind across the window,
defocused at the window's distance — a drop `d` in front of a lens focused
at `D` averages a footprint `D/(D+d)·f/N`, nearly the whole aperture
([2015](https://doi.org/10.1109/tpami.2015.2491937)) — and shed at speed.
It belongs to the sensor, declared like its glare, and is the last thing this
plan builds.

---

## 8. Optics and the upper air

### 8.1 What the Mie table makes free

A bow, a glory and a corona are features of the phase function, so drawing
first-order light through the tabulated Mie phase draws each where it
physically occurs, from orbit to the ground, with no overlay. A fogbow from
droplets under 50 µm is a broad white bow at 30–45°; a glory's red rings
stand at 24/r, 37/r, 56/r and 76/r degrees for r in µm
([Laven](https://philiplaven.com/p2c1.html)); a corona's at 16/r, 31/r and
47/r; mixed droplet sizes near the sun make iridescence. A rain shaft's drops,
near a millimeter, carry the primary bow at 40–42°, the secondary ten degrees
outside it at about 43% of its light, Alexander's band between, and
supernumeraries under a millimeter, from a second entry in the same table
([Practical Meteorology](https://www.eoas.ubc.ca/books/Practical_Meteorology/prmet/Ch22-Optics.pdf)).
Over a deck the ship's umbra ends about 107 hull lengths away, and past it
the glory alone marks its antisolar point.

### 8.2 Halos

Cirrus's first-order phase reads three tables traced offline for random,
plate and horizontal-column crystals, per sun elevation — 8 MB, from a
HaloRay-style tracer ([HaloRay](https://github.com/naavis/haloray)): the 22°
and 46° halos, sun dogs, tangent arcs, the circumzenithal arc under a sun
lower than 32.3°, pillars, and the subsun from above. They are weighted by a
pristine fraction, because a bright 22° halo stands in about 6% of cirrus
hours and a trace of one in 37%
([Sassen 2003](https://doi.org/10.1364/ao.42.000332)).

### 8.3 Airglow, noctilucent and nacreous clouds

ADR-0056 names the shortfall: past −15° the measured sky is mostly airglow
and starlight. Airglow is three thin shells — OI 557.7 nm at 96 km (250 R),
Na 589 nm at 92 km (30–100 R), OI 630 nm at 250–300 km (60 R) — over a
pseudocontinuum near 900 R. Through V(λ) they sum to about 1.2×10⁻⁴ cd m⁻²
at the zenith (computed), which is the two thirds of La Palma's measured dark
sky that Benn and Ellison assign to airglow
([ING](https://www.ing.iac.es/astronomy/observing/conditions/skybr/skybr.html)).
A tangent ray holds 53 times the vertical column, so from orbit the green
line is about 13 kR on the limb — the green band in every night photograph
from the ISS. Each layer is a 1D table of a shell's chord column, with no
march samples; under 0.05 ms by estimate. Noctilucent clouds are a sheet at
82.7 km, 0.5–2 km thick, seen at solar depressions of 6–16° between 50° and
65° of latitude in summer
([WMO](https://cloudatlas.wmo.int/en/explanatory-remarks-noctilucent-clouds.html)),
which the tables' shadow of the planet and their ozone should color blue on
their own. Nacreous clouds are a sheet at 15–25 km in polar winter,
iridescent through the corona's table at r ≈ 5 µm.

### 8.4 The scene unit's luminance

Every emitter here — airglow, aurora, lightning, cities under cloud —
converts physical radiance into scene units, and the tree states the unit two
ways. ADR-0056 makes a unit an albedo-one surface under the sun, which above
the air at 1 AU is 133.3 klx over π, 42,400 cd/m²; `SURFACE_LUMINANCE` in
`packages/rendering/src/exposure.ts` is 30,000, "under terrestrial
sunlight", and the galaxy's calibration divides by it. If the two name one
unit they disagree by 1.41 times, half a stop. Phase 5 settles which each
names before any emitter is calibrated against either.

### 8.5 Refraction

Bennett's formula puts 34.5′ of refraction at the horizon, 28.8′ half a
degree up and 9.9′ at five ([astroalgos](https://astroalgos.com/refraction)),
and a ray grazing Earth's limb from orbit bends about 70′ by the same
physics (computed). A bent-ray table per body — eye height by apparent
elevation, per channel for dispersion — applied to the sun, the moon and the
stars flattens and lifts the setting sun at no per-pixel cost. The green
flash needs a mirage layer, and stays out.

### 8.6 Aurora

The art direction licenses aurora and gates it on a magnetic field the record
does not carry ([planetarium](../../docs/design/planetarium.md)). With a
dipole on the record: OI 557.7 nm peaks near 100 km and lives 0.7 s, OI
630 nm stands above 200 km and lives 110 s, N₂⁺ is prompt along the lower
border; IBC I–IV are 1, 10, 100 and 1000 kR; the oval's midnight edge sits at
66° geomagnetic at Kp 0 and 2° lower per Kp
([SWPC](https://www.spaceweather.gov/content/tips-viewing-aurora)). Lawlor
and Genetti's footprint-times-deposition volume, skipping empty space by a
distance field, draws it from inside or outside the air
([2010](https://lawlor.cs.uaf.edu/~olawlor/papers/2010/aurora/lawlor_aurora_2010.pdf));
0.3–0.8 ms with the oval in view, by estimate.

---

## 9. The budget

These are budgets. Their basis is published figures on other hardware,
scaled — takram on an M3 Max, its unofficial TSL port on an M4, RDR2 on a
PS4 — and spike 2's floor; phase 0 replaces each with this M5's own.

| Pass                             | Rate                              | 1080p              | Basis                                                                      |
| -------------------------------- | --------------------------------- | ------------------ | -------------------------------------------------------------------------- |
| Maps and the coverage max-mip    | When `t` moves a texel of weather | ≤ 0.05 ms          | Arithmetic per texel                                                       |
| Atlas                            | Progressive                       | ≤ 0.1 ms           | GT7 amortizes its sky dome over 32–64 frames                               |
| Shadow cascades                  | A sixteenth a frame               | ≤ 0.3 ms           | RDR2's shadow, 0.156 ms on a PS4; takram's unsliced, ~3.7 ms on Apple      |
| Trace at ¼ × ¼                   | Every frame                       | ≤ 1.2 ms           | takram's sixteenth at 4K, scaled to 1080p and the M5's cores: about 1.4 ms |
| History at ½                     | Every frame                       | ≤ 0.3 ms           | RDR2's reconstruction, 0.232 ms on a PS4                                   |
| Composite and the air in front   | Every frame                       | ≤ 0.2 ms           | One `airToward` a reconstructed pixel                                      |
| Shadowed air                     | Every frame                       | ≤ 0.3 ms           | One shadow tap per air sample                                              |
| Near rain                        | While it rains                    | ≤ 0.5 ms           | ~60,000 instanced streaks                                                  |
| **On the ground, dry / in rain** |                                   | **≤ 2.5 / 3.0 ms** |                                                                            |
| **From orbit**                   |                                   | **≤ 1.5 ms**       | A thin shell, low-frequency density, early exits on the tops               |

The ground at 1080p holds 12.4 ms today, so the weather keeps it under
vsync. Retina holds the 1080p ray budget and upsamples; its ground already
misses vsync at 26.2 ms (perf), and the weather must not widen that by more
than the 1080p figure. A cost is `ir.gpu()` taken A/B in one boot — Apple's
timestamps are latency, not share
([harness](../../docs/guides/harness.md#where-the-gpus-frame-goes)) — on
Earth and on a generated world, never in Sol alone.

---

## 10. Phases

Each phase lands green on its own, with its pictures and its numbers.

| Phase | Lands                                                                                                                                                                                                                                                                                                                                                                            | Done when                                                                                                                                                                                                                                                                                                                                 |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | The instruments. The slab against adding-doubling (Prahl's [`ad`](https://omlc.org/software/ad/)) and a seeded Monte Carlo slab; the furnace (a uniform sky, albedo one, no sun: the radiance is the sky's at any density); step convergence. A trace spike at ¼ on this M5. The composite's placement chosen. The pictures of §2 as presets, on Earth and a generated wet world | The spike's `ir.gpu()` figures at 1080p and Retina, orbit and ground, stand in §9 in place of the trace's budget; the placement is chosen with its reason                                                                                                                                                                                 |
| 1     | The volume over Earth and a generated world: the texture layer and the climate (ISCCP-H for Earth), the genus density, the march, the Mie table, the fitted octaves, the irradiance table, the history and the composite. The deck, its map and its lift retire on every body the volume draws                                                                                   | The slab within 5% of adding-doubling for τ 5–50 at three sun elevations; the furnace within 2%; cumulus from orbit, the limb at dusk, fair weather, underlit at dusk, over the deck and inside, taken on both worlds; the art direction's descent recording through a deck with no frame that steps; §9 met at both sizes on both worlds |
| 2     | The shadow and the light: cascades and atlas, `cloudSunlight` in the ground, the sea, the sphere, the hull and the flare; overcast; the shadowed air                                                                                                                                                                                                                             | One cloud shadow at the descent gate, within 1%; illuminance under a τ 20 deck within 10% of the march's own hemisphere integral; the air's two skylight defects closed                                                                                                                                                                   |
| 3     | Organized weather: the events and their kernels, the diurnal clock, the temporal detail under warp                                                                                                                                                                                                                                                                               | Global cover 0.67 ± 0.03 and every 10° zonal band within 0.05 of MODIS; 80–90 tropical cyclones a year over ten simulated years, 72% northern, each turning by its hemisphere; the whole face judged against EPIC by the look council                                                                                                     |
| 4     | Rain, wet ground, snow over a freezing level, lightning, fog                                                                                                                                                                                                                                                                                                                     | Visibility under rain and fog within the measured σ–R and Koschmieder relations; overcast and the storm at night judged against photographs; near rain at 50 mm/h within its budget                                                                                                                                                       |
| 5     | The optics and the upper air: the bows, halos, airglow, noctilucent and nacreous clouds, refraction; the scene unit settled; aurora once a dipole exists                                                                                                                                                                                                                         | Airglow's zenith within 30% of 1.2×10⁻⁴ cd m⁻²; the glory's and the bows' rings at their measured angles in a GPU test; the twilight pictures re-scored                                                                                                                                                                                   |
| 6     | Other worlds: Mars's ice clouds and dust, Titan's convection, Venus's decks from above, the condensation sequence for generated worlds; the window                                                                                                                                                                                                                               | Each body's picture judged against its mission imagery                                                                                                                                                                                                                                                                                    |

Phase 0 goes first because every figure in §9 is borrowed. Phases 1 and 2
reach `main` together for Earth: a volume without its shadow is the
descent-gate step again.

---

## 11. Decisions, and the questions still open

The plan decides three things and asks four.

**Decided.** The weather is presentation until physics reads it (§3). The
default native picture keeps its own cloud history, since it has no
reconstruction to borrow one from (§5.5). The far representation is baked
from the volume, never authored beside it (§5.4).

**Open:**

1. **Earth's weather is the climatology's, moving, and the Blue Marble deck
   retires** — recommended. The alternative keeps the photographed map as the
   coverage at the disk's scale: static, and real only as three days stitched
   together, so no instant ever looked like it. The climatology is the
   measured part of the weather: its statistics.
2. **A temperature profile on the record, derived and presentational** —
   recommended: a surface temperature by latitude and season, a lapse rate and
   a tropopause, which snow, ice and a generated world's condensate need. The
   drag model's isothermal air stays.
3. **WebGL draws the atlas alone**, declared, as it declares Manual in place
   of Automatic — recommended over no clouds at all.
4. **The record grows for the late phases**: a pole direction for calendar
   seasons and the polar phenomena, a magnetic dipole for aurora, and
   condensables for generated worlds. Each is a version for the system
   generator when it lands, not this plan's to spend.

---

## 12. Risks

- **The Retina ground is already late.** It misses vsync at 26.2 ms before
  any weather, and a volume sized by the drawing buffer would add two and a
  half times the 1080p cost. The ray budget is the guard, and phase 0
  measures it first.
- **The limb's handover.** Where the atlas takes over, any disagreement with
  the march is a band, and the visible failures are blackrack's fade band and
  KSP2's surface vanishing from orbit. The handover test is the guard.
- **Ghosting.** takram lists ghosting in sparse cloud, disocclusion errors and
  depth errors where distant layers overlap as its own known issues; the
  immediate regime and the trace-end depth are the answers, and casts at
  reentry speed are the check, not stills.
- **three r185.** Implicit-level reads in a loop return zeros; a
  `Storage3DTexture` allocates mips it cannot fill; `r8unorm` storage needs
  Chrome's tier-1 formats (shipped in 142, before the 152 the figures use);
  TSL emits no f16, so the M5's doubled f16 rate is out of reach without
  `wgslFn`; an MRT holds 32 bytes a sample unless `requiredLimits` asks for
  more; a takram-class graph compiles cold in about 1.3 s, so it goes through
  `warmCompile`; a post-process quad's camera nodes describe the quad's
  camera; and reversed depth reverses the draw list, which a composite drawn
  as a scene object must survive.
- **Taste.** Eroded noise reads as cauliflower before it reads as cloud, and
  no number catches that. The look council's blind protocol, against
  photographs, is the instrument ([look council](look-council.md)).
- **One GPU job at a time.** The trace spike, the GPU suite and the rig never
  run together on this machine.

---

## 13. What the literature says

| Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Verdict                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The recipe — a weather map times a height profile times eroding noise ([HZD](https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf), [Nubis](https://advances.realtimerendering.com/s2017/Nubis%20-%20Authoring%20Realtime%20Volumetric%20Cloudscapes%20with%20the%20Decima%20Engine%20-%20Final%20.pdf), [Frostbite](https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016_pbs_frostbite_sky_clouds.pdf)) | **Adopted.** Every production system since 2015 is a variant of it                                                                                                            |
| A sixteenth of the pixels a frame at full resolution (HZD, takram)                                                                                                                                                                                                                                                                                                                                                                                                                                             | **Declined** for UE5's quarter traced into a half: a reentry crosses a cloud in a few frames                                                                                  |
| Voxel clouds and their SDF ([Nubis³](<https://advances.realtimerendering.com/s2023/Nubis%20Cubed%20(Advances%202023).pdf>))                                                                                                                                                                                                                                                                                                                                                                                    | **Not now.** They are authored hero clouds; a planet's closed-form field has no voxels to author, and the atlas's column optical depth is its empty-space skip                |
| Beer–powder, a max of two lobes (Nubis 2017)                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **Declined.** A max of normalized lobes integrates above one; the octaves fitted to the slab replace both                                                                     |
| Octave multiple scattering ([Wrenninge](https://fpsunflower.github.io/ckulla/data/oz_volumes.pdf))                                                                                                                                                                                                                                                                                                                                                                                                             | **Adopted, fitted** to the slab, because its sum gains energy in thin media                                                                                                   |
| HG–Draine ([Jendersie & d'Eon](https://research.nvidia.com/labs/rtr/approximate-mie/))                                                                                                                                                                                                                                                                                                                                                                                                                         | **Adopted for the higher orders**; tabulated Mie for the first, which carries the bows and the glory                                                                          |
| Neural transport ([RPNN](https://jannovak.info/publications/DeepScattering/index.html), [MRPNN](https://sites.cs.ucsb.edu/~lingqi/publications/paper_mrpnn.pdf))                                                                                                                                                                                                                                                                                                                                               | **Declined.** Trained per cloud with a uniform albedo, and 5 ms for one cloud on an RTX 2080                                                                                  |
| Beer shadow map cascades (UE5, takram)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **Adopted, sliced.** Unsliced they are the largest cost on Apple                                                                                                              |
| Froxel volumetric fog ([Wronski](https://advances.realtimerendering.com/s2014/wronski/bwronski_volumetric_fog_siggraph2014.pdf), Frostbite 2015, UE5)                                                                                                                                                                                                                                                                                                                                                          | **Not now.** A time jump voids its history and a flash trails in it; fog near the eye is the march's near steps                                                               |
| Epipolar light shafts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **Declined.** They assume a uniform medium and one light                                                                                                                      |
| Textured shells ([SpaceEngine](https://spaceengine.org/manual/making-addons/creating-a-planet/))                                                                                                                                                                                                                                                                                                                                                                                                               | **What retires**                                                                                                                                                              |
| A volume near and a 2D layer far ([blackrack](https://www.patreon.com/blackrack/posts/true-volumetric-139879553), [KSP2](https://kerbalspaceprogram.com/news/developer-insights-22-skys-the-limit))                                                                                                                                                                                                                                                                                                            | **Adopted as the atlas**, crossed by footprint rather than altitude and baked from the volume, as blackrack's fifth release bakes its layer                                   |
| A cached sky dome ([GT7](https://s3.amazonaws.com/gran-turismo.com/pdi_publications/GDC2023_GT7_SKY_RENDERING.pdf))                                                                                                                                                                                                                                                                                                                                                                                            | **Declined.** One dome from one center does not survive a camera between orbit and the ground                                                                                 |
| Live weather data (Flight Simulator's Meteoblue, X-Plane's GRIB)                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Declined.** The simulation's instant is not today; the climatology is the measured part                                                                                     |
| Sparse convolution ([Lagae 2010](https://www-sop.inria.fr/reves/Basilic/2010/LLCDDELPZ10/LLCDDELPZ10STARPNF.pdf)), bounded advection ([Neyret 2003](http://evasion.imag.fr/Publications/2003/Ney03/neyret161.pdf))                                                                                                                                                                                                                                                                                             | **Adopted.** Together they are weather as a function of time                                                                                                                  |
| Jackknife transmittance ([Peters 2025](https://momentsingraphics.de/SiggraphAsia2025.html))                                                                                                                                                                                                                                                                                                                                                                                                                    | **Adopted**, for the clouds and the air's own marches                                                                                                                         |
| Rain streaks by exposure ([Garg & Nayar](https://www.cs.columbia.edu/CAVE/publications/pdfs/Garg_IJCV07.pdf)), wet surfaces ([Lagarde](https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/))                                                                                                                                                                                                                                                                              | **Adopted**                                                                                                                                                                   |
| Aurora by footprint and deposition ([Lawlor & Genetti](https://lawlor.cs.uaf.edu/~olawlor/papers/2010/aurora/lawlor_aurora_2010.pdf))                                                                                                                                                                                                                                                                                                                                                                          | **Adopted**, once a dipole gates it                                                                                                                                           |
| [takram three-geospatial](https://github.com/takram-design-engineering/three-geospatial) (MIT)                                                                                                                                                                                                                                                                                                                                                                                                                 | **Read, not vendored.** It is GLSL with local weather and no view from space, and its WebGPU build does not import on r185; its constants are the starting points cited above |

---

## Related

- [ADR-0056](../../docs/adr/0056-the-air-is-measured-and-its-gain-is-pi.md) — the air the clouds stand in
- [The air: what is left](the-air.md) — the defects §6.2 closes, and the ones it meets
- [ADR-0044](../../docs/adr/0044-the-sensor-reconstructs-the-display.md) — the scene pass, `reactive` and FSR
- [ADR-0033](../../docs/adr/0033-presets-hold-a-photographic-instant.md) — why a plate holds its weather
- [Art direction](../../docs/design/art.md) — the license and the continuity specification
- [The look council](look-council.md) — the protocol the pictures are judged by
- [Perf](perf.md) — the frame this fits in
