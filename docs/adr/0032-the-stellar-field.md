# ADR-0032: The stellar field is a versioned preview until population activation

Status: accepted · 5 Sep 2026

## Context

The active `stellarDensity` controls procedural system counts. Replacing its
exponential disk changes addresses outside the catalog even if no renderer
reads the result. The galaxy needs a measurable field for CPU and GPU work
before its populations and photometry are ready to become generation inputs.

A picture alone cannot establish the model's normalization. An attractive
spiral can contain the wrong number of stars, point its arms at the wrong
longitudes, or change its brightness between inside and outside views.

## Decision

**One seeded field supplies CPU references and a GPU preview; its
`galaxy-field@2` manifest stays separate from active generation.**

`createGalaxyField` accepts a galaxy seed and samples `UniverseVector`
positions. Internally the field uses parsec offsets in the galactic-center
frame, with +Y north and the Sun along −X. The seed controls a bounded,
stateless modulation of young-arm density. `LOCAL_DENSITY` supplies the common
normalization, and the five populations sum to exactly 0.1 star/pc³ at the Sun.
`stellarDensity`, `generateCell`, and `GENERATION_VERSIONS` retain their active
algorithms. Calibration changes spend a field version; activation also spends
the active galaxy version.

The parameter record distinguishes observations from preview assumptions:

