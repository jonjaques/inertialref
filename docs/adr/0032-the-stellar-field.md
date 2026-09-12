# ADR-0032: The stellar field is a versioned preview until population activation

Status: accepted · 5 Sep 2026; population-preview restriction and initial cache
configuration superseded by [ADR-0038](0038-the-stars-and-the-diffuse-sky.md).
The body below retains the M1–M6 model and its recorded measurements.

[ADR-0037](0037-the-enhanced-camera.md) governs the implemented Enhanced,
Automatic and Manual camera modes. Field calibration, transport, versioning
and physical-cache ownership remain in force. Response-specific M1–M6 images
and timing numbers below are recorded diagnostics, separate from acceptance
of the current Enhanced default.

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
`galaxy-field@4` manifest stays separate from active generation.**

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

Each population carries a mean Johnson V luminosity in solar V units and an
illustrative blackbody color. The integrator returns Johnson V nW m⁻² sr⁻¹;
green carries V radiance, while red and blue carry relative chromaticity after
wavelength-dependent absorption. Their sum is not a physical bolometric power.
The conversion uses the GAMBONS Vega/STIS003 zero radiance of 143.1685 W m⁻²
sr⁻¹ and Willmer's solar absolute V magnitude of 4.81. At ten parsecs those
values define the solar V wattage, which replaces the bolometric solar wattage
in `L_V / (4π PARSEC²) × 1e9`.

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
measured sensor bandpasses. The local correction below adds the named clouds
and Local Bubble.

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

## The local sky and linear calibration (M6)

