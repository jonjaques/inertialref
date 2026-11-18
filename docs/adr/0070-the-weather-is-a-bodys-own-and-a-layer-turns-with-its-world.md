# ADR-0070: The weather is a body's own, and a layer turns with its world

Status: accepted · 12 Nov 2026. Amends
[ADR-0064](0064-the-clouds-march-the-field-and-the-suns-depth-is-a-grid-summed-through-the-volume.md)'s
maps: the weather cube is two RGBA8 targets and the clipmap one, a layer a
cloud level. What a genus holds inside its clouds is
[ADR-0069](0069-a-genus-is-its-water-and-its-columns-fall-in-isccps-classes.md)'s.
Everything here draws only under `?clouds=1`.

## Context

Phase 0 drew one scenario for every body, through one set of layer
uniforms, and moved it with one drift. Three things about that could not
carry to an MVP judged on Earth and on a generated world.

- **A body had no weather of its own.** A generated wet world drew whatever
  regime the lever named, and so did Earth. A climate that says where the
  subtropics are clear and the storm tracks are cloudy is what makes a
  planet from orbit look like one, and the plan asks for it per body.
- **The drift restarted every hour.** One drift vector for every layer slid
  the noise for 3,600 s of simulated time and then started over. The restart
  was a jump: the history and the far bakes threw their work away once an
  hour, and every cast that crossed an hour showed a step.
- **The drift was the observer's.** The wind was built in the eye's own
  tangent basis, so at a held instant, moving the eye turned the whole
  lattice and the density at a fixed body point changed with where it was
  seen from. The history's reprojection cannot follow a motion that is not
  in time, and the rubric's row 17 asks for a weather that is a function of
  `(body, place, renderTime)` and nothing else.

And Earth already has clouds: an authored deck, a photograph, which the
volume cannot yet replace. The volume has no shadow on the ground until
phase 2 and no measured climatology until phase 3.

## Decision

**A body's weather is derived from its record and stored nowhere: three
levels, a climate that says how much of each is cloud at a place under a
sun, and a turn. Each level's lattice turns rigidly about the spin axis at
its own rate and drifts along it, so the field at a place and an instant is
one value from every eye and every date. The volume serves a body unasked
only when it is wet and has no authored deck, so Earth is outside the set
until phase 3. The climate reaches the GPU through two textures: a weather
cube of cover and kind, and a clipmap that holds a step's cover, share and
gain in one texel.**

### `BodyWeather`

`packages/rendering/src/weatherClimate.ts`.

```ts
export interface BodyWeather {
  readonly seed: Seed // deriveSeed(surface.seed, 'weather')
  readonly datumRadius: number // the body's radius, meters
  readonly levels: readonly [LevelSpec, LevelSpec, LevelSpec]
  readonly climate: BodyClimate
  readonly turn: readonly [number, number, number] // rad/s, against the ground
  readonly drift: number // m/s along the spin axis
}
```

- **Derived, stored nowhere** (rule 17): nothing here is hashed or saved. The
  seed is a derivation of the surface's, never a draw from the body's
  generator, so two bodies generated in either order have one weather each
  (rule 4). `weatherCanon.test.ts` holds `world.stateHash()` equal with the
  weather evaluated between ticks and without (row 18).
- **A level** is an envelope over the datum and two genera, the one it holds
  where it is stratiform and the one where it is cumuliform. The profile
  table blends them along eight rows of convective share.
- **A regime and a climate are one type,** so every reader has one path.

### The three kinds of climate

`BodyClimate.kind` is `'regime'`, `'zonal'` or `'measured'`. A climate
answers `sample(direction, sun, time)` on the CPU and `coefficients(sun,
time)` for the frame's uniforms, slot for slot, which the GPU's port of
`sample` (`climateNode` in `render/cloudMaps.ts`) evaluates at every texel.
The season is the sub-solar latitude and the local solar time is the sun's
longitude at the place; neither is a calendar's. A climate is a function of
the place, the sun and the instant, and of no observer:
`weatherClimate.test.ts` holds its sample to its arguments alone, from two
weathers built in either order (row 17).

- **`'regime'`:** a named scenario held over the whole body
  (`regimeWeather`). Its layers are the three levels, each one genus at both
  ends, and its pattern is the climate. All three levels turn at the regime's
  eastward wind over the body's radius; its northward wind is not drawn. A
  pattern of blobs is drawn as a uniform cover at the layer's coverage: a
  blob is 96 km on a 3,922 km world, so a stance would stand inside one or
  between two and see a whole sky or none, never the regime's cover.