| Structure            | Basis and implementation                                                                                                                                                                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thin and thick disks | Exponential lengths 2.6 and 2.0 kpc, heights 300 and 900 pc, following [Bland-Hawthorn & Gerhard 2016](https://arxiv.org/abs/1602.07702). Thick-disk amplitude is 4% of the unmodulated thin disk.                                                                                        |
| Arms                 | Kinked logarithmic curves from [Reid et al. 2019, Table 2](https://arxiv.org/pdf/1910.03357). Width is `max(140, 336 + 36 (R/kpc − 8.15))` pc; the Local arm uses 310 pc. The minimum width and finite arc tapers are model choices.                                                      |
| Tangencies           | Checked against the six medians in [Hou & Han 2014, Table 2](https://arxiv.org/pdf/1407.7331). Scutum's pre-kink pitch is 12.4° and Sagittarius's is 18.7°, each one published standard deviation from Reid's fit. The near-3kpc radius is 3.30 kpc, within its 3.52 ± 0.26 kpc interval. |
| Far side             | Norma joins Outer on the next winding through a cubic interpolation of log radius with matching slopes. Scutum extends around the center toward OSC. Finite endpoints and the unobserved join are explicit extrapolations.                                                                |
| Warp                 | [Chen et al. 2019, Table 1](https://arxiv.org/pdf/1902.00998), all-Cepheid power law: `60 max(0, R/kpc − 7.72)^1.33 sin(β − 17.5°)` pc. The formula begins at 7.72 kpc; 20 kpc is not its onset.                                                                                          |
| Bar/bulge            | A boxy planar exponential at 27°, scales 1.5 × 0.75 kpc, a 390 pc vertical exponential, and a smooth 5 kpc radial taper. These are preview profile choices, not a reconstruction of the published mass model.                                                                             |
| Halo                 | A softened spheroid with 1 kpc core, flattening 0.6 and outer exponent −3.5. Its amplitude and core are preview assumptions. A globular cluster catalog is a separate population.                                                                                                         |

The young population has a 19 pc exponential height, with 20% old-star arm
modulation. Every contributing arm adds smoothly; field values never come
from the identity of the nearest arm. Width projection blends with smoothstep
from 1° before to 1° after each pitch kink; selecting the two pitches with a
hard branch made off-ridge density jump despite a continuous centerline. This
regularization is an explicit profile choice and spends preview version 2.
The measured centerlines and their tangencies stay intact. The disk tapers
from 26 to 30 kpc.

Each population carries a mean bolometric luminosity and blackbody color
assumption. Density times mean luminosity gives L☉/pc³. The ray integrator
returns bolometric nW m⁻² sr⁻¹ using
`3.828e26 / (4π PARSEC²) × 1e9` per L☉/pc². Its RGB channels partition that
power according to normalized blackbody RGB. They are illustrative color
channels, not measured bandpasses or a luminance calibration. There is no dust or
resolved-star subtraction, and no claim of M6 photometric accuracy. The live
preview below feeds these illustrative channels through the existing sensor.

`ir.galaxy()` derives an inspector from the current session. Samples expose
both manifests and the normalization. Count quadrature covers the cylinder of
radius 30 kpc and half-height 10 kpc. Rays use the same field within that
reference domain, with midpoint intervals shortened near the warped plane to
resolve the thin young population. The integrator is additive over populations.

`pnpm sim --galaxy-plates <directory>` writes outside and observer-centered
plates, isolated young-arm, bar/bulge and halo plates, raw little-endian
float64 RGB arrays, and a JSON report. Every PNG uses the same declared asinh
stretch and sRGB encoding; raw files precede that display transform. Repeated
fixed-seed plates agree exactly. Small numeric plate references also detect
unversioned changes between revisions.

## The live galaxy instruments

`apps/game/src/render/galaxyKernel.ts` ports the same field and midpoint ray
integral to TSL. It imports the population and arm parameter records, uses the
CPU field's normalization, and derives the same young-arm seed. Its independent
`galaxy-tsl@2` revision identifies the port. Nonzero GPU field samples and whole
rays are held within 1% of the CPU reference, with absolute tolerances near zero.
Explicit axial azimuths avoid Metal's fast `atan2` sign reversal at an exact
zero denominator; the warp and arms otherwise disagree at +Z.

The planetarium's Presets panel offers face-on and edge-on instruments.
`ir.galaxyView(view)` sets the existing observatory and requests its lens through
the existing host port. The camera remains cinematic → observatory → ship;
no canonical position or clock changes. Face-on is 30 kpc above the plane at
90° vertical FOV, f/2, 2,400 s, ISO 400. Edge-on is at +Z 40 kpc, 55°, f/2,
600 s, ISO 400. Exposure is pinned to the instrument, independent of automatic
metering. These are instantaneous previews at a declared exposure, not a
simulation accumulating photons over those durations.

The live target has one quarter of the drawing buffer's width and height,
rounded up. Each rgba16f texel stores RGB in units of 1,000 bolometric
nW m⁻² sr⁻¹. A declared preview efficacy of 100 lm/W converts these channels
at the scene boundary; it is an assumption pending M6, not a measured bandpass.
The target feeds a background-depth surface through the scene's pre-exposure,
optics and response. Foreground geometry occludes it at full scene resolution.
Geometry masks the background integral; transport does not stop partway
through a ray at an object inside the stellar volume. Diffuse light between
the eye and that object is therefore omitted at its silhouette.

The render node updates once per scene submission, including repeated sensor
submissions without an animation tick. There is no history. Its effect owns
the target, material, backdrop and warm-up registration; resize changes the
same target, cleanup retires the same instance, and a late warm-up cannot
revive it. Diagnostics report dimensions, bytes, versions and submission count.

The fixed instruments and the Earth-to-disk journey use physical resolved-star flux and the sensor PSF.
Natural's relative-brightness star ramp and analytic solar glare are bypassed
while this camera owns the frame: their local-scene normalization otherwise
puts a bright Sun over the disk even from 30 kpc away. Ordinary views and
cinematic staging keep their existing behavior.

## Earth to the disk (M4)

`ir.galaxyJourney(progress, seconds)` holds or travels between Earth orbit and
30 kpc above the galactic center. Zero progress is 64,000 km above Earth;
one is the outside endpoint. The route derives an orbit direction from the
Earth-to-endpoint displacement and keeps looking toward Earth throughout.
The existing observatory interpolates distance logarithmically, easing progress
over presentation time. A frozen world's state hash is unchanged by the whole
outward and return trip. Reversal starts at the displayed progress, and direct
orbit or distance gestures stop automatic travel.

The ordinary camera ceiling is 110,000 ly. The centered endpoint is about
101,400 ly from Earth, so a literal 100,000 ly cap clips the journey. Positions
remain sector coordinates, and target positions resolve at `renderTime`.
The engine publishes its sampled universe pose for the volume; a component
never advances the observatory a second time. The planetarium requests the
volume through its presentation stance. The homepage's decorative observatory
does not request it. Named galaxy instruments also enable it explicitly.

The live quadrature uses the CPU integrator's `observer` sampling profile.
Its steps are bounded by the warped-plane rule, 100 pc, and `1 pc + 0.1 t`,
where `t` is distance from the observer. An interior ray resolves nearby light;
a ray entering the volume after an empty approach already permits coarse
intervals. The CPU `reference` profile retains its plate quadrature. The field
and active population versions stay unchanged because only integration changes.

The journey enters with the face-on lens and keeps exposure pinned to the
resolved lens in Direct, Neutral, and Natural. The shared shutter control and
persistence guard admit exposures through 3,600 s, so the 2,400 s instrument
reaches the panel and survives a new preference binding. A person may change that lens
through the existing camera controls. The long exposure can clip a bright body
while revealing the disk; the instrument does not separately expose the galaxy
or accumulate photons over its stated shutter duration. Photometric calibration
and resolved-light subtraction remain later work.

`ir.galaxy().render()` reports the galactocentric observer, orientation,
lens and effective exposure, field and kernel revisions, sampling profile,
journey state, target ownership, and local survey limits. The survey remains a
125-cell cube with one pending request and a 20,000-sprite ceiling. Its extent
is independent of the visible disk. The Presets panel's Milky Way section
provides Earth Orbit, Travel Out, Return, Hold, and a progress slider. A full
trip in either direction takes 36 seconds.

## Alternatives considered

**Activate the field in `stellarDensity` immediately.** Rejected because
preview calibration would regenerate procedural systems and change saves
before magnitude completeness and population selection are ready.

**Use separate inside and outside emission models.** Rejected because an
observer moving out of the disk would cross between different amounts of
light. Only ray origins and projection differ between these plates.

**Treat all plan values as literal transcriptions.** Reid's unadjusted
quadrant-IV tangencies miss two of the selected median targets by more than
3°. Calibrating within the stated uncertainties keeps the acceptance bound;
changing the bound would conceal the mismatch. The bar, halo and luminosity
assumptions remain identified as model choices requiring later calibration.

## Consequences

The CPU reference is available without a browser, graphics library, worker,
or canonical mutation. A finer cylindrical quadrature gives 116.185 billion
stars, 0.067% above the default grid. This is a count inside the declared
reference cylinder; the small halo tail above its vertical bounds is omitted.

Population plates reveal faint structures without changing their physical
amplitudes to make a composite attractive. They also make the missing dust
plain: the observer plate has no dark lanes. The preview's RGB and population
weights require calibration before a physical sensor or population generator
can adopt them as calibrated quantities. The live volume now exposes those
limitations through the actual sensor; dust and temporal reuse remain later
milestones. The initial quarter-size volume costs more than
the 2 ms target on the measured rig; `CONTEXT.md` records the batch conditions
and results. Three.js r185 also rebuilds one first-use integral pipeline as
its cached function ordering changes, then reuses it on subsequent submissions.