Nine named cloud complexes derive from [Lallement et al. 2022's extinction
cube](https://cdsarc.cds.unistra.fr/ftp/J/A+A/661/A147/cube_ext.fits.gz).
`apps/ingest/src/galaxyReference.ts` selects explicit longitude, latitude and
distance windows, subtracts a 0.001 mag/pc background floor, and fits the excess
with diagonal Gaussian moments. The amplitude preserves the selected excess
volume integral; each record declares the resulting central column. These are
compact approximations to a published map, not published ellipsoid fits. The
12.5 pc minimum sigma follows half the map's 25 pc resolution. Smooth compact
tails span four to five sigma. All clouds contribute to the same extinction
sum; overlapping windows or a nearest-cloud ranking never select a field value.

The FITS header declares `A0(550nm)/parsec`, in magnitudes per parsec. Its actual
floating-point values must not be interpreted using the catalogue ReadMe's
nanomagnitude label. The grid uses 10 pc cells and half-index solar coordinates;
cell centers span −3,000…3,000 pc in the plane. Ingest records the source hash,
selection windows, centers, sigmas, amplitudes and columns in
`data/reference/galaxy.json`, and generates the runtime tables. Heliocentric
astronomy coordinates (+Z north) map to the existing simulation frame (+Y north,
Sun at −X); the center, pole and Aquila direction have regression checks.

[Zucker et al. 2022](https://doi.org/10.1038/s41586-021-04286-5) gives a present
shell **radius** of 165 ± 6 pc. Its quoted expansion center is in the LSR
14.4 Myr ago; treating those coordinates as a present heliocentric center would
be incorrect. The runtime deliberately approximates the irregular cavity with
a solar-centered sphere, a 25 pc transition on each side, and 20% residual smooth
dust. The residual agrees approximately with the Lallement solar cell, about
0.00017 mag/pc. Clouds add outside this smooth-disk reduction. Nearby emission
and residual extinction are integrated; no empty ten-parsec skip is valid.

`pnpm sim --galaxy-calibration --quiet` reports linear radiance and returns a
failing status when a photometric, count or normalization bound fails. The
same report is `ir.galaxy().calibration()`; `localDust()` exposes the source
records. [GAMBONS](https://doi.org/10.1093/mnras/staa4005)'s supplementary
`RadianceOut.csv` supplies equal-area HEALPix averages outside the atmosphere.
The reference includes integrated starlight, diffuse Galactic light and the
extragalactic background; the modeled component is integrated starlight only.
The 0.3 mag comparison is a broad astrophysical sky constraint, with that
component mismatch explicit in the report. It is not a measurement of the
stellar component in isolation. Scattering and extragalactic light are absent.

| Region           | Longitude | Absolute latitude | Reference V nW m⁻² sr⁻¹ |   Model | Residual mag |
| ---------------- | --------- | ----------------- | ----------------------: | ------: | -----------: |
| Mid-latitudes    | 0–360°    | 30–60°            |                  53.559 |  47.415 |       +0.132 |
| Polar caps       | 0–360°    | 60–90°            |                  41.862 |  33.727 |       +0.235 |
| Aquila sightline | 40–50°    | 0–5°              |                 176.410 | 214.315 |       −0.211 |

These values use the default session (`--seed inertialref`) and its derived
galaxy seed, 384 equal-solid-angle rays per region, and
the settled CPU quadrature. Increasing to 1,536 rays and a 10 pc maximum step
changes every region mean by less than 1%. The physical-GPU suite uses a directly seeded `rootSeed('inertialref')` field;
its rays agree with their corresponding CPU reference within 1% individually and 0.01 mag in the region averages. The approximate
photopic residuals are +0.108, +0.186 and −0.089 mag. All remain inside the
original 0.3 mag bound; there is no display response in the calculation.

[Licquia et al. 2015](https://arxiv.org/abs/1508.04446), Table 3, reports
`M_V − 5 log h = −20.74`; with the paper's `h = 0.7`, the target is
**M_V = −21.515**, not −21.37. The comparison integrates the emergent face-on
image, including absorption, to an isotropic-equivalent luminosity. The model's
3.220 × 10¹⁰ solar V luminosities give M_V = −21.460, a +0.055 mag residual.
A 96×96 grid changes the 48×48 result by less than 1%. Intrinsic emission is
5.078 × 10¹⁰ solar V luminosities; comparing that unattenuated sum to observed
photometry would fit the wrong quantity. The unchanged density model contains
116.107 billion stars on the report's 120×96×48 grid and 0.1 star/pc³ locally.

The fitted mean solar V luminosities are 0.214 (thin disk), 0.35 (thick disk),
10 (young arms), 0.748 (bar/bulge) and 0.1 (halo). With the thick-disk, young-arm and halo coefficients held fixed, the thin-disk
and bar/bulge coefficients are a joint fit to the three sky regions and external luminosity, rounded to
three decimals. These effective population means are model assumptions, not
independent stellar-luminosity-function measurements. Temperatures remain
illustrative. Neither the B−V color nor Freeman's B-band central disk brightness
is accepted as a V-band or total-bulge constraint.

The proposed 75 nW target in the plan is GAMBONS Table 4's ground-level annual
zenith average at geographic 40° N, including atmospheric contributions. It
cannot stand for a Galactic mid-latitude stellar sky. Table 3 does not supply
the plan's proposed generic 22.3–23.4 range either. The directly averaged
supplemental map replaces both targets without relaxing the tolerance.

M6 establishes physical V-band units, local dust and linear-light calibration.
Its fixed-exposure Direct plates are recorded integration diagnostics; they do
not establish the appearance of Enhanced, Automatic or Manual. Current camera
image acceptance remains open for preview review. Active generation and saved
addresses remain unchanged at this preview revision.

## The live galaxy instruments

`apps/game/src/render/galaxyKernel.ts` ports the same field and midpoint ray
integral to TSL. It imports the population and arm parameter records, uses the
CPU field's normalization, and derives the same young-arm seed. Its independent
`galaxy-tsl@5` revision identifies the port. Nonzero GPU field samples and whole
rays are held within 1% of the CPU reference, with absolute tolerances near zero,
at a zero pixel angle and at the live edge-on target's.
Explicit axial azimuths avoid Metal's fast `atan2` sign reversal at an exact
zero denominator; the warp and arms otherwise disagree at +Z.

The planetarium's Presets panel offers face-on and edge-on instruments.
`ir.galaxyView(view)` sets the existing observatory. While that fixed
instrument owns the view, the lens producer resolves its recipe under
cinematic precedence. Leaving the instrument releases that scope and restores
the player's lens; it does not rewrite a global lens or mode preference.
No canonical position or clock changes. Face-on is 30 kpc above the plane at
90° vertical FOV, f/2, 2,400 s, ISO 400. Edge-on is at +Z 40 kpc, 55°, f/2,
600 s, ISO 400. The explicit staging override pins photographic exposure to
that lens, independent of automatic metering. These are instantaneous previews
at a declared exposure, not accumulated photons over those durations.

The direct live target has one quarter of the drawing buffer's width and height,
rounded up. Each rgba16f texel stores V-anchored RGB divided by 1,000
nW m⁻² sr⁻¹. At the scene boundary RGB is normalized so its linear Rec.709
luminance equals the green V radiance. A fixed photopic/V ratio of 1.25 and
683 lm/W then convert to cd/m². The ratio is a declared spectral approximation:
the three source regions span 1.20–1.40. This conversion does not depend on
camera mode, exposure, or whether the galaxy is visible on screen.
The target feeds a background-depth surface through the scene's pre-exposure,
optics and response. Foreground geometry occludes it at full scene resolution.
Geometry masks the background integral; transport does not stop partway
through a ray at an object inside the stellar volume. Diffuse light between
the eye and that object is therefore omitted at its silhouette.

### Ordinary views and the physical sky cache

Flight, the homepage and the planetarium request diffuse sky in ordinary
Enhanced views. Eligibility does not depend on terrestrial daylight exposure.
Automatic and Manual use the same field and physical source light without
Enhanced's visibility gains; their exposure decides whether faint emission is
visible. Enhanced's declared sky compression happens at the scene boundary,
after reading retained physical radiance and before the scene's half-float
conversion. The cache stores no camera mode, exposure or display response.

The renderer owns a physical cube cache with 128-pixel faces and a 0.15 pc
reuse ceiling around each baked observer position. Rotation and lens changes
sample the same physical directions. Each tier owns three slots, retaining two
completed locations and one incomplete replacement. Work advances in 16-pixel
tiles. Only a complete six-face cube can publish; canceled generations cannot
publish into a slot reassigned to another observer or field. Renderer disposal
retires its targets, pending work and warm-up registration together.

A 32-pixel coarse tier supplies the first complete cube before the 128-pixel
tier finishes. With 16-pixel tiles, those publication boundaries require 24 and
384 tile submissions respectively. These are work counts, not measured frame
costs. A bounded live target supplies the cold or translated view until an
eligible cache publishes. Coarse-to-fine publication, cache/live identity,
translation transitions and full-frame cost remain under image and performance
verification; the counts alone do not establish their acceptance.

### Recorded M1–M6 live-target measurements

This subsection records the Natural/daylight and direct live-target baseline.
Its timings and image comparisons do not measure the ordinary Enhanced cache.

Ordinary Natural views omitted the diffuse volume when the resolved exposure
was terrestrial daylight or darker. Natural clamped the surface calibration
to the lens's exposure range, so the lens EV plus the bright range decided
eligibility. Brighter Natural exposures, metered responses, Direct and fixed
galaxy instruments retained the volume. The physical-GPU daylight comparison
included foreground PSF mixing and fixed sensor noise, stayed below one 8-bit
display code at the tested solar viewpoints with and without dust, and kept a
visible long-exposure control. This establishes the recorded Natural bound,
not an omission rule for Enhanced.

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

### Camera processing

Fixed instruments use physical resolved-star flux and the photographic sensor
PSF. Their explicit staging override bypasses Enhanced's integrated star
visibility and analytic solar treatment, whose local normalization cannot
serve a view 30 kpc away. Ordinary travel follows the player's selected mode;
Automatic and Manual receive no calibrated source gains. Cinematic scripts
can separately request declared calibrated-light staging under ADR-0037.

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
The engine publishes its sampled universe pose for eligible volume draws; a
component never advances the observatory a second time. Flight, the homepage
and the planetarium request the ordinary diffuse sky through their presentation
stances. Named galaxy instruments also enable it explicitly. Camera mode and
staging decide processing; entering a journey does not force a lens or exposure.

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

The GPU loop is capped at `GALAXY_MAX_STEPS`, 16,384 intervals. A fine
diagnostic ray long enough to reach that cap returns a partial integral, where
CPU integration has no cap at all — which is why the GPU convergence check is
deliberately a short 128 pc ray rather than a longer unbounded one, and why the
production probes are kept well below the limit.

The journey preserves the player's selected mode and lens. Automatic adapts
to the framed light on presentation time, Manual retains the chosen lens
exposure, and Enhanced applies its declared composition. Only a named fixed
instrument requests its recipe and photographic pin. The shared shutter
control and persistence guard admit exposures through 3,600 s. Long Manual
exposures can clip bright bodies while revealing the disk; neither the journey
nor a fixed instrument accumulates photons over the displayed duration.
Resolved-light subtraction remains later work; M6 measures the diffuse field
in linear light.

`ir.galaxy().render()` reports the galactocentric observer, orientation,
lens and effective exposure, field and kernel revisions, sampling profile,
journey state, target ownership, and local survey limits. The survey remains a
125-cell cube with one pending request and a 20,000-sprite ceiling. Its extent
is independent of the visible disk. The Presets panel's Milky Way section
provides Earth Orbit, Travel Out, Return, Hold, and a progress slider. A full
trip in either direction takes 36 seconds.

## Alternatives considered

**A panorama.** ESO's and Gaia's all-sky images are what every planetarium
uses, Stellarium included, and Gaia's is CC BY-NC besides. An image is a fixed
exposure of one viewpoint with the star halos baked into it: it cannot be flown
through, re-exposed, or made to agree with a foreground body's occlusion.

**A point cloud with no volume.** Sprites sampled from a template alias, carry
no dust, and saturate toward the center under additive blending — Gaia Sky's
Figure 17 is that failure. From inside, it is a cloud of billboards that Gaia
Sky had to dither-discard for occlusion until it added a volume anyway.

**A 3D texture of the field for the outside view.** 256³ RGBA half-float is
134 MB, and OpenSpace's 1024×1024×128 is the same idea larger. The analytic
field is cheap enough to evaluate per sample, and a texture would be a second
copy of the model to keep in step with the CPU reference. If a march ever
measures over budget, the fallback is a 256×256×64 slab at 17 MB sampling the
same kernel through a texture instead of a function.

**A density-wave particle galaxy.** A two-dimensional tilted-ellipse model has
no interior dust transport and no agreement with the catalog frame.

**Baking only the smooth part of the sky, at low resolution, to save memory.**
Emission behind dust and emission in front of it do not separate, so the
product of the integral is what has to be stored — at the dust's resolution,
not the smooth field's.

**Activate the field in `stellarDensity` immediately.** Rejected because
preview calibration would regenerate procedural systems and change saves
before magnitude completeness and population selection are ready.

**Use separate inside and outside emission models.** Rejected because an
observer moving out of the disk would cross between different amounts of
light. Only ray origins and projection differ between these plates.

**Treat all plan values as literal transcriptions.** Reid's unadjusted
quadrant-IV tangencies miss two of the selected median targets by more than
3°. Calibrating within the stated uncertainties keeps the acceptance bound;
changing the bound would conceal the mismatch. The bar and halo profiles remain model choices; M6 fits effective V luminosities
against the source conventions above.

## Consequences

The CPU reference is available without a browser, graphics library, worker,
or canonical mutation. A finer cylindrical quadrature gives 116.185 billion
stars, 0.067% above the default grid. This is a count inside the declared
reference cylinder; the small halo tail above its vertical bounds is omitted.

Population plates reveal faint structures without changing their physical
amplitudes to make a composite attractive. The same dust attenuates every
population and produces dark lanes in inside and outside views. V-band
radiance has explicit broad-region and external-light checks; RGB color and the
photopic conversion retain their spectral approximations. Enhanced image
acceptance, resolved-star extinction and population activation remain open.
The physical angular cache is implemented; its current publication quality
and full-frame cost require their own evidence.

The M1–M6 direct live-target baseline measured 0.17 ms a frame at 960×540 for
a held backdrop and 10.8 to 17 ms for a moving 240×135 target with filtered
dust. That moving baseline exceeds the plan's 2 ms target for 1080p and does
not establish the current cache's cost. `CONTEXT.md` and
[the performance plan](../../design/plans/perf.md#the-galaxy) record the
conditions and results. Three.js r185 also rebuilds one first-use integral
pipeline as its cached function ordering changes, then reuses it on
subsequent submissions.