- **`'zonal'`:** a wet world's own (`bodyWeather`), Earth's included. Its
  levels stand on its air's scale height `H`: low 0.08 to 0.30 `H`
  (stratocumulus to cumulus), middle 0.40 to 0.70 `H` (altostratus to
  altocumulus), high 0.95 to 1.30 `H` (cirrus); on Earth's 8.5 km that is
  0.7 to 2.6, 3.4 to 6.0 and 8.1 to 11.1 km. They turn at 8, 15 and 25 m/s at
  the equator over the body's radius. Its cover is the zonal law, below.
- **`'measured'`:** a gridded climatology, Earth's in phase 3. The kind and
  its uniform slot exist so the frame and the shader take it with no change
  of shape; nothing produces one in phase 1.

The `weather` lever picks among them: `'climate'` draws the body's own, and a
scenario's id holds that regime over the body. A body with no weather of its
own that a lever forces by address (a dry one) draws `'climate'` as
`fair-cumulus` (`CLIMATE_REGIME`), as phase 0 drew every body.

### The zonal law

Per level `k`, at latitude `φ` under a sub-solar latitude `δ`:

```
cover_k      = base_k + itcz_k·G(φ − φ_I) − dry_k·[G(φ − φ_H) + G(φ + φ_H)]
                      + storm_k·[G(φ − φ_S) + G(φ + φ_S)]
convective_k = saturate(κ_k·G(φ − φ_I))
```

with `G(x) = exp(−x²/2w²)`, the convergence zone at `φ_I = ι·δ`, the Hadley
cell's edge `φ_H` and the storm tracks at `φ_S = φ_H + 20°`. The three rows of
four amplitudes and the four shared angles are the sixteen numbers of the
climate's `law` uniform, a `mat4`.

- **The Hadley edge** is 30° at Earth's rotation and widens as a body turns
  slower, `φ_H ∝ Ω^−1` (Held and Hou 1980), clamped to 12° to 80°.
- **A synoptic field** multiplies the law: `1 + ½·(n − ½)`, `n` the base
  noise on a lattice 1,000 km across, turning with the low level. It puts
  fronts and highs a quarter either side of the zonal mean. A lattice that
  coarse may be read from an absolute direction; rule 58 binds fine ones.
- No land, no sea and no hour of the day enter. Those are phase 3's.

**The fit.** The amplitudes, `ι` and the width are fitted to ISCCP-H's zonal
table (`isccpZonal.generated.ts`, 2007 to 2016): every month of the twelve
10° bands from 60° S to 60° N, each level's cover as a satellite sees it from
above (a level under higher ones counts where they are clear, the three
overlapped at random) and the total, in least squares weighted by each
band's area, the total twice. Each month's sun is the sub-solar latitude on
its 15th, and the synoptic factor is integrated over its spread, so what is
fitted is the cover the field draws, not the law's mean. Two starting points
converge to the same fit.

| Coefficient      | Low    | Middle | High   |
| ---------------- | ------ | ------ | ------ |
| `base`           | 0.2867 | 0.1482 | 0.0873 |
| `itcz`           | 0.0545 | 0.0691 | 0.2424 |
| `dry`            | 0.0308 | 0.063  | 0      |
| `storm`          | 0.3355 | 0.2587 | 0.1742 |
| `κ` (a stand-in) | 2      | 1      | 0      |

`ι` is 0.2975 and `w` 13.84°. `weatherCalibration.slow.test.ts` recomputes the
fit's figures and holds them, in Node on the Mac mini (Mac18,5, Apple M6):

- The global mean is 0.6403 against ISCCP-H's 0.6475. The levels from above
  are 0.237, 0.179 and 0.224 against 0.226, 0.190 and 0.232.
- No band's annual total from 40° S to 40° N is more than 0.051 off. From 40°
  to 60° the law is under in the south and over in the north, because it is
  symmetric about the equator and the southern ocean is cloudier than the
  northern continents. The bands outside 0.05 are ADR-0069's declared row 16.
- Month by month from 60° S to 60° N the total's residual is 0.056 RMS, and
  0.146 at worst, in August at 30° to 40° N, the continents' dry season again.
- The high level has no dry belt: its amplitude fits to zero, because
  ISCCP-H's high cloud is nearly flat over the subtropics.

