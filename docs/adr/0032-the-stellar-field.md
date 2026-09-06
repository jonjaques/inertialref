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
`galaxy-field@3` manifest stays separate from active generation.**

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
channels, not measured bandpasses or a luminance calibration. Dust attenuates
these channels before sensor conversion. Resolved-star subtraction and M6
photometric accuracy remain open. The live
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

## Dust transport (M5)

The same field supplies emission and extinction at every viewpoint. Dust has
81 and 152 pc exponential heights, using the mean values from
[Guo et al. 2025](https://arxiv.org/abs/2509.14669) over the measured 6–12 kpc
radial bins. The 2.26 kpc radial length comes from Drimmel & Spergel 2001,
as identified in [Guo's introduction](https://academic.oup.com/mnras/article/543/2/1574/8258955).
Combining these profiles across the whole disk is a preview model choice.

The immutable `GALAXY_DUST` record declares the remaining assumptions. The
vertical weights are 0.65 and 0.35. Dust lanes lie 200 pc inward of each stellar
ridge, use half its width, and add with contrast two. They share the stellar
warp, arc tapers, and 26–30 kpc rim. The untextured, lane-modulated solar
midplane is normalized to one V magnitude per kiloparsec, or
`ln(10)/2500` optical depth per parsec. Four seeded noise bands at 64, 16,
4, and 1 pc modulate log density with amplitudes 0.8, 0.4, 0.2, and 0.1.
Their seed derives from `galaxy-field:dust`, independently of young-star texture.
Effective wavelengths of 650, 550, and 450 nm give extinction ratios
`550/650`, one, and `550/450`. These illustrative RGB coefficients are not
measured sensor bandpasses. Named clouds and the Local Bubble belong to M6.

For each interval, the integrator samples emission `j` and extinction `k` at
its midpoint. With length `h`, optical depth `q = k h`, and incoming
transmittance `T`, it adds `T j h (1-exp(-q))/q` and then multiplies `T` by
`exp(-q)`, independently in each channel. A cubic Taylor expansion below
`q = 0.01` preserves the zero-dust limit in float32. This solves a homogeneous
emitting and absorbing interval exactly; using the final transmittance to
attenuate the whole ray also dims foreground emitters and is incorrect.
Population rays remain additive under common dust. Intrinsic stellar columns
remain unattenuated diagnostics.

`createGalaxyField(seed, { dustScale: 0 })` supplies the dust-free control.
CPU rays return optical depth and transmittance as well as emergent radiance.
The GPU shares the stellar and dust arm centerline calculations. It may discard
further RGB contributions once all channels transmit less than `1e-12`.
The omitted light is bounded by that fraction of the unextinguished source;
stellar columns and the separate GPU transmittance diagnostic retain the full
path. Extinction of resolved star sprites remains M10, so the current sprites
can appear too bright against a dark diffuse lane.

A ray asked for by a pixel carries the pixel's angle. `GalaxyRayOptions.pixelAngle`
and the kernel's matching input are zero by default and for every canonical
caller, which integrates the exact field along the pixel's center. Given an
angle, the footprint at each sample is the angle times the distance, and each
noise band is weighted by what that footprint resolves — all of it within one
lattice cell, none beyond two, linear between — with the unresolved remainder
replaced by the band's lattice mean. The mean is not one: the exponential is
convex, so dropping a band would thin every lane by 2.4% at the 0.8 band and
3.1% over four. `exp(a²σ²/2)` with the noise variance measured at 0.0729
reproduces the mean of `exp(a·n)` over the lattice to five decimals at every
amplitude, and the blend puts the weight squared on the mean term so the mean
holds at every weight. The observer and settled intervals are also floored at
half the footprint; the plane-crossing law is never floored, because a ray
through the 19 pc young disk still has to resolve the crossing or where its
one midpoint lands decides the pixel. Measured over a strip of seventeen
edge-on texels at a 240×135 target, the filtered radiance sums to 0.994 of the
exact center rays' in the plane and 0.997 above it, and the settled sample
count falls 3.2×. Filtering density under a convex transport underestimates
the mean transmission slightly; that 0.6% is the named cost.

## The live galaxy instruments

`apps/game/src/render/galaxyKernel.ts` ports the same field and midpoint ray
integral to TSL. It imports the population and arm parameter records, uses the
CPU field's normalization, and derives the same young-arm seed. Its independent
`galaxy-tsl@4` revision identifies the port. Nonzero GPU field samples and whole
rays are held within 1% of the CPU reference, with absolute tolerances near zero,
at a zero pixel angle and at the live edge-on target's.
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

The render node draws when the view, the field or the target's size changes —
at once, with the observer profile — and once more with the settled profile
after eight unchanged scene submissions, then holds its target. The same pose,
field and size draw the same texels, so a held target is the frame; redrawing
it every submission cost the whole integral for a picture that was not
changing, which at a stationary edge-on view was a GPU saturated at four
frames a second. Measured headlessly on an Apple M5 before the hold, at a
480×270 target: 113 ms a draw face-on, 246 edge-on, 165 and 237 at two
interior points. With the hold, in the browser at 960×540, the held backdrop
adds 0.17 ms to a 4.7 ms frame; a view switch is one observer draw and one
settled draw on the ninth frame; the last third of the Earth-to-disk journey,
where the observer crosses 0.01 pc a frame, is one draw a frame at a 240×135
target with the frame period held at vsync. Sub-threshold drift — 0.01 pc,
0.1 mrad of rotation or of field — updates nothing, which is the same
stationary-instrument rule the settling policy already makes. The pixel angle
the kernel filters against is the vertical field over the target's rows. There
is no history and no reprojection. The effect owns the target, material,
backdrop and warm-up registration; resize changes the same target, cleanup
retires the same instance, and a late warm-up cannot revive it. Diagnostics
report dimensions, bytes, versions, the pixel angle, and three counters:
submissions asked in, draws made, and whether the last submission held.

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
intervals. The CPU `reference` profile retains its explicit midpoint quadrature. The
live `settled` profile additionally caps intervals at
`max(10 pc, 0.1 × absolute warped height)`, retaining the 100 pc maximum and
observer-neighborhood rule. It reaches the finer profile after eight unchanged
scene submissions. Translation beyond 0.01 pc, rotation beyond 0.0001 rad,
or an equivalent FOV change resets travel quality. Motion is measured against
the last reset pose, so small movements accumulate; ordinary local orbital
drift does not prevent a settled frame. This changes sampling, never the dust
field. Uniform ten-parsec marching through long halo paths can produce zero
GPU output on the measured rig, so fine intervals are concentrated around the
dust plane. CPU convergence checks retain the complete quarter-parsec reference. Sampling profiles describe quadrature; the field manifest identifies the
stellar and dust coefficients independently of active population generation.

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
amplitudes to make a composite attractive. The same dust attenuates every
population and produces dark lanes in inside and outside views. The preview's RGB and population
weights require calibration before a physical sensor or population generator
can adopt them as calibrated quantities. The live volume now exposes those
limitations through the actual sensor. Photometric calibration, resolved-star
extinction, and temporal reuse remain later milestones. A held view costs the
backdrop's composite, 0.17 ms a frame at 960×540; a moving one costs a draw a
frame, 10.8 to 17 ms at a 240×135 target with the dust filtered, which is
still above the 2 ms target the plan sets for 1080p. `CONTEXT.md` and
[the performance plan](../../design/plans/perf.md#the-galaxy) record the
conditions and results. Three.js r185 also rebuilds one first-use integral
pipeline as its cached function ordering changes, then reuses it on
subsequent submissions.