### The turn

**Each level's lattice turns rigidly about the spin axis at its rate `ω_k`,
and drifts along it at `w` = 0.25 m/s** (`WEATHER_AXIAL_DRIFT`). A body-fixed
point `p` is read at

```
p′ = R_y(−ω_k·t)·p + ŷ·w·t
```

- **On the CPU** (`fieldClock`, `weatherField.ts`), `ω_k·t` is reduced by a
  whole turn before it is scaled, and the drift by the noise's period, in
  float64. Ten years of a slow turn keep the precision of one revolution.
- **On the GPU** a sample's lattice coordinate is
  `(origin_k + M_k·offset)/cell`: `M_k` the turn as a float32 matrix,
  `offset` the sample less the eye, and `origin_k = M_k·eye + ŷ·w·t` reduced
  in float64 on the CPU (`latticeOrigin`). The eye's term is float64 and the
  offset eye-relative, so rule 58 holds.
- **Nothing in the lookup is the observer's.** The turn is about the body's
  axis and the drift along it, both in body-fixed axes. The eye enters only
  as the point the float32 offset is measured from, and
  `M_k·eye + M_k·offset` is `M_k·p` for any eye.
- **A rigid turn has no shear,** is exact on a sphere at every latitude and is
  defined for all time. No instant is a restart, so a steady clock at any
  warp raises no jump.

Held by tests in Node and on the GPU:

- `weatherField.test.ts` maps a body point to one lattice point from any two
  eyes, modulo the noise's period, as a property; carries a cloud ten years
  past the epoch by the turn's own step a frame with no restart at any
  instant (row 19); and turns and drifts by exactly the span between any two
  instants.
- `cloudFrame.test.ts` holds the same on the frame's own turn and origin, with
  one eye at a pole.
- `cloudDensity.gpu.test.ts` reads the extinction at one body point and
  instant through the fine medium from an eye 10 km off and one 2,000 km off
  over the pole, and holds them within one 8-bit step (package F, on the Mac
  mini's adapter).

**Where the shape does not evolve.** The drift along the axis is what
changes the slice of noise a level cuts, and a translation along the axis is
vertical at a pole and horizontal at the equator. A 1,200 m cumulus cell's
shape turns over in 80 minutes at a pole and in `80/|sin φ|` minutes at
latitude `φ`: fifteen hours at E1's 5° south, and never on the equator, where
the pattern slides toward one pole unchanged (arithmetic from the cell and
the drift, not a measurement). Under warp the tropics are a rigid texture.
It ends with phase 4's advection.

**What the turn costs.** In the march, a level's turn matrix in its uniforms
and one product a noise read. In the sun's depth nothing new: the volume
holds the field in body-fixed texels and its steady refresh ages them faster
than the fastest level turns.

### The field's tile, broken (a departure)

The base noise tiles every eight cells, 9.6 km for cumulus, and a cover that
holds over a stance lays that one tile across the whole field. Without a
remedy E1's cloud-or-clear map correlates with itself at 0.876 at 23.5 km
and G4's at 0.828 at 32 km. Real cumulus fields are herded by the boundary
layer's circulation and repeat at no lag.

**Each level's noise is read displaced by a smooth field over tens of
kilometers** (`weatherField.ts`, the mesoscale waves): six waves along the
axes of an icosahedron turned off the lattice's own, each displacing across
its own direction, with wavelengths of 17, 23, 31, 41, 55 and 73 cells (20 to
88 km for cumulus) that share no ratio of small integers. Each displacement
is perpendicular to its wave's direction, so the field is divergence-free: it
moves the noise and neither makes nor removes cloud, and a stance keeps its
regime's cover and its share of cloudy columns. Each wave steepens the
displacement by 0.11 (`MESOSCALE_GRADIENT`), the six by at most 0.66, under
the 1 at which the noise would fold over itself.

- **Measured** in Node on the Mac mini (`weatherField.test.ts`, "the field
  from orbit"), a map at 200 m over 80 km correlates with itself, at any lag
  from 2 to 40 km: E1 0.249, G4 0.154, G6 0.213 from 400 km and 0.140 from
  40 km, and 0.296 at most over 24 places drawn at random on Earth and the
  cornerstones' world under cumulus and stratocumulus. The test's bar is
  0.3, set at the measured worst and not from a measured photograph.
- **On the GPU** E1's tile is 0.249, as the CPU's (package F).
- **Its cost.** The fine medium carries the six waves' sines and cosines from
  one call to the next along a ray, turned by their Taylor series, so a step
  pays about 80 multiply-adds and no transcendental, and a ray 12 sines and
  cosines a level it enters (counted from the code, not timed apart). Over
  960 calls of 1 km steps and their taps the carried phase drifts 8.4 × 10⁻⁶
  of a cell at a 1,000 m cell and 2.1 × 10⁻⁵ at 500 m, measured on the GPU
  against float64. No texture is bound for it. The far media and the bakes
  evaluate the waves where they read.
- **Six, not four:** a lag nearly perpendicular to every wave sees no
  displacement, and with four, three lay across E1's repeat and it held at
  0.48.

The waves are a stand-in for the circulation, not a model of it. No
observation in reach constrains their constants; row 10's cell sizes are
the nearest observable, and the base noise drives those.

### The served set, and Earth

```ts
export function cloudsServed(body: Body): boolean {
  return wetWorld(body) && body.appearance.clouds === null
}
```

- **Wet:** a sea of water, and no haze deep enough to be a deck already
  (`wetWorld`, an aerosol depth under 1). A sulfuric air and Titan's are a
  cloud the air's tables draw, and a volume over them counts it twice.
- **No authored deck to lose.** Earth is wet and keeps its textured deck, so
  it is outside the set. The volume has no shadow on the ground until phase 2
  and no measured climate until phase 3, and with the volume forced it draws
  the zonal law at Earth's own rotation, beside the deck.
- **A forced address wins over the set.** `servedBody` serves the body whose
  air the eye is inside, else the largest wet one by angular radius; a forced
  address serves that body, or nothing if it is not in the scene, so a
  measurement never silently prices another. A picture's weather and the
  `served` lever put Earth in that way
  ([ADR-0067](0067-a-preset-holds-its-weather-and-a-cornerstone-is-a-preset-no-list-shows.md)).
- **The deck's shadow yields with the deck.** On a frame the volume serves
  Earth the deck hides, and its map stops darkening the sphere.
- **In phase 3 Earth's `clouds` record goes,** and the predicate admits it
  with no change here.

### The two map textures

Both are baked from the climate and carry nothing finer than it, which on
Earth is a cube texel of 19.6 km at the equator.

| Texture                                      | Shape                                                                                                                            | Holds                                                                                                                                                                                    | Bytes      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **The weather cube** (`render/cloudMaps.ts`) | Six tangent-warped faces of 512² with a one-texel gutter, 3 × 2 in one 1,542 × 1,028 atlas; two RGBA8 targets one MRT quad draws | `cover`: the three levels' cover and the middle level's ice share. `kind`: their convective shares and the deep-convection rate                                                          | 12,681,408 |
| **The clipmap** (`render/cloudClipmap.ts`)   | Six eye-anchored levels of 256², 250 m × 2^k, a layer each cloud level: 18 layers of one RGBA8 2D array, toroidally addressed    | A level's cover and convective share, and its gain (ADR-0069) as sixteen bits over two channels, split linearly so the sampler's filtering of the two bytes is the filtering of the gain | 4,718,592  |

- **A layer a cloud level,** not the cube's packing of three levels a texel,
  so a step's cover, share and gain are one texel of one texture. The trace
  binds one clipmap texture and reads it once a step, twice in a level's fade
  band.
- **The fine march never reads the cube.** Two bakes do: the clipmap's levels
  and the served body's far atlas. A second clouded body has no cube and
  reads its climate directly (`climateNode`).
- **The drawn field is held to the CPU's.** Package F's
  `cloudDensity.gpu.test.ts`, on the Mac mini's adapter, in σ′ of the
  level's reference, at the 99th percentile: 2.4 × 10⁻³ to 8.6 × 10⁻³ for
  the regimes through the frame's layout, and 6.7 × 10⁻³ for Earth's zonal
  climate read directly, as a second body reads it. Through the cube, Earth's
  zonal climate is the departure below.

### Earth's climate through the cube (a departure)

**The cube holds the cover in a byte, and Earth's blended levels' gain is
steep at small covers,** to 20 and 30, where one byte of cover moves the gain
by several percent. So Earth's zonal climate drawn through the cube and
the clipmap stands 1.7 × 10⁻² to 2.6 × 10⁻² of σ′ off the CPU at the 99th
percentile, over three stances and the cube's own medium, where the same
weather read from the climate directly stands 6.7 × 10⁻³
(`cloudDensity.gpu.test.ts`, on the Mac mini's adapter). The test holds it at
0.052, twice the measured. A 16-bit cover in the cube and the clipmap would
bring it to the climate's own figure, for about 11 MB more (package F's
estimate, not built). It is phase 3's, where
Earth is served unasked.

## Alternatives considered

**Phase 0's drift, kept.** One vector for every layer, built in the eye's
tangent basis and restarting every hour. The restart is a jump every hour
of simulated time, a history reset and a far-bake restart on every default
path, and the basis makes the density at a fixed point a function of the
eye. A rigid turn is exact, continuous for ever and costs a matrix.

**A drift that follows the eye's vertical,** so the shape evolves on the
equator too. The accumulated offset would then move with the eye, which
breaks the float64 reduction and makes the field the observer's again.

**Neyret's bounded advection, now.** It needs a wind that varies over the
body, and the wind field is phase 4's. Until then a varying wind would be
invented, and a rigid turn draws the zonal flow exactly.

**A climate authored per body, or stored with it.** Rule 17: the weather is a
function of the record, the place and the instant. A stored climate is a
save format for something regenerable, and an authored one does not exist
for a generated galaxy.

**Earth in the served set now.** It would hide a photographed deck behind a
volume with no ground shadow, no measured climate, and the cube's byte of
cover at Earth's steep gain. The deck stays until the volume passes E3's bar.

**Phase 0's four map targets.** The cube held a log in-cloud depth, rain,
wind, wetness and puddles beside the cover and the convective share, in four
targets and 25,362,816 bytes. A cloud's depth is now its genus's
(ADR-0069), rain and wetness are phase 4's, and no medium reads a wind from
the cube: the turn is each level's own. The clipmap's four targets were
6,291,456 bytes; its one holds what a step reads.

**The displacement in the clipmap.** Baking each level's displaced lattice
into the clipmap cost 14,155,776 bytes against the design's 3.15 MB and a
sampled binding more. Carried along the ray it costs arithmetic and no
binding.

**One displacement wave a lattice axis.** Four waves leave lags nearly
perpendicular to every wave, and E1's repeat held at 0.48.

## Consequences

The weather of a body is one function wherever it is read: the march, the
far bakes, the volume, a second body, the cornerstones' ledger and the
calibration all take it from the record, the place and the instant. Two
eyes see one cloud, and ten years from the epoch the field moves by the turn
alone.

A generated wet world has a climate fitted to Earth's, at its own rotation
and scale height. That is a claim about Earth borrowed for every world: the
amplitudes are Earth's, and only the Hadley edge and the levels' heights
follow the body.

Under warp the tropics are a texture turning rigidly, and nowhere does a
cloud form or dissipate in place. That is declared until phase 4.

Earth is drawn by the volume only when it is asked for, so phase 1's E1 to
E3 are the forced arm beside the deck, and say where the volume stands
rather than how Earth's clouds look.

### Levers it leaves

Each is a quality step or a measurement control (the rubric's §7).

| Lever                                            | Kind                | What it trades                                                                                                        |
| ------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `weather`: `'climate'` or a regime's id          | Measurement control | A held regime over the whole body, for a test or a cornerstone that wants one weather everywhere                      |
| `served`: a body by address                      | Measurement control | Draws the volume on a body outside the set, Earth among them, and serves nothing if the body is not in the scene      |
| A 16-bit cover in the cube and the clipmap       | Quality step        | Earth's climate through the cube from 2.6 × 10⁻² to about 6.7 × 10⁻³ at the p99, for about 11 MB                      |
| `MESOSCALE_GRADIENT` and `MESOSCALE_WAVELENGTHS` | Quality step        | Stand-ins with no observation behind them. A larger gradient breaks the tile harder and folds the noise past 1        |
| `κ`, `(2, 1, 0)`                                 | Quality step        | A stand-in: ISCCP-H's table counts cover, not convection                                                              |
| The Hadley edge's exponent, 1                    | Quality step        | Held and Hou's axisymmetric law; Kaspi and Showman's 2015 sweep is not transcribed. Moves only slow and fast rotators |
| `WEATHER_AXIAL_DRIFT`, 0.25 m/s                  | Quality step        | How fast a shape evolves away from the equator, against how fast the volume's and the sun's caches must follow it     |
